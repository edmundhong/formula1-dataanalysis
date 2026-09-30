"""Owner-only, expiring diagnostic endpoint. Never publishes data."""
from http.server import BaseHTTPRequestHandler
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def authorize(headers):
    try:
        expires = float(os.getenv("F1_PROBE_EXPIRES_AT", "0"))
    except ValueError:
        return 404
    if (os.getenv("VERCEL_ENV") != "preview"
            or os.getenv("F1_PROBE_ENABLED") != "1"
            or not expires > time.time()):
        return 404
    token = os.getenv("F1_PROBE_TOKEN", "")
    if len(token) < 32 or not hmac.compare_digest(headers.get("Authorization", ""), "Bearer " + token):
        return 401
    return 200


def validate(body):
    if not isinstance(body, dict) or set(body) != {"session_id", "mode"}:
        raise ValueError("Expected session_id and mode")
    if not isinstance(body["session_id"], str) or not re.fullmatch(r"20\d{2}-\d{2}-(FP[123]|Q|SQ|S|R)", body["session_id"]):
        raise ValueError("Invalid session")
    if int(body["session_id"][:4]) < 2026 or body["mode"] not in ("source", "full"):
        raise ValueError("Invalid mode or season")
    return body


def run_probe(body):
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="f1-probe-") as folder:
        # Separate process gives each request fresh caches and a killable deadline.
        env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ("TOKEN", "SECRET", "KEY", "INGEST", "SUPABASE"))}
        env.update(MPLCONFIGDIR=folder, XDG_CACHE_HOME=folder,
                   PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
        if os.getenv("F1_PROBE_PUBLISH_URL"):
            env["F1_PROBE_PUBLISH_URL"] = os.environ["F1_PROBE_PUBLISH_URL"]
            env["F1_PROBE_PUBLISH_TOKEN"] = os.getenv("F1_PROBE_PUBLISH_TOKEN", "")
        command = [sys.executable, "-m", "pipeline.probe", body["session_id"], body["mode"], folder]
        process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            process.wait(timeout=270)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            return {"failure_category": "resource_exhaustion", "reason": "controlled_timeout", "elapsed_seconds": round(time.monotonic() - started, 3)}
        result = Path(folder, "summary.json")
        if not result.exists():
            return {"failure_category": "resource_exhaustion" if process.returncode in (-9, 137) else "worker_failure", "exit_code": process.returncode}
        summary = json.loads(result.read_text())
        summary["elapsed_seconds"] = round(time.monotonic() - started, 3)
        summary["duration_headroom_pass"] = summary["elapsed_seconds"] <= 225
        # Linux RUSAGE_CHILDREN covers the worker; /proc adds the function parent.
        parent_mb = None
        try:
            for line in Path("/proc/self/status").read_text().splitlines():
                if line.startswith("VmHWM:"):
                    parent_mb = int(line.split()[1]) / 1024
        except OSError:
            pass
        summary["parent_peak_memory_mb"] = parent_mb
        worker_mb = summary.get("peak_memory_mb")
        summary["memory_headroom_pass"] = (worker_mb + parent_mb <= 1536) if worker_mb is not None and parent_mb is not None else None
        print(json.dumps(summary), flush=True)
        return summary


class handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never log request headers, bodies, or query strings.

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.reply(405, {"error": "method_not_allowed"})

    def do_POST(self):
        status = authorize(self.headers)
        if status != 200:
            return self.reply(status, {"error": "disabled" if status == 404 else "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024:
                return self.reply(400, {"error": "invalid_body"})
            body = validate(json.loads(self.rfile.read(length)))
        except (ValueError, TypeError):
            return self.reply(400, {"error": "invalid_body"})
        self.reply(200, run_probe(body))

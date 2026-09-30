"""Bounded Vercel queue consumer. The child does analysis; only the parent publishes."""
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen


def rpc(name, payload=None):
    url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/" + name
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    request = Request(url, json.dumps(payload or {}).encode(), {
        "Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key,
    })
    with urlopen(request, timeout=10) as response:
        return json.load(response)


def authorized(headers):
    token = os.getenv("F1_WORKER_TOKEN", "")
    return (os.getenv("F1_WORKER_ENABLED") == "1" and len(token) >= 32
            and hmac.compare_digest(headers.get("Authorization", ""), "Bearer " + token))


def publish(job, artifact):
    request = Request(os.environ["F1_INGEST_URL"], json.dumps({
        "action": "publish", "session_id": job["session"]["id"],
        "lease_token": job["lease_token"], **artifact,
    }, allow_nan=False).encode(), {
        "Content-Type": "application/json", "x-ingest-token": os.environ["F1_INGEST_TOKEN"],
    })
    with urlopen(request, timeout=25) as response:
        return json.load(response)


def run_job():
    job = rpc("claim_analysis")
    if not job:
        return {"state": "idle"}
    identity = {"p_session": job["session"]["id"], "p_lease": job["lease_token"]}
    category = "worker_failure"
    try:
        with tempfile.TemporaryDirectory(prefix="f1-worker-") as folder:
            Path(folder, "session.json").write_text(json.dumps(job["session"]), encoding="utf-8")
            # Credentials never enter the analysis process or its output.
            env = {k: v for k, v in os.environ.items() if k.upper() in
                   ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR")}
            env.update(MPLCONFIGDIR=folder, XDG_CACHE_HOME=folder,
                       PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
            process = subprocess.Popen([sys.executable, "-m", "pipeline.worker", folder],
                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 210
            try:
                while process.poll() is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        category = "resource_exhaustion"
                        raise TimeoutError()
                    try:
                        process.wait(timeout=min(20, remaining))
                    except subprocess.TimeoutExpired:
                        if not rpc("heartbeat_analysis", identity):
                            raise RuntimeError("Lease lost")
                if process.returncode:
                    category = "resource_exhaustion" if process.returncode in (-9, 137) else "worker_failure"
                    failure = Path(folder, "failure.json")
                    if failure.exists():
                        reported = json.loads(failure.read_text(encoding="utf-8")).get("error_code")
                        if reported in ("source_unavailable", "resource_exhaustion", "worker_failure"):
                            category = reported
                    raise RuntimeError("Analysis failed")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            if not rpc("heartbeat_analysis", identity):
                raise RuntimeError("Lease lost")
            category = "publication_failed"
            artifact = json.loads(Path(folder, "artifact.json").read_text(encoding="utf-8"))
            publish(job, artifact)
            return {"state": "succeeded"}
    except Exception:
        # No exception text, response bodies or credentials are logged or returned.
        rpc("fail_analysis", {**identity, "p_error": category})
        return {"state": "retry", "error_code": category}


def analyze(folder):
    import hashlib
    import fastf1
    from .ingest import prepare
    from .scheduler import correction_stage
    folder = Path(folder)
    cache = folder / "cache"
    cache.mkdir()
    fastf1.Cache.enable_cache(str(cache))
    meta = json.loads((folder / "session.json").read_text(encoding="utf-8"))
    artifact = prepare(meta, refresh=True)
    canonical = {k: v for k, v in artifact.items() if k != "generated_at"}
    version = hashlib.sha256(json.dumps(canonical, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()[:20]
    (folder / "artifact.json").write_text(json.dumps({"artifact": artifact, "version": version,
        "correction_stage": correction_stage(meta)}, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        analyze(sys.argv[1])
    except Exception as exc:
        category = "worker_failure"
        if isinstance(exc, MemoryError):
            category = "resource_exhaustion"
        elif type(exc).__name__ in ("DataNotLoadedError", "SessionNotAvailableError", "HTTPError", "ConnectionError", "Timeout", "ReadTimeout") or str(exc) in ("Lap timing is not available yet", "Session completion has not been confirmed"):
            category = "source_unavailable"
        Path(sys.argv[1], "failure.json").write_text(json.dumps({"error_code": category}), encoding="utf-8")
        raise SystemExit(1)

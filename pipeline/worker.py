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


def publish(job, artifact, action="publish", timeout=25):
    request = Request(os.environ["F1_INGEST_URL"], json.dumps({
        "action": action, "session_id": job["session"]["id"],
        "lease_token": job["lease_token"], **artifact,
    }, allow_nan=False).encode(), {
        "Content-Type": "application/json", "x-ingest-token": os.environ["F1_INGEST_TOKEN"],
    })
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def run_job():
    function_deadline = time.monotonic() + 285
    job = rpc("claim_analysis", {"p_openf1": os.getenv("F1_OPENF1_ENABLED") == "1"})
    if not job:
        if os.getenv("F1_OPENF1_ENABLED") == "1":
            from .checkpoints import cleanup
            cleanup(rpc)
        return {"state": "idle"}
    if job.get("provider") == "OpenF1":
        return run_openf1(job, function_deadline)
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
            # Keep publication within the Vercel function's 300-second ceiling.
            publication_deadline = function_deadline
            for chunk in artifact["artifact"].get("telemetry_manifest", {}).get("chunks", []):
                if time.monotonic() + 25 >= publication_deadline or not rpc("heartbeat_analysis", identity):
                    raise RuntimeError("Publication deadline or lease lost")
                publish(job, {"version": artifact["version"], "file": chunk["file"], "sha256": chunk["sha256"],
                    "chunk_json": Path(folder, chunk["file"]).read_text(encoding="utf-8")}, action="telemetry", timeout=min(25, max(1, publication_deadline - time.monotonic())))
            if time.monotonic() >= publication_deadline or not rpc("heartbeat_analysis", identity):
                raise RuntimeError("Publication deadline or lease lost")
            publish(job, artifact, timeout=min(25, max(1, publication_deadline - time.monotonic())))
            return {"state": "succeeded"}
    except Exception:
        # No exception text, response bodies or credentials are logged or returned.
        rpc("fail_analysis", {**identity, "p_error": category})
        return {"state": "retry", "error_code": category}


def run_openf1(job, function_deadline):
    from . import checkpoints
    from .openf1 import read_json, write_json
    identity = {"p_session": job["session"]["id"], "p_lease": job["lease_token"]}
    category = "worker_failure"
    try:
        checkpoints.cleanup(rpc)
        with tempfile.TemporaryDirectory(prefix="f1-openf1-") as folder:
            if job.get("checkpoint"):
                checkpoints.restore(job["checkpoint"], folder)
            write_json(Path(folder, "session.json"), job["session"])
            env = {k: v for k, v in os.environ.items() if k.upper() in
                   ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR")}
            env.update(MPLCONFIGDIR=folder, XDG_CACHE_HOME=folder,
                       PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
            # The parent reserves time to archive state and upload dependencies.
            process = subprocess.Popen([sys.executable, "-m", "pipeline.worker", folder, "openf1"],
                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = min(time.monotonic() + 210, function_deadline - 60)
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
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            if not rpc("heartbeat_analysis", identity):
                raise RuntimeError("Lease lost")
            diagnostic = read_json(Path(folder, "diagnostics.json"), {})
            if diagnostic:
                print(json.dumps({"session": job["session"]["id"], "diagnostics": diagnostic}), flush=True)
            if process.returncode == 75:
                checkpoints.save(job, folder, rpc)
                return {"state": "queued", "progress": read_json(Path(folder, "state.json"), {}).get("progress")}
            if process.returncode:
                reported = read_json(Path(folder, "failure.json"), {}).get("error_code")
                category = reported if reported in ("source_unavailable", "resource_exhaustion", "worker_failure") else "worker_failure"
                raise RuntimeError("OpenF1 analysis failed")
            category = "publication_failed"
            artifact = read_json(Path(folder, "artifact.json"))
            # A durable full-output checkpoint precedes public uploads. Receipts
            # survive a crash between a successful upload and the next checkpoint.
            release = time.monotonic() + 90 >= function_deadline
            checkpoints.save(job, folder, rpc, release=release)
            if release:
                return {"state": "queued"}
            uploaded = rpc("verified_analysis_files", {**identity, "p_version": artifact["version"]}) or []
            chunks = artifact["artifact"].get("telemetry_manifest", {}).get("chunks", [])
            for chunk in chunks:
                if chunk["file"] in uploaded:
                    continue
                if time.monotonic() + 65 >= function_deadline:
                    checkpoints.save(job, folder, rpc)
                    return {"state": "queued"}
                if not rpc("heartbeat_analysis", identity):
                    raise RuntimeError("Lease lost")
                publish(job, {"version": artifact["version"], "file": chunk["file"], "sha256": chunk["sha256"],
                              "chunk_json": Path(folder, chunk["file"]).read_text(encoding="utf-8")}, action="telemetry")
                uploaded.append(chunk["file"])
                write_json(Path(folder, "uploaded.json"), uploaded)
            if time.monotonic() + 65 >= function_deadline:
                checkpoints.save(job, folder, rpc)
                return {"state": "queued"}
            if not rpc("heartbeat_analysis", identity):
                raise RuntimeError("Lease lost")
            publish(job, artifact)
            # Checkpoint garbage is cleaned independently of successful publication.
            return {"state": "succeeded"}
    except Exception:
        rpc("fail_analysis", {**identity, "p_error": category})
        return {"state": "retry", "error_code": category}


def analyze(folder, provider="FastF1"):
    if provider == "OpenF1":
        from .openf1 import prepare, write_json
        from .scheduler import correction_stage
        from .telemetry import version_artifact
        folder = Path(folder)
        meta = json.loads((folder / "session.json").read_text(encoding="utf-8"))
        artifact = prepare(meta, folder, time.monotonic() + 185)
        if not (folder / "artifact.json").exists():
            version = version_artifact(artifact, folder)
            write_json(folder / "artifact.json", {"artifact": artifact, "version": version, "correction_stage": correction_stage(meta)})
        return
    import fastf1
    from .ingest import prepare
    from .scheduler import correction_stage
    from .telemetry import version_artifact
    folder = Path(folder)
    cache = folder / "cache"
    cache.mkdir()
    fastf1.Cache.enable_cache(str(cache))
    meta = json.loads((folder / "session.json").read_text(encoding="utf-8"))
    artifact = prepare(meta, refresh=True, telemetry_dir=folder)
    version = version_artifact(artifact, folder)
    (folder / "artifact.json").write_text(json.dumps({"artifact": artifact, "version": version,
        "correction_stage": correction_stage(meta)}, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        analyze(sys.argv[1], "OpenF1" if len(sys.argv) > 2 and sys.argv[2] == "openf1" else "FastF1")
    except Exception as exc:
        if type(exc).__name__ == "YieldWork":
            raise SystemExit(75)
        category = "worker_failure"
        if isinstance(exc, MemoryError):
            category = "resource_exhaustion"
        elif type(exc).__name__ in ("SourceUnavailable", "DataNotLoadedError", "SessionNotAvailableError", "HTTPError", "ConnectionError", "Timeout", "ReadTimeout") or str(exc) in ("Lap timing is not available yet", "Session completion has not been confirmed"):
            category = "source_unavailable"
        Path(sys.argv[1], "failure.json").write_text(json.dumps({"error_code": category}), encoding="utf-8")
        raise SystemExit(1)

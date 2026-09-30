"""Isolated diagnostics reusing the production preparer, without publishing."""
import json
import hashlib
import os
from pathlib import Path
import sys
import time


def classify(checks):
    if not checks:
        return "source_discovery_failure"
    files = {c["file"] for c in checks}
    if all(any(c["file"] == name and c["status"] == 200 for c in checks) for name in files):
        return None
    if any(c["status"] in (401, 403, 429) for c in checks):
        return "upstream_refusal"
    if any(c["status"] == 404 for c in checks):
        return "missing_source_data"
    return "upstream_network"


def main():
    session_id, mode, folder = sys.argv[1:]
    started = time.monotonic()
    result = {"session_id": session_id, "mode": mode, "failure_category": None, "upstream": []}
    stage = "source"
    try:
        import fastf1
        import requests
        from pipeline.ingest import prepare
        from pipeline.analysis import fastest_laps
        fastf1.Cache.enable_cache(folder)
        year, rnd, code = session_id.split("-")
        session = fastf1.get_session(int(year), int(rnd), code)
        result["fastf1_version"] = fastf1.__version__
        result["source_path"] = session.api_path
        for host in ("https://livetiming.formula1.com", "https://livetiming-mirror.fastf1.dev"):
            for name in ("SessionInfo.json", "SessionStatus.jsonStream", "TimingData.jsonStream"):
                check = {"host": host, "file": name, "status": None}
                try:
                    with requests.get(host + session.api_path + name, timeout=(5, 15), stream=True, allow_redirects=False) as response:
                        check["status"] = response.status_code
                except requests.RequestException as exc:
                    check["error_type"] = type(exc).__name__
                result["upstream"].append(check)
        result["failure_category"] = classify(result["upstream"])
        if mode == "full" and not result["failure_category"]:
            stage = "analysis"
            artifact = prepare({"year": int(year), "round": int(rnd), "code": code, "id": session_id})
            payload = json.dumps(artifact, allow_nan=False, separators=(",", ":")).encode()
            result.update(lap_count=len(artifact["laps"]), driver_count=len(artifact["drivers"]), trace_count=len(artifact["traces"]),
                          payload_bytes=len(payload), payload_size_pass=len(payload) <= 12 * 1024 * 1024,
                          rankings=[{"driver": lap["driver"], "time": lap["time"]} for lap in fastest_laps(artifact["laps"])],
                          telemetry_drivers=sorted({trace["driver"] for trace in artifact["traces"]}), unavailable=artifact["unavailable"])
            publish_url = os.getenv("F1_PROBE_PUBLISH_URL")
            if publish_url:
                stage = "publication"
                # No caller-supplied URLs and no path to the production publisher.
                if publish_url != "https://hmdiksuzmfwormmmpwkm.supabase.co/functions/v1/ingest-probe-20260928":
                    raise ValueError("Isolated publisher required")
                from pipeline.ingest import request
                os.environ["F1_INGEST_URL"] = publish_url
                os.environ["F1_INGEST_TOKEN"] = os.environ["F1_PROBE_PUBLISH_TOKEN"]
                canonical = {k: v for k, v in artifact.items() if k != "generated_at"}
                version = hashlib.sha256(json.dumps(canonical, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()[:20]
                published = request("publish", session_id=session_id, version=version, artifact=artifact, correction_stage=0)
                result["publication"] = {"version": published["version"], "bytes": published["bytes"], "destination": "isolated_probe"}
    except MemoryError:
        result["failure_category"] = "resource_exhaustion"
    except Exception as exc:
        result.update(failure_category={"analysis": "parsing_failure", "publication": "publication_failure"}.get(stage, "source_discovery_failure"), error_type=type(exc).__name__)
        if isinstance(exc, ModuleNotFoundError):
            result["missing_module"] = exc.name
    finally:
        try:
            import resource
            result["peak_memory_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2)
        except ImportError:
            result["peak_memory_mb"] = None
        result["worker_seconds"] = round(time.monotonic() - started, 3)
        Path(folder, "summary.json").write_text(json.dumps(result))


if __name__ == "__main__":
    main()

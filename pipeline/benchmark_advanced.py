"""Locally reprocess representative sessions and measure telemetry costs; no publishing."""
import argparse
import json
import logging
from pathlib import Path
import time
import fastf1
from .ingest import prepare
from .telemetry import encode, version_artifact


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sessions", nargs="+", help="e.g. 2026-15-FP2 2026-01-Q 2026-01-R")
    parser.add_argument("--offline", action="store_true", help="Use only previously cached FastF1 data")
    parser.add_argument("--output", default=".local/advanced-benchmark")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    fastf1.Cache.enable_cache("fastf1_cache")
    fastf1.Cache.offline_mode(args.offline)
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    metrics = []
    for session_id in args.sessions:
        year, rnd, code = session_id.split("-")
        if int(year) != 2026 or code not in ("FP1", "FP2", "FP3", "Q", "SQ", "R", "S"):
            raise ValueError("Invalid 2026 session")
        started = time.monotonic()
        folder = root / f"{session_id}-telemetry"
        artifact = prepare({"year": int(year), "round": int(rnd), "code": code, "id": session_id}, telemetry_dir=folder)
        version = version_artifact(artifact, folder)
        payload = encode(artifact)
        (root / f"{session_id}.json").write_bytes(payload)
        manifest = artifact["telemetry_manifest"]
        metric = {"session": session_id, "version": version, "elapsed_seconds": round(time.monotonic() - started, 2),
            "laps": len(artifact["laps"]), "chunks": len(manifest["chunks"]), "artifact_bytes": len(payload),
            "telemetry_bytes": sum(c["bytes"] for c in manifest["chunks"]),
            "max_chunk_bytes": max((c["bytes"] for c in manifest["chunks"]), default=0),
            "unavailable_laps": sum(l["chunk"] is None for l in manifest["laps"])}
        metrics.append(metric)
        print(json.dumps(metric), flush=True)
    (root / "metrics.json").write_bytes(encode(metrics))


if __name__ == "__main__":
    main()

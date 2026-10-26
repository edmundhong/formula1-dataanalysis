"""Read-only local acceptance runner; never publishes or loads publisher secrets."""
import argparse
import json
import logging
from pathlib import Path
import time

from .openf1 import prepare, read_json, write_json, YieldWork
from .telemetry import version_artifact


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--location", required=True)
    parser.add_argument("--starts-at", required=True)
    parser.add_argument("--folder", required=True)
    parser.add_argument("--slices", type=int, default=1)
    args = parser.parse_args()
    year, rnd, code = args.session.split("-")
    meta = {"id": args.session, "year": int(year), "round": int(rnd), "code": code,
            "location": args.location, "starts_at": args.starts_at}
    folder = Path(args.folder)
    logging.basicConfig(level=logging.INFO)
    for _ in range(args.slices):
        try:
            artifact = prepare(meta, folder, time.monotonic() + 185)
            if not (folder / "artifact.json").exists():
                version = version_artifact(artifact, folder)
                write_json(folder / "artifact.json", {"artifact": artifact, "version": version, "correction_stage": 0})
            from .checkpoints import pack
            print(json.dumps({"session": args.session, "laps": len(artifact["laps"]), "drivers": len(artifact["drivers"]),
                              "traces": len(artifact["traces"]), "chunks": len(artifact["telemetry_manifest"]["chunks"]),
                              "checkpoint_bytes": len(pack(folder)), "warnings": artifact["unavailable"]}), flush=True)
            return
        except YieldWork:
            print(json.dumps({"session": args.session, "yield": read_json(folder / "state.json")}), flush=True)
    raise SystemExit(75)


if __name__ == "__main__":
    main()

"""Bounded immutable telemetry files; never embed all laps in the session artifact."""
import hashlib
import json
from pathlib import Path

MAX_CHUNK_BYTES = 4 * 1024 * 1024


def encode(value):
    return json.dumps(value, allow_nan=False, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class TelemetryWriter:
    def __init__(self, folder, session_id, max_bytes=MAX_CHUNK_BYTES):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.session_id = session_id
        self.max_bytes = max_bytes
        self.pending = []
        self.pending_laps = []
        self.chunks = []
        self.laps = []
        self.size = len(encode(self.payload([])))

    def payload(self, traces):
        return {"schema_version": 1, "session_id": self.session_id, "traces": traces}

    def add(self, lap, trace, reason=None):
        entry = {"driver": lap["driver"], "lap": lap["number"], "chunk": None, "reason": reason}
        self.laps.append(entry)
        if trace is None:
            entry["reason"] = reason or "Source telemetry unavailable."
            return
        trace = {**trace, "driver": lap["driver"], "lap": lap["number"], "phase": lap["phase"], "lap_time": lap["time"]}
        encoded_size = len(encode(trace))
        if encoded_size + len(encode(self.payload([]))) > self.max_bytes:
            entry["reason"] = "Telemetry exceeds the per-file size limit."
            return
        if self.pending and self.size + encoded_size + 1 > self.max_bytes:
            self.flush()
        self.size += encoded_size + bool(self.pending)
        self.pending.append(trace)
        self.pending_laps.append(entry)

    def flush(self):
        if not self.pending:
            return
        name = f"telemetry-{len(self.chunks):04d}.json"
        data = encode(self.payload(self.pending))
        if len(data) > self.max_bytes:
            raise ValueError("Telemetry file exceeds limit")
        (self.folder / name).write_bytes(data)
        self.chunks.append({"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        for entry in self.pending_laps:
            entry["chunk"] = name
        self.pending, self.pending_laps = [], []
        self.size = len(encode(self.payload([])))

    def finish(self):
        self.flush()
        return {"chunks": self.chunks, "laps": self.laps}


def version_artifact(artifact, folder):
    """Hash the canonical manifest, then bind every file to that immutable version."""
    canonical = {k: v for k, v in artifact.items() if k != "generated_at"}
    version = hashlib.sha256(json.dumps(canonical, sort_keys=True, allow_nan=False, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()[:20]
    manifest = artifact.get("telemetry_manifest")
    if manifest:
        for chunk in manifest["chunks"]:
            name = chunk["file"]
            chunk["file"] = f"{version}.{name}"
            (Path(folder) / name).replace(Path(folder) / chunk["file"])
        for entry in manifest["laps"]:
            if entry["chunk"]:
                entry["chunk"] = f"{version}.{entry['chunk']}"
    return version

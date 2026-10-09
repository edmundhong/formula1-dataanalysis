import hashlib
import json
from pipeline.telemetry import TelemetryWriter, version_artifact


def test_chunks_are_bounded_indexed_and_versioned(tmp_path):
    writer = TelemetryWriter(tmp_path, "2026-01-Q", max_bytes=350)
    for number in range(1, 6):
        writer.add({"driver": "AAA", "number": number, "phase": "Q1", "time": 90}, {"time": [0.0, 90.0], "reliable": True})
    writer.add({"driver": "BBB", "number": 1}, None, "No timing")
    manifest = writer.finish()
    artifact = {"session_id": "2026-01-Q", "generated_at": "now", "telemetry_manifest": manifest}
    version = version_artifact(artifact, tmp_path)
    assert len(manifest["chunks"]) > 1
    assert manifest["laps"][-1]["reason"] == "No timing"
    for chunk in manifest["chunks"]:
        assert chunk["file"].startswith(version + ".")
        raw = (tmp_path / chunk["file"]).read_bytes()
        assert len(raw) == chunk["bytes"] <= 350
        assert hashlib.sha256(raw).hexdigest() == chunk["sha256"]
        value = json.loads(raw)
        assert value["session_id"] == "2026-01-Q"
        indexed = [l for l in manifest["laps"] if l["chunk"] == chunk["file"]]
        assert [l["lap"] for l in indexed] == [t["lap"] for t in value["traces"]]


def test_oversized_single_trace_is_explicitly_unavailable(tmp_path):
    writer = TelemetryWriter(tmp_path, "2026-01-Q", max_bytes=200)
    writer.add({"driver": "AAA", "number": 1, "phase": "Q1", "time": 90}, {"speed": list(range(1000))})
    manifest = writer.finish()
    assert manifest["chunks"] == []
    assert "size limit" in manifest["laps"][0]["reason"]


def test_timestamp_does_not_change_version(tmp_path):
    assert version_artifact({"generated_at": "a", "laps": [1]}, tmp_path) == version_artifact({"generated_at": "b", "laps": [1]}, tmp_path)

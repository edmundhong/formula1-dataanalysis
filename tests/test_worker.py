import os
import subprocess
from unittest.mock import MagicMock, patch
from pipeline.worker import authorized, run_job
from contextlib import nullcontext
import json


def test_worker_auth_is_disabled_by_default_and_checks_token():
    with patch.dict(os.environ, {"F1_WORKER_TOKEN": "x" * 32}, clear=True):
        assert not authorized({"Authorization": "Bearer " + "x" * 32})
        os.environ["F1_WORKER_ENABLED"] = "1"
        assert authorized({"Authorization": "Bearer " + "x" * 32})
        assert not authorized({"Authorization": "Bearer wrong"})


def test_empty_queue_does_not_start_process():
    with patch("pipeline.worker.rpc", return_value=None), patch("pipeline.worker.subprocess.Popen") as spawn:
        assert run_job() == {"state": "idle"}
        spawn.assert_not_called()


def test_timeout_kills_child_and_records_safe_failure():
    process = MagicMock()
    process.poll.return_value = None
    job = {"session": {"id": "2026-12-R"}, "lease_token": "lease"}
    with patch("pipeline.worker.rpc", side_effect=[job, True]) as rpc, \
         patch("pipeline.worker.subprocess.Popen", return_value=process), \
         patch("pipeline.worker.time.monotonic", side_effect=[0, 0, 211]), \
         patch("pipeline.worker.publish") as publish:
        assert run_job()["error_code"] == "resource_exhaustion"
        process.kill.assert_called_once()
        publish.assert_not_called()
        assert rpc.call_args.args[1]["p_error"] == "resource_exhaustion"


def test_lost_heartbeat_stops_child_and_never_publishes():
    process = MagicMock()
    process.poll.return_value = None
    process.wait.side_effect = [subprocess.TimeoutExpired("worker", 20), None]
    job = {"session": {"id": "2026-12-R"}, "lease_token": "lease"}
    with patch("pipeline.worker.rpc", side_effect=[job, False, False]), \
         patch("pipeline.worker.subprocess.Popen", return_value=process), \
         patch("pipeline.worker.publish") as publish:
        run_job()
        process.kill.assert_called_once()
        publish.assert_not_called()


def publication_fixture(tmp_path):
    file = "a" * 20 + ".telemetry-0000.json"
    (tmp_path / file).write_text('{"schema_version":1}', encoding="utf-8")
    (tmp_path / "artifact.json").write_text(json.dumps({"version": "a" * 20, "artifact": {"telemetry_manifest": {"chunks": [{"file": file, "sha256": "a" * 64}]}}}), encoding="utf-8")
    process = MagicMock()
    process.poll.return_value = 0
    process.returncode = 0
    return process


def test_chunk_upload_failure_never_publishes_manifest(tmp_path):
    process = publication_fixture(tmp_path)
    job = {"session": {"id": "2026-01-Q"}, "lease_token": "lease"}
    with patch("pipeline.worker.rpc", side_effect=[job, True, True, True]) as rpc, \
         patch("pipeline.worker.tempfile.TemporaryDirectory", return_value=nullcontext(str(tmp_path))), \
         patch("pipeline.worker.subprocess.Popen", return_value=process), \
         patch("pipeline.worker.publish", side_effect=RuntimeError("Upload failed")) as publish:
        assert run_job()["error_code"] == "publication_failed"
        assert publish.call_count == 1
        assert publish.call_args.kwargs["action"] == "telemetry"
        assert rpc.call_args.args[0] == "fail_analysis"


def test_all_chunks_precede_manifest_publication(tmp_path):
    process = publication_fixture(tmp_path)
    job = {"session": {"id": "2026-01-Q"}, "lease_token": "lease"}
    with patch("pipeline.worker.rpc", side_effect=[job, True, True, True]), \
         patch("pipeline.worker.tempfile.TemporaryDirectory", return_value=nullcontext(str(tmp_path))), \
         patch("pipeline.worker.subprocess.Popen", return_value=process), \
         patch("pipeline.worker.publish") as publish:
        assert run_job() == {"state": "succeeded"}
        assert publish.call_count == 2
        assert publish.call_args_list[0].kwargs["action"] == "telemetry"
        assert "action" not in publish.call_args_list[1].kwargs


def test_openf1_yield_saves_checkpoint_without_recording_failure(tmp_path):
    process = MagicMock()
    process.poll.return_value = 75
    process.returncode = 75
    job = {"provider": "OpenF1", "session": {"id": "2026-18-Q"}, "lease_token": "lease"}
    with patch("pipeline.worker.rpc", return_value=True) as rpc, \
         patch("pipeline.worker.subprocess.Popen", return_value=process), \
         patch("pipeline.worker.tempfile.TemporaryDirectory", return_value=nullcontext(str(tmp_path))), \
         patch("pipeline.checkpoints.cleanup"), patch("pipeline.checkpoints.save") as save, \
         patch("pipeline.worker.publish") as publish:
        from pipeline.worker import run_openf1
        assert run_openf1(job, 10**20)["state"] == "queued"
        save.assert_called_once()
        publish.assert_not_called()
        assert not any(c.args[0] == "fail_analysis" for c in rpc.call_args_list)


def test_openf1_receipts_resume_publication_and_checkpoint_precedes_pointer(tmp_path):
    process = publication_fixture(tmp_path)
    job = {"provider": "OpenF1", "session": {"id": "2026-18-Q"}, "lease_token": "lease"}
    calls = []
    def rpc(name, payload=None):
        if name == "verified_analysis_files":
            return ["a" * 20 + ".telemetry-0000.json"]
        return True
    with patch("pipeline.worker.rpc", side_effect=rpc), \
         patch("pipeline.worker.subprocess.Popen", return_value=process), \
         patch("pipeline.worker.tempfile.TemporaryDirectory", return_value=nullcontext(str(tmp_path))), \
         patch("pipeline.checkpoints.cleanup"), \
         patch("pipeline.checkpoints.save", side_effect=lambda *a, **k: calls.append("checkpoint")), \
         patch("pipeline.worker.publish", side_effect=lambda *a, **k: calls.append("publish")) as publish:
        from pipeline.worker import run_openf1
        assert run_openf1(job, 10**20)["state"] == "succeeded"
        assert calls == ["checkpoint", "publish"]
        publish.assert_called_once()  # Already verified chunks are not re-uploaded.

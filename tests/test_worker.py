import os
import subprocess
from unittest.mock import MagicMock, patch
from pipeline.worker import authorized, run_job


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
         patch("pipeline.worker.time.monotonic", side_effect=[0, 211]), \
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

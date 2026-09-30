import time
from unittest.mock import patch
import pytest
from experiments.vercel_probe.handler import authorize, validate, run_probe
from pipeline.probe import classify


def test_probe_disabled_by_default_and_in_production():
    with patch.dict("os.environ", {}, clear=True):
        assert authorize({}) == 404
    with patch.dict("os.environ", {"VERCEL_ENV": "production", "F1_PROBE_ENABLED": "1"}):
        assert authorize({}) == 404


def test_owner_auth_and_expiry():
    token = "a" * 64
    with patch.dict("os.environ", {"VERCEL_ENV": "preview", "F1_PROBE_ENABLED": "1", "F1_PROBE_EXPIRES_AT": str(time.time() + 60), "F1_PROBE_TOKEN": token}):
        assert authorize({}) == 401
        assert authorize({"Authorization": "Bearer wrong"}) == 401
        assert authorize({"Authorization": "Bearer " + token}) == 200
        with patch.dict("os.environ", {"F1_PROBE_EXPIRES_AT": "0"}):
            assert authorize({"Authorization": "Bearer " + token}) == 404
        for invalid in ("invalid", "nan"):
            with patch.dict("os.environ", {"F1_PROBE_EXPIRES_AT": invalid}):
                assert authorize({"Authorization": "Bearer " + token}) == 404


@pytest.mark.parametrize("body", [None, {}, {"session_id": "../../etc", "mode": "full"}, {"session_id": "2026-12-R", "mode": "publish"}, {"session_id": "2025-01-Q", "mode": "source"}])
def test_invalid_inputs(body):
    with pytest.raises(ValueError):
        validate(body)


def test_source_gate():
    assert classify([]) == "source_discovery_failure"
    assert classify([{"file": "timing", "status": 403}, {"file": "timing", "status": 404}]) == "upstream_refusal"
    assert classify([{"file": "timing", "status": 404}]) == "missing_source_data"
    assert classify([{"file": "timing", "status": 403}, {"file": "timing", "status": 200}]) is None


def test_controlled_timeout_kills_worker():
    import subprocess
    with patch("subprocess.Popen") as spawn:
        spawn.return_value.wait.side_effect = [subprocess.TimeoutExpired("probe", 270), 0]
        result = run_probe({"session_id": "2026-12-R", "mode": "full"})
        assert result["reason"] == "controlled_timeout"
        spawn.return_value.kill.assert_called_once()

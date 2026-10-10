from unittest.mock import patch
from datetime import datetime, timezone
import pandas as pd
import pytest
from pipeline.ingest import discover, request, prepare
from pipeline.scheduler import due


def test_calendar_handles_sprint_and_excludes_testing():
    frame=pd.DataFrame([{"RoundNumber":0,"EventName":"Testing"},{"RoundNumber":1,"EventName":"Sample GP","Country":"Sample","Location":"Circuit","Session1":"Practice 1","Session1DateUtc":pd.Timestamp("2026-03-01T10:00:00"),"Session2":"Sprint Qualifying","Session2DateUtc":pd.Timestamp("2026-03-01T14:00:00"),"Session3":"Sprint","Session3DateUtc":pd.Timestamp("2026-03-02T10:00:00")}])
    with patch("pipeline.ingest.fastf1.get_event_schedule",return_value=frame):
        rows=discover(2026)
    assert [r["code"] for r in rows]==["FP1","SQ","S"]
    assert all(r["starts_at"].endswith("+00:00") for r in rows)


def test_empty_calendar_cannot_cancel_everything():
    with patch("pipeline.ingest.fastf1.get_event_schedule",return_value=pd.DataFrame()):
        with pytest.raises(RuntimeError,match="empty calendar"):
            discover(2026)


def test_completed_sprint_can_be_ingested():
    assert due({"year":2026,"code":"S","status":"waiting","starts_at":"2026-03-01T10:00:00Z","artifact_path":None},datetime(2026,3,1,12,tzinfo=timezone.utc))


@pytest.mark.parametrize("finish", [pd.Timedelta(seconds=123.456789), pd.NaT])
def test_prepare_serializes_session_finish_timestamp(finish):
    import json
    from types import SimpleNamespace
    from unittest.mock import Mock
    raw = pd.DataFrame([dict(Driver="AAA", LapNumber=1, LapTime=pd.NaT, Time=finish,
        Stint=1, Compound="SOFT", TyreLife=1, FreshTyre=True, Position=1,
        Deleted=False, IsAccurate=False, TrackStatus="1", PitInTime=pd.NaT, PitOutTime=pd.NaT)])
    session = SimpleNamespace(api_path="/test/", load=Mock(), laps=raw,
        session_status=pd.DataFrame([{"Status": "Finished"}]), results=pd.DataFrame(),
        weather_data=pd.DataFrame(), get_circuit_info=Mock(return_value=None))
    with patch("pipeline.ingest.fastf1.get_session", return_value=session):
        artifact = prepare({"year": 2026, "round": 1, "code": "R", "id": "2026-01-R"})
    decoded = json.loads(json.dumps(artifact, allow_nan=False))
    assert decoded["schema_version"] == 1
    assert decoded["laps"][0]["end_time"] == (None if pd.isna(finish) else 123.456789)

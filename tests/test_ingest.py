from unittest.mock import patch
from datetime import datetime, timezone
import pandas as pd
import pytest
from pipeline.ingest import discover, request
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

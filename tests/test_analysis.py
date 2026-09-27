from datetime import datetime, timedelta, timezone
import numpy as np
from pipeline.analysis import fastest_laps, mark_clean_laps, pit_durations, resample_trace
from pipeline.scheduler import due, correction_stage


def lap(driver="AAA", number=2, time=90., **kwargs):
    return {"driver": driver, "number": number, "time": time, "deleted": False,
            "accurate": True, "track_status": "1", "pit_in": None, "pit_out": None,
            "stint": 1, "phase": "Q1", "compound": "SOFT", **kwargs}


def test_fastest_order_and_phases():
    laps = [lap("AAA", time=95), lap("BBB", time=90), lap("AAA", time=89, deleted=True),
            lap("CCC", time=None), lap("AAA", time=88, phase="Q3")]
    assert [l["driver"] for l in fastest_laps(laps)] == ["AAA", "BBB"]
    assert [l["driver"] for l in fastest_laps(laps, "Q1")] == ["BBB", "AAA"]
    assert fastest_laps(laps, "Q2") == []


def test_pace_exclusions_and_wet_stint():
    laps = [lap(number=2), lap(number=3,time=91), lap(number=4,time=120),
            lap(number=1), lap(number=5,pit_in=500), lap(number=6,pit_out=530),
            lap(number=7,track_status="14"), lap(number=8,deleted=True), lap(number=9,accurate=False),
            lap(number=10,time=110,stint=2,compound="INTERMEDIATE"),
            lap(number=11,time=111,stint=2,compound="INTERMEDIATE")]
    marked = mark_clean_laps(laps)
    assert [l["number"] for l in marked if l["clean"]] == [2,3,10,11]


def test_pits_never_pair_between_drivers_and_reject_garage_time():
    laps = [lap("AAA",pit_in=100),lap("BBB",pit_out=125),lap("AAA",number=3,pit_out=122),
            lap("BBB",number=4,pit_in=300),lap("BBB",number=5,pit_out=1000)]
    assert pit_durations(laps) == [{"driver":"AAA","lap":2,"duration":22}]


def test_resampling_unequal_spacing_and_missing_coverage():
    t = np.linspace(0,90,451)
    d = (t/90)**1.1 * 5000
    result = resample_trace(d,t,{"speed":np.ones(len(t))*200},90,[30,30,30])
    assert result["reliable"] and len(result["time"]) == 1000
    assert result["time"][0] == 0 and result["time"][-1] == 90
    keep = (t<35) | (t>42)
    missing = resample_trace(d[keep],t[keep],{"speed":np.ones(sum(keep))*200},90,[30,30,30])
    assert not missing["reliable"]
    assert any(v is None for v in missing["time"])
    wrong = resample_trace(d,t,{"speed":np.ones(len(t))*200},92,[30,30,32])
    assert not wrong["reliable"]


NOW=datetime(2026,9,20,12,tzinfo=timezone.utc)
def session(**kwargs):
    return {"year":2026,"code":"R","starts_at":(NOW-timedelta(hours=5)).isoformat(),"status":"waiting","artifact_path":None,**kwargs}


def test_retry_schedule_corrections_and_bounds():
    assert due(session(),NOW)
    assert not due(session(last_checked_at=(NOW-timedelta(minutes=20)).isoformat()),NOW)
    assert not due(session(starts_at=NOW.isoformat()),NOW,force=True)
    assert not due(session(status="cancelled"),NOW,force=True)
    assert not due(session(year=2025),NOW,force=True)
    assert due(session(year=2027),NOW)  # Fixed 2026 floor, no hardcoded upper season.
    published=session(artifact_path="one.json",starts_at=(NOW-timedelta(days=2)).isoformat(),correction_stage=0)
    assert due(published,NOW) and correction_stage(published,NOW)==1
    published["correction_stage"]=1
    assert not due(published,NOW)
    assert due(published,NOW+timedelta(days=7))
    published["correction_stage"]=2
    assert not due(published,NOW+timedelta(days=7))
    assert due(session(starts_at=(NOW-timedelta(days=100)).isoformat()),NOW)

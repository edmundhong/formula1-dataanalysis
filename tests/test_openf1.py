from copy import deepcopy
from datetime import datetime, timezone
import io
import json
import tarfile
import time
from unittest.mock import Mock, patch

import numpy as np
import pytest

from pipeline.analysis import fastest_laps
from pipeline.checkpoints import pack, unpack
from pipeline.openf1 import (Client, SourceUnavailable, YieldWork, iso, make_trace,
                             match_session, normalize, prepare, read_json, stamp, track_status, write_json)


def fixture():
    source = {"year": 2026, "session_key": 11392, "meeting_key": 1297,
              "location": "Austin", "session_name": "Qualifying",
              "date_start": "2026-10-24T21:00:00Z", "date_end": "2026-10-24T22:00:00Z"}
    meta = {"id": "2026-18-Q", "year": 2026, "location": "Austin", "code": "Q", "starts_at": source["date_start"]}
    origin = stamp(source["date_start"])
    data = {name: [] for name in ("drivers", "laps", "race_control", "stints", "pit", "position", "weather", "session_result")}
    data["drivers"] = [{"driver_number": 16, "name_acronym": "LEC", "team_name": "Ferrari", "team_colour": "ff0000"}]
    data["race_control"] = [{"date": iso(origin), "flag": "GREEN", "scope": "Track", "message": "GREEN LIGHT"},
                             {"date": iso(origin), "message": "SESSION STARTED", "qualifying_phase": 1},
                             {"date": iso(origin + 85), "message": "SESSION FINISHED", "qualifying_phase": 1},
                             {"date": iso(origin + 500), "message": "SESSION STARTED", "qualifying_phase": 2}]
    data["laps"] = [{"driver_number": 16, "lap_number": n, "date_start": iso(origin + t),
                     "lap_duration": duration, "duration_sector_1": duration / 3, "duration_sector_2": duration / 3,
                     "duration_sector_3": duration / 3, "is_pit_out_lap": False} for n, t, duration in ((1, 10, 90), (2, 100, 96), (3, 510, 87))]
    data["laps"].append({"driver_number": 16, "lap_number": 4, "date_start": iso(origin + 600),
                         "lap_duration": None, "is_pit_out_lap": False})
    data["stints"] = [{"driver_number": 16, "stint_number": 1, "lap_start": 1, "lap_end": 3, "compound": "SOFT", "tyre_age_at_start": 0}]
    data["session_result"] = [{"driver_number": 16, "position": 1, "duration": [90, 87, None]}]
    data["position"] = [{"driver_number": 16, "date": iso(origin), "position": 1}]
    return meta, source, data


def test_mapping_uses_location_code_utc_and_rejects_ambiguity():
    meta, source, _ = fixture()
    source["date_start"] = "2026-10-25T05:00:00+08:00"
    miami = {**source, "location": "Miami Gardens"}
    assert match_session(meta, [miami, source])["session_key"] == 11392
    with pytest.raises(SourceUnavailable):
        match_session(meta, [source, deepcopy(source)])
    with pytest.raises(SourceUnavailable):
        match_session(meta, [{**source, "is_cancelled": True}])
    with pytest.raises(SourceUnavailable):
        match_session(meta, [{**source, "date_start": "2026-10-26T21:00:00Z"}])
    meta["code"] = "SQ"
    assert match_session(meta, [{**source, "session_name": "Sprint Shootout"}])


def test_normalize_phase_boundaries_tyres_and_finish_line_times():
    meta, source, data = fixture()
    result = normalize(meta, source, data)
    assert result["session_id"] == meta["id"]
    assert result["phases"] == ["ALL", "Q1", "Q2"]
    assert [l["phase"] for l in result["laps"]] == ["Q1", "Q1", "Q2", "Q2"]
    assert result["laps"][0]["end_time"] == 100
    assert result["laps"][1]["tyre_age"] == 2
    assert result["drivers"][0]["position"] == 1
    assert fastest_laps(result["laps"])[0]["time"] == 87


def test_deleted_and_reinstated_laps_and_official_best_mismatch():
    meta, source, data = fixture()
    origin = stamp(source["date_start"])
    deletion = {"date": iso(origin + 900), "message": "CAR 16 (LEC) TIME 1:27.000 DELETED - TRACK LIMITS LAP 3"}
    data["race_control"].append(deletion)
    result = normalize(meta, source, data)
    assert result["laps"][2]["deleted"]
    assert "validity_unverified" in result["laps"][2]["quality"]["issues"]
    data["race_control"].append({**deletion, "date": iso(origin + 901), "message": deletion["message"].replace("DELETED", "REINSTATED")})
    result = normalize(meta, source, data)
    assert not result["laps"][2]["deleted"]
    assert "validity_unverified" not in result["laps"][2]["quality"]["issues"]
    data["session_result"][0]["duration"][1] = 86
    assert all(l["phase"] != "Q2" for l in fastest_laps(normalize(meta, source, data)["laps"], "Q2"))


def test_unknown_track_and_missing_sectors_do_not_claim_clean_data():
    meta, source, data = fixture()
    data["race_control"] = []
    data["laps"][1]["duration_sector_2"] = None
    result = normalize(meta, source, data)
    assert not any(l["clean"] for l in result["laps"])
    assert result["laps"][1]["time"] == 96
    assert "timing_unverified" in result["laps"][1]["quality"]["issues"]
    assert "track_unverified" in result["laps"][0]["quality"]["issues"]


def test_pits_use_lane_duration_not_stationary_stop_and_exclude_garage():
    meta, source, data = fixture()
    meta["code"] = "R"
    data["pit"] = [{"driver_number": 16, "lap_number": 1, "date": iso(stamp(source["date_start"]) + 105), "lane_duration": 25, "stop_duration": 2},
                   {"driver_number": 16, "lap_number": 2, "date": iso(stamp(source["date_start"]) + 500), "lane_duration": 400, "stop_duration": 3}]
    result = normalize(meta, source, data)
    assert result["pit_stops"] == [{"driver": "LEC", "lap": 1, "duration": 25}]
    assert result["laps"][0]["quality"]["pit_in"]


def test_sector_green_does_not_clear_different_yellow_or_safety_car():
    rc = [{"date": iso(0), "flag": "GREEN", "scope": "Track"},
          {"date": iso(1), "flag": "YELLOW", "scope": "Sector", "sector": 1},
          {"date": iso(2), "flag": "GREEN", "scope": "Sector", "sector": 2}]
    assert track_status(rc, 3, 10) == "2"
    rc.append({"date": iso(4), "message": "SAFETY CAR DEPLOYED"})
    rc.append({"date": iso(5), "flag": "GREEN", "scope": "Sector", "sector": 1})
    assert track_status(rc, 6, 10) == "2"


def telemetry():
    car = [{"date": iso(t), "speed": 180, "throttle": 100, "brake": 100 if t >= 45 else 0, "n_gear": 6 if t >= 45 else 5, "rpm": 10000} for t in np.arange(-.2, 90.3, .2)]
    location = [{"date": iso(t), "x": t * 30, "y": t * 20} for t in np.arange(-.1, 90.4, .3)]
    return {"time": 90, "sectors": [30, 30, 30]}, {"date_start": iso(0)}, car, location


def test_telemetry_aligns_timestamps_integrates_speed_and_preserves_steps():
    trace = make_trace(*telemetry())
    assert trace["reliable"]
    assert trace["distance"][-1] == pytest.approx(4500)
    assert len(trace["time"]) == 1000
    assert set(trace["brake"]) == {0, 1}
    assert set(trace["gear"]) == {5, 6}
    lap, raw, car, location = telemetry()
    car = [r for r in car if not 30 < stamp(r["date"]) < 35]
    trace = make_trace(lap, raw, car, location)
    assert not trace["reliable"] and None in trace["time"]
    assert not make_trace(lap, raw, car, [])["reliable"]
    assert make_trace(lap, raw, car[5:], location) is None


def test_position_gaps_do_not_invalidate_timing():
    lap, raw, car, location = telemetry()
    trace = make_trace(lap, raw, car, [])
    assert trace["reliable"]
    assert all(x is None for x in trace["x"])
    lap["quality"] = {"issues": ["validity_unverified"]}
    assert not make_trace(lap, raw, car, location)["reliable"]


def test_rate_limit_persists_cooldown_and_yields_without_failure(tmp_path):
    transport = Mock()
    transport.get.return_value.status_code = 429
    transport.get.return_value.headers = {"Retry-After": "120"}
    client = Client(tmp_path, time.monotonic() + 180, transport)
    with pytest.raises(YieldWork):
        client.get("laps", session_key=11392)
    assert client.state["cooldown_until"] > time.time() + 110
    resumed = Client(tmp_path, time.monotonic() + 60, transport)
    with pytest.raises(YieldWork):
        resumed.get("laps", session_key=11392)
    assert transport.get.call_count == 1


def test_empty_telemetry_is_a_gap_but_http_errors_are_not_hidden(tmp_path):
    transport = Mock()
    response = transport.get.return_value
    response.status_code = 404
    response.json.return_value = {"detail": "No results found."}
    assert Client(tmp_path, time.monotonic() + 180, transport).get("car_data", session_key=11392) == []
    response.status_code = 401
    with pytest.raises(SourceUnavailable):
        Client(tmp_path, time.monotonic() + 180, transport).get("laps", session_key=11392)


def test_checkpoints_roundtrip_and_reject_path_traversal(tmp_path):
    (tmp_path / "state.json").write_text('{"requests":4}')
    (tmp_path / "secret.env").write_text("must not enter checkpoint")
    payload = pack(tmp_path)
    target = tmp_path / "restore"
    target.mkdir()
    unpack(payload, target)
    assert json.loads((target / "state.json").read_text())["requests"] == 4
    assert not (target / "secret.env").exists()
    bad = io.BytesIO()
    with tarfile.open(fileobj=bad, mode="w:gz") as archive:
        member = tarfile.TarInfo("../escape.json")
        member.size = 2
        archive.addfile(member, io.BytesIO(b"{}"))
    with pytest.raises(ValueError):
        unpack(bad.getvalue(), target)


def test_completed_checkpoint_omits_duplicate_caches_but_keeps_publication(tmp_path):
    chunk = "a" * 20 + ".telemetry-0000.json"
    names = ["state.json", "meta-laps.json", "driver-16.json",
             "window-16-0-car_data.json", "telemetry-0000.json", chunk]
    for name in names:
        (tmp_path / name).write_text("{}")
    with tarfile.open(fileobj=io.BytesIO(pack(tmp_path)), mode="r:gz") as archive:
        assert set(archive.getnames()) == set(names)
    (tmp_path / "artifact.json").write_text("{}")
    target = tmp_path / "restore"
    target.mkdir()
    unpack(pack(tmp_path), target)
    assert {p.name for p in target.iterdir()} == {"state.json", "meta-laps.json", "artifact.json", chunk}
    assert (tmp_path / "driver-16.json").exists()  # Packing does not mutate live state.


def test_prepare_resumes_and_late_validity_change_invalidates_staged_output(tmp_path):
    meta, source, data = fixture()
    data["race_control"].append({"date": iso(stamp(source["date_start"]) + 700), "message": "SESSION FINISHED", "qualifying_phase": 2})
    yielded = False
    def get(_self, endpoint, **params):
        nonlocal yielded
        if endpoint == "sessions":
            return [source]
        if endpoint in ("car_data", "location"):
            if not yielded:
                yielded = True
                raise YieldWork()
            return []
        return deepcopy(data[endpoint])
    with patch.object(Client, "get", get):
        with pytest.raises(YieldWork):
            prepare(meta, tmp_path, time.monotonic() + 180)
        assert (tmp_path / "meta-laps.json").exists()
        a = prepare(meta, tmp_path, time.monotonic() + 180)
        assert len(a["telemetry_manifest"]["laps"]) == 4
        assert all(l["chunk"] is None and l["reason"] for l in a["telemetry_manifest"]["laps"])
        write_json(tmp_path / "artifact.json", {"artifact": a, "version": "a" * 20})
        write_json(tmp_path / "uploaded.json", ["old-file"])
        restored = tmp_path / "restored"
        restored.mkdir()
        unpack(pack(tmp_path), restored)
        assert not list(restored.glob("driver-*.json"))
        assert prepare(meta, restored, time.monotonic() + 180) == a
        data["race_control"].append({"date": iso(stamp(source["date_start"]) + 900), "message": "CAR 16 (LEC) LAP 3 DELETED"})
        b = prepare(meta, restored, time.monotonic() + 180)
        assert b["laps"][2]["deleted"]
        assert not (restored / "uploaded.json").exists()
        assert not (restored / "artifact.json").exists()

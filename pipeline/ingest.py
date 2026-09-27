"""Run `python -m pipeline.ingest --limit 3`; credentials come from environment."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import time

import fastf1
from fastf1 import plotting
import numpy as np
import pandas as pd
import requests

from .analysis import fastest_laps, mark_clean_laps, pit_durations, resample_trace
from .scheduler import due, correction_stage, parse

LOG = logging.getLogger("f1.ingest")
CODES = {"Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3", "Qualifying": "Q", "Sprint Qualifying": "SQ", "Sprint Shootout": "SQ", "Sprint": "S", "Race": "R"}


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def seconds(value):
    return None if pd.isna(value) else round(float(value.total_seconds()), 6)


def number(value):
    return None if pd.isna(value) or not np.isfinite(value) else float(value)


def flag(value):
    return False if pd.isna(value) else bool(value)


def request(action, **payload):
    url, token = os.environ["F1_INGEST_URL"], os.environ["F1_INGEST_TOKEN"]
    for attempt in range(3):
        try:
            response = requests.post(url, headers={"x-ingest-token": token}, json={"action": action, **payload}, timeout=120)
            if response.status_code == 429 or response.status_code >= 500:
                response.raise_for_status()
            if not response.ok:
                raise RuntimeError(f"Publisher rejected {action}: HTTP {response.status_code}: {response.text[:200]}")
            return response.json()
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError):
            if attempt == 2:
                raise
            time.sleep(2 ** (attempt + 1))


def discover(year):
    # Refresh upstream schedule; cached future schedules otherwise conceal changes.
    with fastf1.Cache.disabled():
        schedule = fastf1.get_event_schedule(year, include_testing=False)
    sessions = []
    for _, event in schedule.iterrows():
        if int(event.RoundNumber) <= 0:
            continue
        for i in range(1, 6):
            name = event.get(f"Session{i}")
            start = event.get(f"Session{i}DateUtc")
            if name not in CODES or pd.isna(start):
                continue
            code = CODES[name]
            start = pd.Timestamp(start)
            start = start.tz_localize("UTC") if start.tz is None else start.tz_convert("UTC")
            sessions.append({"id": f"{year}-{int(event.RoundNumber):02d}-{code}", "year": year,
                             "round": int(event.RoundNumber), "event": str(event.EventName),
                             "country": str(event.Country), "location": str(event.Location),
                             "name": name, "code": code, "starts_at": start.isoformat()})
    if not sessions:
        raise RuntimeError("Source returned an empty calendar; retaining the previous calendar.")
    return sessions


def prepare(meta, refresh=False):
    session = fastf1.get_session(meta["year"], meta["round"], meta["code"])
    LOG.info("Source session path: %s", session.api_path)
    if refresh:
        with fastf1.Cache.disabled():
            session.load(telemetry=True, weather=True, messages=True)
    else:
        session.load(telemetry=True, weather=True, messages=True)
    try:
        loaded_laps = session.laps
    except fastf1.exceptions.DataNotLoadedError:
        # Keep upstream access failures distinguishable from parsing failures.
        for host in ("https://livetiming.formula1.com", "https://livetiming-mirror.fastf1.dev"):
            try:
                response = requests.get(host + session.api_path + "SessionInfo.json", timeout=30)
                LOG.error("Source availability %s: HTTP %s", host, response.status_code)
            except requests.RequestException as exc:
                LOG.error("Source availability %s: %s", host, type(exc).__name__)
        raise
    if loaded_laps.empty:
        raise RuntimeError("Lap timing is not available yet")
    statuses = session.session_status
    if statuses.empty or str(statuses.iloc[-1]["Status"]) not in ("Finished", "Finalised", "Ends"):
        raise RuntimeError("Session completion has not been confirmed")
    raw = session.laps
    phase_by_index = {}
    if meta["code"] in ("Q", "SQ"):
        try:
            for phase, frame in zip(("Q1", "Q2", "Q3"), raw.split_qualifying_sessions()):
                if frame is not None:
                    for idx in frame.index:
                        phase_by_index[idx] = phase
        except (ValueError, AttributeError):
            LOG.warning("Qualifying segments unavailable for %s", meta["id"])
    laps = []
    raw_by_key = {}
    for idx, row in raw.iterrows():
        sectors = [seconds(row.get(f"Sector{i}Time", pd.NaT)) for i in (1, 2, 3)]
        lap_time = seconds(row.LapTime)
        if lap_time is None and all(x is not None for x in sectors):
            lap_time = round(sum(sectors), 6)
        lap = {"driver": str(row.Driver), "number": int(row.LapNumber), "time": lap_time,
               "sectors": sectors, "stint": int(row.Stint) if pd.notna(row.Stint) else 0,
               "compound": str(row.Compound) if pd.notna(row.Compound) else "UNKNOWN",
               "tyre_age": number(row.TyreLife), "fresh": flag(row.FreshTyre),
               "position": number(row.Position), "deleted": flag(row.Deleted),
               "accurate": flag(row.IsAccurate), "track_status": str(row.TrackStatus),
               "pit_in": seconds(row.PitInTime), "pit_out": seconds(row.PitOutTime),
               "phase": phase_by_index.get(idx, "ALL"), "clean": False}
        laps.append(lap)
        raw_by_key[(lap["driver"], lap["number"])] = row
    mark_clean_laps(laps)
    drivers = []
    for _, row in session.results.iterrows():
        color = str(row.get("TeamColor", "808a9d"))
        color = color if len(color) == 6 and all(c in "0123456789abcdefABCDEF" for c in color) else "808a9d"
        try:
            color = plotting.get_driver_color(str(row.Abbreviation), session, colormap="official").lstrip("#")
        except (KeyError, ValueError):
            pass  # Keep the TeamColor supplied with the session results.
        drivers.append({"code": str(row.Abbreviation), "name": str(row.FullName), "team": str(row.TeamName),
                        "color": f"#{color}", "number": str(row.DriverNumber), "position": number(row.Position)})
    phases = ["ALL"] + [p for p in ("Q1", "Q2", "Q3") if p in phase_by_index.values()]
    traces, unavailable = [], []
    trace_cache = {}
    for phase in phases:
        for lap in fastest_laps(laps, phase):
            key = (lap["driver"], lap["number"])
            if key not in trace_cache:
                try:
                    tel = raw_by_key[key].get_telemetry()
                    fields = {"speed": "Speed", "throttle": "Throttle", "brake": "Brake", "gear": "nGear", "rpm": "RPM", "x": "X", "y": "Y"}
                    channels = {k: pd.to_numeric(tel[v], errors="coerce").astype(float).to_numpy() if v in tel else np.full(len(tel), np.nan) for k, v in fields.items()}
                    trace_cache[key] = resample_trace(tel.Distance, tel.Time.dt.total_seconds(), channels, lap["time"], lap["sectors"])
                except Exception as exc:
                    LOG.warning("Telemetry unavailable %s lap %s: %s", *key, type(exc).__name__)
                    trace_cache[key] = None
            if trace_cache[key]:
                traces.append({**trace_cache[key], "driver": lap["driver"], "lap": lap["number"], "phase": phase, "lap_time": lap["time"]})
    if len({t["driver"] for t in traces}) < len(fastest_laps(laps)):
        unavailable.append("Some fastest-lap telemetry is not available yet.")
    weather = []
    for _, row in session.weather_data.iterrows():
        weather.append({"minute": round(row.Time.total_seconds() / 60, 2), "air": number(row.AirTemp),
                        "track": number(row.TrackTemp), "humidity": number(row.Humidity), "pressure": number(row.Pressure),
                        "wind_speed": number(row.WindSpeed), "wind_direction": number(row.WindDirection), "rain": flag(row.Rainfall)})
    if not weather:
        unavailable.append("Weather data is unavailable.")
    return {"schema_version": 1, "session_id": meta["id"], "generated_at": utcnow(),
            "provenance": {"source": "FastF1", "fastf1_version": fastf1.__version__, "pipeline_version": 2, "units": {"time": "s", "distance": "m", "speed": "km/h", "temperature": "°C"}},
            "drivers": drivers, "laps": laps, "traces": traces, "weather": weather,
            "pit_stops": pit_durations(laps) if meta["code"] in ("R", "S") else [], "phases": phases, "unavailable": unavailable}


def prune_cache(folder, max_bytes=1_000_000_000):
    files = sorted((p for p in folder.rglob("*") if p.is_file()), key=lambda p: p.stat().st_mtime)
    size = sum(p.stat().st_size for p in files)
    for path in files:
        if size <= max_bytes:
            break
        size -= path.stat().st_size
        path.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--session")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--local", action="store_true", help="Save a specified session locally without publishing")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    cache = Path("fastf1_cache")
    cache.mkdir(exist_ok=True)
    fastf1.Cache.enable_cache(str(cache))
    if args.local:
        year, rnd, code = args.session.split("-")
        if int(year) < 2026:
            raise ValueError("Only 2026 onward is supported")
        analysis = prepare({"year": int(year), "round": int(rnd), "code": code, "id": args.session}, args.force)
        Path(".local").mkdir(exist_ok=True)
        Path(f".local/{args.session}.json").write_text(json.dumps(analysis, allow_nan=False, separators=(",", ":")), encoding="utf-8")
        return
    state = request("state")
    now = datetime.now(timezone.utc)
    calendar_checked = parse(state.get("calendar_checked_at"))
    if not calendar_checked or (now - calendar_checked).total_seconds() > 86400 or args.force:
        for year in range(2026, now.year + 1):
            request("calendar", year=year, sessions=discover(year))
        state = request("state")
    candidates = [s for s in state["sessions"] if (not args.session or s["id"] == args.session) and due(s, now, args.force)]
    candidates.sort(key=lambda s: s["starts_at"], reverse=True)
    failures = 0
    for meta in candidates[:max(1, min(args.limit, 10))]:
        LOG.info("Preparing %s", meta["id"])
        try:
            artifact = prepare(meta, refresh=bool(meta.get("last_checked_at")))
            # Timestamp is excluded from the content hash, allowing repeat-safe publication.
            canonical = {k: v for k, v in artifact.items() if k != "generated_at"}
            digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()[:20]
            request("publish", session_id=meta["id"], version=digest, artifact=artifact, correction_stage=correction_stage(meta, now))
        except Exception as exc:
            failures += 1
            LOG.exception("Session %s was not updated", meta["id"])
            request("failed", session_id=meta["id"], message=type(exc).__name__)
    prune_cache(cache)
    if failures:
        raise SystemExit(f"{failures} sessions pending or failed; previous publications retained")


if __name__ == "__main__":
    main()

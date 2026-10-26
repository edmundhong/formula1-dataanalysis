"""OpenF1 historical adapter. Output is the existing schema-v1 dashboard contract.

No credentials are needed. State and completed windows are local files so the
credential-holding parent can checkpoint them without giving secrets to this code.
"""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import logging
import math
from pathlib import Path
import re
import time

import numpy as np
import requests

from .analysis import fastest_laps, mark_clean_laps, resample_trace
from .telemetry import TelemetryWriter

LOG = logging.getLogger("f1.openf1")
VERSION = 1
BASE = "https://api.openf1.org/v1/"
NAMES = {"FP1": "Practice 1", "FP2": "Practice 2", "FP3": "Practice 3",
         "Q": "Qualifying", "SQ": "Sprint Qualifying", "S": "Sprint", "R": "Race"}
METADATA = ("drivers", "laps", "race_control", "stints", "pit", "position", "weather", "session_result")
VALIDITY = ("laps", "race_control", "session_result")


class YieldWork(Exception):
    """A successful continuation, not an upstream failure."""


class SourceUnavailable(Exception):
    pass


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def finite(value):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def read_json(path, default=None):
    return json.loads(Path(path).read_text(encoding="utf-8")) if Path(path).exists() else default


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def match_session(meta, rows):
    def normalized(value):
        return re.sub(r"[^a-z0-9]", "", str(value).lower())
    names = {NAMES[meta["code"]]}
    if meta["code"] == "SQ":
        names.add("Sprint Shootout")
    matches = [s for s in rows if s.get("year") == meta["year"]
               and s.get("session_name") in names
               and normalized(s.get("location")) == normalized(meta["location"])
               and abs(stamp(s["date_start"]) - stamp(meta["starts_at"])) <= 12 * 3600]
    if len(matches) != 1 or matches[0].get("is_cancelled"):
        raise SourceUnavailable("Session mapping is missing, cancelled, or ambiguous")
    return matches[0]


class Client:
    def __init__(self, folder, deadline, transport=None):
        self.folder = Path(folder)
        self.deadline = deadline
        self.transport = transport or requests.Session()
        self.state = read_json(self.folder / "state.json", {"adapter_version": VERSION, "requests": 0})
        if self.state.get("adapter_version") != VERSION:
            raise SourceUnavailable("Checkpoint adapter version changed")
        self.last_request = 0.

    def save(self):
        write_json(self.folder / "state.json", self.state)

    def check_time(self, reserve=20):
        if time.monotonic() + reserve >= self.deadline:
            self.save()
            raise YieldWork()

    def get(self, endpoint, **params):
        for attempt in range(3):
            self.check_time(40)
            cooldown = max(0., self.state.get("cooldown_until", 0) - time.time())
            wait = max(cooldown, 2.1 - (time.monotonic() - self.last_request))
            if time.monotonic() + wait + 35 >= self.deadline:
                self.save()
                raise YieldWork()
            if wait > 0:
                time.sleep(wait)
            self.last_request = time.monotonic()
            self.state["requests"] += 1
            self.save()
            try:
                response = self.transport.get(BASE + endpoint, params=params, timeout=(5, 25),
                                              headers={"User-Agent": "formula1-dataanalysis/OpenF1-adapter-1"})
            except requests.RequestException:
                if attempt == 2:
                    raise SourceUnavailable("OpenF1 network error") from None
                time.sleep(2 ** attempt)
                continue
            LOG.info("OpenF1 endpoint=%s status=%s requests=%s", endpoint, response.status_code, self.state["requests"])
            write_json(self.folder / "diagnostics.json", {"endpoint": endpoint, "status": response.status_code,
                       "requests": self.state["requests"], "progress": self.state.get("progress", {})})
            if response.status_code == 429:
                header = response.headers.get("Retry-After", "60")
                try:
                    delay = float(header)
                except ValueError:
                    try:
                        delay = parsedate_to_datetime(header).timestamp() - time.time()
                    except (ValueError, TypeError):
                        delay = 60
                self.state["cooldown_until"] = time.time() + max(2.1, delay)
                self.save()
                raise YieldWork()
            if response.status_code >= 500 and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            if response.status_code == 404:
                try:
                    if response.json().get("detail") == "No results found.":
                        return []
                except (ValueError, AttributeError):
                    pass
            if response.status_code != 200:
                raise SourceUnavailable(f"OpenF1 {endpoint}: HTTP {response.status_code}")
            rows = response.json()
            if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
                raise SourceUnavailable("Invalid OpenF1 response")
            if params.get("session_key") is not None and any(r.get("session_key") != params["session_key"] for r in rows):
                raise SourceUnavailable("OpenF1 returned a different session")
            return rows
        raise SourceUnavailable("OpenF1 temporarily unavailable")


def chronological(rows):
    return sorted((r for r in rows if r.get("date")), key=lambda r: stamp(r["date"]))


def normalize(meta, source, data):
    """Conservative mapping: unknown quality never implies a green/valid lap."""
    origin = stamp(source["date_start"])
    rc = chronological(data["race_control"])
    phase_starts = [(stamp(r["date"]), int(r["qualifying_phase"])) for r in rc
                    if r.get("qualifying_phase") in (1, 2, 3) and r.get("message") == "SESSION STARTED"]
    # Each phase may restart after a red flag; repeated phase markers are fine.
    results = {r["driver_number"]: r for r in data["session_result"]}
    driver_rows = {r["driver_number"]: r for r in data["drivers"]}
    drivers = []
    for num, r in sorted(driver_rows.items()):
        color = str(r.get("team_colour") or "808a9d").lstrip("#")
        drivers.append({"code": r.get("name_acronym") or str(num), "number": str(num),
                        "name": r.get("full_name") or str(num), "team": r.get("team_name") or "Unknown",
                        "color": "#" + (color if re.fullmatch(r"[a-fA-F0-9]{6}", color) else "808a9d"),
                        "position": results.get(num, {}).get("position")})
    by_num = {int(d["number"]): d for d in drivers}
    laps, warnings = [], []
    raw_by_key = {}
    for r in sorted(data["laps"], key=lambda l: (l["driver_number"], l["lap_number"])):
        num = r["driver_number"]
        if num not in by_num:
            raise SourceUnavailable("Lap driver metadata is missing")
        key = (num, r["lap_number"])
        if key in raw_by_key:
            raise SourceUnavailable("Duplicate OpenF1 lap identity")
        raw_by_key[key] = r
        issues = []
        start = stamp(r["date_start"]) if r.get("date_start") else None
        sectors = [finite(r.get(f"duration_sector_{i}")) for i in (1, 2, 3)]
        duration = finite(r.get("lap_duration"))
        if duration is None and all(s is not None and s > 0 for s in sectors):
            duration = round(sum(sectors), 6)
        end = start + duration if start is not None and duration is not None else None
        if duration is None or duration <= 0 or any(s is None or s <= 0 for s in sectors) or abs(sum(s or 0 for s in sectors) - duration) > .15:
            issues.append("timing_unverified")
        phase = "ALL"
        if meta["code"] in ("Q", "SQ"):
            phases = [p for t, p in phase_starts if start is not None and t <= start]
            if phases:
                phase = f"Q{phases[-1]}"
            else:
                issues.append("phase_unverified")
        stint_rows = [s for s in data["stints"] if s["driver_number"] == num
                      and s.get("lap_start") is not None and s.get("lap_end") is not None
                      and s["lap_start"] <= r["lap_number"] <= s["lap_end"]]
        stint = stint_rows[0] if len(stint_rows) == 1 else {}
        tyre_start = finite(stint.get("tyre_age_at_start"))
        tyre_age = tyre_start + r["lap_number"] - stint["lap_start"] + 1 if tyre_start is not None else None
        if not stint:
            issues.append("stint_unverified")
        elif tyre_start is None:
            issues.append("tyre_age_unverified")
        pit_out = r.get("is_pit_out_lap")
        if pit_out is None:
            issues.append("pit_unverified")
        # Pit messages are recorded at pit exit. Use explicit duration to recover
        # entry, and only attach it to an actually overlapping lap interval.
        pit_in_time = None
        for p in data["pit"]:
            if p["driver_number"] != num or finite(p.get("lane_duration")) is None or not p.get("date"):
                continue
            entry = stamp(p["date"]) - p["lane_duration"]
            if start is not None and end is not None and start <= entry <= end:
                pit_in_time = entry - origin
        # The following lap's explicit out-lap flag also proves this is a pit-in
        # lap, even when the pit duration is missing (long garage visits).
        next_rows = [n for n in data["laps"] if n["driver_number"] == num and n["lap_number"] == r["lap_number"] + 1]
        if pit_in_time is None and (not next_rows or next_rows[0].get("is_pit_out_lap") is None):
            issues.append("pit_unverified")
        pit_in = bool(pit_in_time is not None or (next_rows and next_rows[0].get("is_pit_out_lap")))
        track = track_status(rc, start, end)
        if track == "UNKNOWN":
            issues.append("track_unverified")
        positions = [p for p in data["position"] if p["driver_number"] == num and p.get("date") and end is not None and stamp(p["date"]) <= end]
        position = max(positions, key=lambda p: stamp(p["date"]))["position"] if positions else None
        laps.append({"driver": by_num[num]["code"], "number": r["lap_number"], "time": duration,
                     "end_time": round(end - origin, 6) if end is not None else None, "sectors": sectors,
                     "stint": stint.get("stint_number", 0), "compound": stint.get("compound") or "UNKNOWN",
                     "tyre_age": tyre_age, "fresh": tyre_start == 0 if tyre_start is not None else False,
                     "position": position, "deleted": False, "accurate": not issues,
                     "track_status": track, "pit_in": pit_in_time,
                     "pit_out": start - origin if pit_out and start is not None else None,
                     "phase": phase, "clean": False,
                     "quality": {"issues": issues, "pit_in": pit_in, "pit_out": bool(pit_out)}})
    lap_map = {(l["driver"], l["number"]): l for l in laps}
    for r in rc:
        message = str(r.get("message", "")).upper()
        if "DELETED" not in message and "REINSTATED" not in message:
            continue
        car = re.search(r"CAR\s+(\d+)", message)
        lap_no = re.search(r"\bLAP\s+(\d+)\b", message)
        num = r.get("driver_number") or (int(car[1]) if car else None)
        number = r.get("lap_number") or (int(lap_no[1]) if lap_no else None)
        driver = by_num.get(num, {}).get("code")
        target = lap_map.get((driver, number))
        if target:
            target["deleted"] = "REINSTATED" not in message
        else:
            # A deletion we cannot assign must not silently leave a winner valid.
            for lap in laps:
                if driver is None or lap["driver"] == driver:
                    lap["quality"]["issues"].append("validity_unverified")
    if meta["code"] in ("Q", "SQ"):
        for num, driver in by_num.items():
            official = results.get(num, {}).get("duration")
            for phase_num in (1, 2, 3):
                candidates = [l for l in laps if l["driver"] == driver["code"] and l["phase"] == f"Q{phase_num}"]
                if not candidates:
                    continue
                expected = finite(official[phase_num - 1]) if isinstance(official, list) and len(official) >= phase_num else None
                best = fastest_laps(candidates)
                if expected is None or not best or abs(best[0]["time"] - expected) > .005:
                    for lap in candidates:
                        lap["quality"]["issues"].append("validity_unverified")
                    warnings.append(f"{driver['code']} Q{phase_num} best time could not be verified against session results.")
    for lap in laps:
        lap["quality"]["issues"] = sorted(set(lap["quality"]["issues"]))
        lap["accurate"] = not lap["quality"]["issues"]
    mark_clean_laps(laps)
    weather = [{"minute": round((stamp(w["date"]) - origin) / 60, 2),
                **{target: finite(w.get(source)) for target, source in (("air", "air_temperature"), ("track", "track_temperature"),
                   ("humidity", "humidity"), ("pressure", "pressure"), ("wind_speed", "wind_speed"), ("wind_direction", "wind_direction"))},
                "rain": bool(w.get("rainfall"))} for w in data["weather"] if w.get("date")]
    if not weather:
        warnings.append("Weather data is unavailable.")
    if any(l["quality"]["issues"] for l in laps):
        warnings.append("Some laps have unverified timing, validity, tyre or track conditions; affected validated comparisons are unavailable.")
    warnings.append("Numbered circuit corners are unavailable for this source.")
    pits = [{"driver": by_num[p["driver_number"]]["code"], "lap": p["lap_number"], "duration": p["lane_duration"]}
            for p in data["pit"] if p["driver_number"] in by_num and finite(p.get("lane_duration")) is not None and 0 < p["lane_duration"] <= 300]
    return {"schema_version": 1, "session_id": meta["id"], "generated_at": iso(time.time()),
            "provenance": {"source": "OpenF1", "adapter_version": VERSION, "session_key": source["session_key"],
                           "meeting_key": source["meeting_key"], "units": {"time": "s", "distance": "m", "speed": "km/h", "temperature": "°C"}},
            "drivers": drivers, "laps": laps, "traces": [], "weather": weather, "corners": [],
            "pit_stops": pits if meta["code"] in ("R", "S") else [],
            "phases": ["ALL"] + sorted({l["phase"] for l in laps} - {"ALL"}), "unavailable": list(dict.fromkeys(warnings))}


def track_status(rc, start, end):
    if start is None or end is None:
        return "UNKNOWN"
    # Preserve every disruption intersecting a lap. A green sector message must
    # never clear a safety car, VSC or a yellow in a different sector.
    active = {}
    known = False
    disrupted = False
    for r in rc:
        t = stamp(r["date"])
        if t > end:
            break
        flag, msg = r.get("flag"), str(r.get("message", "")).upper()
        scope = str(r.get("scope")), r.get("sector")
        if flag in ("YELLOW", "DOUBLE YELLOW", "RED"):
            active[scope] = flag
        elif "VIRTUAL SAFETY CAR DEPLOYED" in msg:
            active[("vsc", None)] = "VSC"
        elif "SAFETY CAR DEPLOYED" in msg:
            active[("sc", None)] = "SC"
        elif "VSC ENDING" in msg or "SAFETY CAR IN THIS LAP" in msg:
            pass
        elif flag in ("GREEN", "CLEAR"):
            known = True
            active.pop(scope, None)
            if r.get("scope") == "Track":
                active.clear()
        if t <= start:
            disrupted = bool(active)
        elif active:
            disrupted = True
    return "2" if disrupted else "1" if known else "UNKNOWN"


def make_trace(lap, raw_lap, car, location):
    if lap["time"] is None or lap["time"] <= 0 or not raw_lap.get("date_start"):
        return None
    start, duration = stamp(raw_lap["date_start"]), lap["time"]
    def ordered(rows):
        return sorted({stamp(r["date"]): r for r in rows if r.get("date")}.items())
    cars = ordered(car)
    if len(cars) < 20:
        return None
    absolute = np.array([t for t, _ in cars])
    # Boundary interpolation is permitted only between actual bracketing samples.
    if absolute[0] > start or absolute[-1] < start + duration:
        return None
    inside = absolute[(absolute > start) & (absolute < start + duration)]
    times = np.concatenate(([start], inside, [start + duration]))
    right = np.clip(np.searchsorted(absolute, times, side="right"), 1, len(absolute) - 1)
    left = right - 1
    if any(absolute[right[i]] - absolute[left[i]] > 1 for i in (0, len(times) - 1)):
        return None
    channels = {}
    for out, field in (("speed", "speed"), ("throttle", "throttle"), ("brake", "brake"), ("gear", "n_gear"), ("rpm", "rpm")):
        values = np.array([finite(r.get(field)) if finite(r.get(field)) is not None else np.nan for _, r in cars])
        if out in ("brake", "gear"):
            indices = np.clip(np.searchsorted(absolute, times, side="right") - 1, 0, len(values) - 1)
            channels[out] = values[indices]
            if out == "brake":
                channels[out] = channels[out] / 100
        else:
            channels[out] = np.interp(times, absolute, values)
    if not np.isfinite(channels["speed"]).all() or np.any(channels["speed"] < 0):
        return None
    elapsed = times - start
    distance = np.concatenate(([0.], np.cumsum((channels["speed"][:-1] + channels["speed"][1:]) / 7.2 * np.diff(elapsed))))
    positions = ordered(location)
    for field in ("x", "y"):
        output = np.full(len(times), np.nan)
        if len(positions) >= 2:
            pt = np.array([t for t, _ in positions])
            pv = np.array([finite(r.get(field)) if finite(r.get(field)) is not None else np.nan for _, r in positions])
            idx = np.clip(np.searchsorted(pt, times, side="right"), 1, len(pt) - 1)
            ok = (times >= pt[0]) & (times <= pt[-1]) & ((pt[idx] - pt[idx - 1]) <= 1)
            output[ok] = np.interp(times[ok], pt, pv)
        channels[field] = output
    trace = resample_trace(distance, elapsed, channels, duration, lap["sectors"])
    if trace:
        # resample_trace interpolates continuous channels. Restore step semantics
        # for brake and gear on its exact distance grid.
        grid = np.linspace(distance[0], distance[-1], 1000)
        indices = np.clip(np.searchsorted(distance, grid, side="right") - 1, 0, len(distance) - 1)
        for field in ("brake", "gear"):
            trace[field] = [float(channels[field][i]) if trace["time"][j] is not None and np.isfinite(channels[field][i]) else None for j, i in enumerate(indices)]
        # Position gaps do not invalidate elapsed timing. The dashboard can use
        # another selected lap's geometry and leaves missing timing sections blank.
        if lap.get("quality", {}).get("issues") or lap.get("deleted"):
            trace["reliable"] = False
            trace["reason"] = "Lap validity could not be verified."
    return trace


def prepare(meta, folder, deadline, transport=None):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    client = Client(folder, deadline, transport)
    state = client.state
    identity = digest({k: meta[k] for k in ("id", "location", "code", "starts_at")})
    if state.get("catalog_identity") not in (None, identity):
        # A postponed/reconciled calendar entry must be mapped again.
        for p in folder.glob("*.json"):
            if p.name != "session.json":
                p.unlink()
        client.state = state = {"adapter_version": VERSION, "requests": state.get("requests", 0),
                                "cooldown_until": state.get("cooldown_until", 0)}
    state["catalog_identity"] = identity
    if "source" not in state:
        state["source"] = match_session(meta, client.get("sessions", year=meta["year"]))
        client.save()
    source = state["source"]
    if stamp(source["date_end"]) > time.time() or source.get("is_cancelled"):
        raise SourceUnavailable("Session has not finished")
    key = source["session_key"]
    for endpoint in METADATA:
        path = folder / f"meta-{endpoint}.json"
        if not path.exists():
            write_json(path, client.get(endpoint, session_key=key))
    # Revalidate timing/validity snapshots on each continuation, including after
    # publication was staged. Save partial revalidation across short invocations.
    if state.get("snapshot"):
        for endpoint in VALIDITY:
            path = folder / f"verify-{endpoint}.json"
            if not path.exists():
                write_json(path, client.get(endpoint, session_key=key))
        changed = any(digest(read_json(folder / f"verify-{e}.json")) != digest(read_json(folder / f"meta-{e}.json")) for e in VALIDITY)
        if changed:
            for e in VALIDITY:
                write_json(folder / f"meta-{e}.json", read_json(folder / f"verify-{e}.json"))
            for pattern in ("window-*.json", "driver-*.json", "*.telemetry-*.json", "telemetry-*.json", "artifact.json", "uploaded.json"):
                for p in folder.glob(pattern):
                    p.unlink()
            for e in set(METADATA) - set(VALIDITY):
                (folder / f"meta-{e}.json").unlink(missing_ok=True)
            state.pop("complete", None)
        for e in VALIDITY:
            (folder / f"verify-{e}.json").unlink()
    for endpoint in METADATA:
        path = folder / f"meta-{endpoint}.json"
        if not path.exists():
            write_json(path, client.get(endpoint, session_key=key))
    data = {e: read_json(folder / f"meta-{e}.json") for e in METADATA}
    if not data["laps"] or not data["drivers"]:
        raise SourceUnavailable("Timing or drivers are not published yet")
    statuses = [r for r in chronological(data["race_control"]) if r.get("category") == "SessionStatus" or str(r.get("message", "")).startswith("SESSION ")]
    if not statuses or statuses[-1].get("message") not in ("SESSION FINISHED", "SESSION FINALISED", "SESSION FINALIZED"):
        raise SourceUnavailable("Session completion has not been confirmed")
    state["snapshot"] = digest({e: data[e] for e in VALIDITY})
    client.save()
    artifact = normalize(meta, source, data)
    if (folder / "artifact.json").exists():
        client.save()
        return read_json(folder / "artifact.json")["artifact"]
    drivers = artifact["drivers"]
    for driver in drivers:
        num = int(driver["number"])
        output = folder / f"driver-{num}.json"
        if output.exists():
            continue
        raw_laps = {r["lap_number"]: r for r in data["laps"] if r["driver_number"] == num}
        timed = [l for l in artifact["laps"] if l["driver"] == driver["code"] and l["time"] is not None and l["time"] > 0 and raw_laps[l["number"]].get("date_start")]
        cars, positions = [], []
        if timed:
            begin = min(stamp(raw_laps[l["number"]]["date_start"]) for l in timed) - 1
            finish = max(stamp(raw_laps[l["number"]]["date_start"]) + l["time"] for l in timed) + 1
            cursor, index = begin, 0
            while cursor < finish:
                end = min(cursor + 1200, finish)
                for endpoint, target in (("car_data", cars), ("location", positions)):
                    path = folder / f"window-{num}-{index}-{endpoint}.json"
                    if not path.exists():
                        # OpenF1 uses strict > / < filter keys. >= / <= may
                        # silently return no rows. Overlap windows, then dedupe.
                        write_json(path, client.get(endpoint, session_key=key, driver_number=num, **{"date>": iso(cursor - .001), "date<": iso(end + .001)}))
                    target.extend(read_json(path))
                cursor, index = end, index + 1
        traces = {}
        for lap in timed:
            client.check_time(8)
            t = stamp(raw_laps[lap["number"]]["date_start"])
            trace = make_trace(lap, raw_laps[lap["number"]],
                               [r for r in cars if t - 1 <= stamp(r["date"]) <= t + lap["time"] + 1],
                               [r for r in positions if t - 1 <= stamp(r["date"]) <= t + lap["time"] + 1])
            if trace:
                traces[str(lap["number"])] = trace
        write_json(output, traces)
        for p in folder.glob(f"window-{num}-*.json"):
            p.unlink()
        state["progress"] = {"completed": sum((folder / f"driver-{d['number']}.json").exists() for d in drivers), "total": len(drivers), "stage": "telemetry"}
        client.save()
    writer = TelemetryWriter(folder, meta["id"])
    all_traces = {}
    for driver in drivers:
        traces = read_json(folder / f"driver-{driver['number']}.json", {})
        for lap in (l for l in artifact["laps"] if l["driver"] == driver["code"]):
            trace = traces.get(str(lap["number"]))
            writer.add(lap, trace, "Source telemetry or complete lap boundaries unavailable." if not trace else None)
            if trace:
                all_traces[(lap["driver"], lap["number"])] = trace
    artifact["telemetry_manifest"] = writer.finish()
    for phase in artifact["phases"]:
        for lap in fastest_laps(artifact["laps"], phase):
            trace = all_traces.get((lap["driver"], lap["number"]))
            if trace:
                artifact["traces"].append({**trace, "driver": lap["driver"], "lap": lap["number"], "phase": phase, "lap_time": lap["time"]})
    if any(entry["chunk"] is None for entry in artifact["telemetry_manifest"]["laps"]):
        artifact["unavailable"].append("Some lap telemetry is unavailable; see the selected lap for its reason.")
    if any(not trace["reliable"] for trace in all_traces.values()):
        artifact["unavailable"].append("Some telemetry fails timing, validity or coverage checks and cannot support reliable deltas or track dominance.")
    state["complete"] = True
    client.save()
    # Final publication may happen in the same invocation; recheck the snapshot
    # after downloads so a late deletion cannot leave stale derived comparisons.
    for endpoint in VALIDITY:
        fresh = client.get(endpoint, session_key=key)
        if digest(fresh) != digest(data[endpoint]):
            write_json(folder / f"verify-{endpoint}.json", fresh)
            raise YieldWork()
    return artifact

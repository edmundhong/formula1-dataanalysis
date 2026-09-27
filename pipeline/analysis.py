"""Pure calculations. Times are seconds; missing values remain missing."""
from collections import defaultdict
from statistics import median
import math


def fastest_laps(laps, phase="ALL"):
    best = {}
    for lap in laps:
        if lap["time"] is None or lap["time"] <= 0 or lap["deleted"] or lap["pit_in"] is not None or lap["pit_out"] is not None:
            continue
        if phase != "ALL" and lap["phase"] != phase:
            continue
        previous = best.get(lap["driver"])
        if previous is None or lap["time"] < previous["time"]:
            best[lap["driver"]] = lap
    return sorted(best.values(), key=lambda x: (x["time"], x["driver"]))


def mark_clean_laps(laps):
    groups = defaultdict(list)
    for lap in laps:
        eligible = (lap["time"] is not None and lap["time"] > 0
                    and not lap["deleted"] and lap["accurate"]
                    and lap["track_status"] == "1" and lap["number"] > 1
                    and lap["pit_in"] is None and lap["pit_out"] is None)
        lap["clean"] = bool(eligible)
        if eligible:
            groups[(lap["driver"], lap["stint"])].append(lap["time"])
    medians = {key: median(values) for key, values in groups.items()}
    for lap in laps:
        if lap["clean"]:
            lap["clean"] = lap["time"] <= 1.07 * medians[(lap["driver"], lap["stint"])]
    return laps


def pit_durations(laps):
    events = defaultdict(list)
    for lap in laps:
        for field, kind in (("pit_in", "in"), ("pit_out", "out")):
            if lap[field] is not None:
                events[lap["driver"]].append((lap[field], kind, lap["number"]))
    stops = []
    for driver, entries in events.items():
        pending = None
        for time, kind, number in sorted(entries):
            if kind == "in":
                pending = (time, number)
            elif pending:
                duration = time - pending[0]
                # Long garage visits are not pit stops. No cross-driver pairing.
                if 0 < duration <= 300:
                    stops.append({"driver": driver, "lap": pending[1], "duration": round(duration, 3)})
                pending = None
    return stops


def resample_trace(distance, elapsed, channels, lap_time, sectors):
    """1000 shared progress samples, with no interpolation across >1s gaps."""
    import numpy as np
    distance = np.asarray(distance, dtype=float)
    elapsed = np.asarray(elapsed, dtype=float)
    good = np.isfinite(distance) & np.isfinite(elapsed)
    keep = np.flatnonzero(good)
    # Distance must increase; discard duplicates/backwards points rather than sorting time.
    keep = [i for j, i in enumerate(keep) if j == 0 or distance[i] > distance[keep[j-1]]]
    if len(keep) < 20:
        return None
    d, t = distance[keep], elapsed[keep]
    if np.any(np.diff(d) <= 0) or np.any(np.diff(t) <= 0) or d[-1] <= d[0]:
        return None
    grid = np.linspace(d[0], d[-1], 1000)
    valid = np.ones(1000, dtype=bool)
    for i in np.flatnonzero(np.diff(t) > 1.0):
        valid[(grid > d[i]) & (grid < d[i+1])] = False
    timing_ok = abs(t[0]) <= .15 and abs(t[-1] - lap_time) <= .15
    sectors_ok = all(s is not None for s in sectors) and abs(sum(sectors) - lap_time) <= .15
    reliable = bool(timing_ok and sectors_ok and valid.mean() >= .98)

    def interpolate(values, digits=3):
        values = np.asarray(values, dtype=float)[keep]
        result = np.interp(grid, d, values)
        return [round(float(v), digits) if valid[i] and math.isfinite(v) else None for i, v in enumerate(result)]

    return {"distance": [round(float(v - d[0]), 3) for v in grid], "time": interpolate(elapsed),
            **{name: interpolate(values, 2) for name, values in channels.items()},
            "reliable": reliable,
            "reason": None if reliable else "Telemetry boundary, sector timing, or coverage check failed."}

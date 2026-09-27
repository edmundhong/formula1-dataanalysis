from datetime import datetime, timedelta, timezone

DURATIONS = {"R": 3, "S": 1.5, "Q": 2, "SQ": 1.5, "FP1": 2, "FP2": 2, "FP3": 2}


def parse(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def due(session, now=None, force=False):
    now = now or datetime.now(timezone.utc)
    if session["year"] < 2026 or session["status"] == "cancelled":
        return False
    end = parse(session["starts_at"]) + timedelta(hours=DURATIONS.get(session["code"], 2))
    if now < end:
        return False
    if force:
        return True
    checked = parse(session.get("last_checked_at"))
    age = now - end
    since_check = now - checked if checked else timedelta(days=10000)
    if not session.get("artifact_path"):
        if checked is None:
            return True  # Historical backfill, one bounded batch at a time.
        if age <= timedelta(hours=48):
            return since_check >= timedelta(minutes=55)
        return age <= timedelta(days=7) and since_check >= timedelta(hours=23)
    stage = session.get("correction_stage", 0)
    if session["status"] in ("partial", "delayed") and age <= timedelta(hours=48):
        return since_check >= timedelta(minutes=55)
    return (stage < 1 and age >= timedelta(hours=24) or stage < 2 and age >= timedelta(days=7)) and since_check >= timedelta(hours=23)


def correction_stage(session, now=None):
    now = now or datetime.now(timezone.utc)
    age = now - (parse(session["starts_at"]) + timedelta(hours=DURATIONS.get(session["code"], 2)))
    return 2 if age >= timedelta(days=7) else 1 if age >= timedelta(hours=24) else 0

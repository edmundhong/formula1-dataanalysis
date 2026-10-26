"""Private, immutable worker checkpoints. Only the parent has storage credentials."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
from urllib.request import Request, urlopen

MAX_BYTES = 48 * 1024 * 1024
MAX_EXPANDED = 600 * 1024 * 1024
FILES = re.compile(r"^(state|session|artifact|uploaded|diagnostics|meta-[a-z_]+|verify-[a-z_]+|driver-\d+|window-\d+-\d+-[a-z_]+|[a-f0-9]{20}\.telemetry-\d{4}|telemetry-\d{4})\.json$")


def request(path, data=None, method=None, content_type="application/json"):
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = Request(os.environ["SUPABASE_URL"].rstrip("/") + "/storage/v1/" + path, data=data, method=method,
                  headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": content_type})
    with urlopen(req, timeout=25) as response:
        payload = response.read(MAX_BYTES + 1)
        if len(payload) > MAX_BYTES:
            raise ValueError("Checkpoint exceeds limit")
        return payload


def pack(folder):
    # Once the immutable artifact exists, publication resumes from its chunks.
    # Driver/window caches duplicate those traces and can double race archives
    # beyond MAX_BYTES. Keep metadata for source revalidation; if it changes,
    # prepare() invalidates the artifact and downloads fresh traces.
    published_output = (Path(folder) / "artifact.json").is_file()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        expanded = 0
        for p in sorted(Path(folder).iterdir()):
            if p.is_file() and not p.is_symlink() and FILES.fullmatch(p.name):
                if published_output and re.fullmatch(r"(?:driver-\d+|window-\d+-\d+-[a-z_]+|telemetry-\d{4})\.json", p.name):
                    continue
                expanded += p.stat().st_size
                if expanded > MAX_EXPANDED:
                    raise ValueError("Expanded checkpoint exceeds limit")
                archive.add(p, arcname=p.name, recursive=False)
    payload = output.getvalue()
    if len(payload) > MAX_BYTES:
        raise ValueError("Checkpoint exceeds limit")
    return payload


def unpack(payload, folder):
    if len(payload) > MAX_BYTES:
        raise ValueError("Checkpoint exceeds limit")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        expanded = 0
        for member in archive:
            if not member.isfile() or not FILES.fullmatch(member.name):
                raise ValueError("Invalid checkpoint member")
            expanded += member.size
            if expanded > MAX_EXPANDED:
                raise ValueError("Expanded checkpoint exceeds limit")
            with archive.extractfile(member) as source:
                Path(folder, member.name).write_bytes(source.read())


def restore(checkpoint, folder):
    path = checkpoint["path"]
    if not re.fullmatch(r"2026-\d{2}-(?:FP[123]|Q|SQ|S|R)/[a-f0-9-]{36}/[a-f0-9]{64}\.tar\.gz", path):
        raise ValueError("Invalid checkpoint path")
    payload = request("object/authenticated/analysis-checkpoints/" + path)
    if hashlib.sha256(payload).hexdigest() != checkpoint["sha256"]:
        raise ValueError("Checkpoint checksum mismatch")
    unpack(payload, folder)


def save(job, folder, rpc, release=True):
    from .openf1 import read_json
    payload = pack(folder)
    sha = hashlib.sha256(payload).hexdigest()
    path = f"{job['session']['id']}/{job['lease_token']}/{sha}.tar.gz"
    state = read_json(Path(folder, "state.json"), {})
    reservation = {"p_session": job["session"]["id"], "p_lease": job["lease_token"], "p_bytes": len(payload)}
    if not rpc("reserve_analysis_checkpoint", reservation):
        raise RuntimeError("Checkpoint capacity or lease unavailable")
    try:
        request("object/analysis-checkpoints/" + path, payload, "POST", "application/gzip")
    except Exception as exc:
        # Re-saving identical state is idempotent; only accept actual conflicts.
        if getattr(exc, "code", None) != 409:
            raise
    result = rpc("checkpoint_analysis", {**reservation, "p_path": path, "p_sha256": sha,
                 "p_progress": state.get("progress", {}), "p_cooldown": state.get("cooldown_until", 0),
                 "p_release": release, "p_source": state.get("source", {})})
    if not result:
        raise RuntimeError("Checkpoint lease lost")
    return result


def cleanup(rpc):
    # DB returns only unreferenced objects older than the maximum lease, plus
    # expired checkpoints. Storage deletion happens via its API, never SQL.
    paths = rpc("expired_analysis_checkpoints") or []
    for offset in range(0, len(paths), 100):
        request("object/analysis-checkpoints", json.dumps({"prefixes": paths[offset:offset + 100]}).encode(), "DELETE")

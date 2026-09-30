"""Copy the production publisher, replacing only destination names and expiry."""
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / ".local" / "probe-publisher" / "supabase"


def main():
    function = TARGET / "functions" / "ingest-probe-20260928"
    shared = TARGET / "functions" / "_shared"
    function.mkdir(parents=True, exist_ok=True)
    shared.mkdir(exist_ok=True)
    source = (ROOT / "supabase/functions/ingest/index.ts").read_text()
    for original, isolated in [("sessions", "probe20260928_sessions"), ("ingestion_jobs", "probe20260928_jobs"), ("ingestion_state", "probe20260928_state"), ("analysis", "probe20260928-analysis")]:
        source = source.replace(f'.from("{original}")', f'.from("{isolated}")')
    source = source.replace('Deno.serve(async (req: Request) => {', f'Deno.serve(async (req: Request) => {{\n  if (Date.now() > {int((time.time() + 1800) * 1000)}) return reply({{error: "expired"}}, 404);')
    (function / "index.ts").write_text(source)
    (shared / "policy.ts").write_text((ROOT / "supabase/functions/_shared/policy.ts").read_text())
    (TARGET / "config.toml").write_text('project_id = "f1-probe"\n[functions.ingest-probe-20260928]\nverify_jwt = false\n')
    print(TARGET.parent)


if __name__ == "__main__":
    main()

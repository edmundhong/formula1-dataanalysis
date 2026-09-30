"""Local dashboard copy reading only the isolated publication destination."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / ".local" / "probe-dashboard"


def main():
    TARGET.mkdir(parents=True, exist_ok=True)
    for folder in ("app", "components", "lib"):
        shutil.copytree(ROOT / folder, TARGET / folder, dirs_exist_ok=True)
    for name in ("package.json", "tsconfig.json", "next.config.ts", "next-env.d.ts", "postcss.config.mjs"):
        shutil.copyfile(ROOT / name, TARGET / name)
    data = TARGET / "lib/data.ts"
    data.write_text(data.read_text().replace('.from("sessions")', '.from("probe20260928_sessions")').replace('.from("analysis")', '.from("probe20260928-analysis")'))
    (TARGET / ".env.local").write_text("\n".join(line for line in (ROOT / ".env.local").read_text().splitlines() if line.startswith(("NEXT_PUBLIC_SUPABASE_URL=", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="))))
    print(TARGET)


if __name__ == "__main__":
    main()

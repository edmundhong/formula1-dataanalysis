"""Build an allowlisted preview directory; never upload the working tree."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / ".local" / "vercel-probe"


def main():
    (TARGET / "api").mkdir(parents=True, exist_ok=True)
    (TARGET / "pipeline").mkdir(exist_ok=True)
    shutil.copyfile(Path(__file__).with_name("handler.py"), TARGET / "api" / "ingestion-probe.py")
    for name in ("__init__.py", "ingest.py", "analysis.py", "scheduler.py", "probe.py"):
        shutil.copyfile(ROOT / "pipeline" / name, TARGET / "pipeline" / name)
    requirements = (ROOT / "pipeline" / "requirements.txt").read_text().splitlines()
    excluded = {"pytest", "iniconfig", "pluggy", "Pygments"}
    (TARGET / "requirements.txt").write_text("\n".join(r for r in requirements if r.split("==")[0] not in excluded) + "\n")
    (TARGET / ".python-version").write_text("3.12\n")
    (TARGET / "vercel.json").write_text(json.dumps({"framework": None, "buildCommand": "", "installCommand": "", "outputDirectory": "public", "regions": ["iad1"], "functions": {"api/ingestion-probe.py": {"maxDuration": 300}}}, indent=2))
    (TARGET / "public").mkdir(exist_ok=True)
    (TARGET / "public" / "index.html").write_text("Private FastF1 feasibility experiment. No public data API.")
    (TARGET / ".vercel").mkdir(exist_ok=True)
    shutil.copyfile(ROOT / ".vercel" / "project.json", TARGET / ".vercel" / "project.json")
    print(TARGET)


if __name__ == "__main__":
    main()

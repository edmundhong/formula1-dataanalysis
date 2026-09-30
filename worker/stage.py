"""Produce a deployable worker directory without unrelated files or secrets."""
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / ".local" / "production-worker"


def main():
    (TARGET / "api").mkdir(parents=True, exist_ok=True)
    (TARGET / "pipeline").mkdir(exist_ok=True)
    shutil.copyfile(ROOT / "worker/api/analysis.py", TARGET / "api/analysis.py")
    for name in ("__init__.py", "worker.py", "ingest.py", "analysis.py", "scheduler.py"):
        shutil.copyfile(ROOT / "pipeline" / name, TARGET / "pipeline" / name)
    excluded = {"pytest", "iniconfig", "pluggy", "Pygments"}
    requirements = (ROOT / "pipeline/requirements.txt").read_text().splitlines()
    (TARGET / "requirements.txt").write_text("\n".join(r for r in requirements if r.split("==")[0] not in excluded) + "\n")
    (TARGET / ".python-version").write_text("3.12\n")
    (TARGET / "vercel.json").write_text(json.dumps({"framework": None, "buildCommand": "", "installCommand": "", "outputDirectory": "public", "regions": ["iad1"], "functions": {"api/analysis.py": {"maxDuration": 300}}}, indent=2))
    (TARGET / "public").mkdir(exist_ok=True)
    (TARGET / "public/index.html").write_text("F1 analysis worker")
    print(TARGET)


if __name__ == "__main__":
    main()

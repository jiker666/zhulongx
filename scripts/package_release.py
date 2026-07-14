#!/usr/bin/env python3
"""
Create CyberPilot submission package with standard-library zipfile.
"""
from __future__ import annotations

import hashlib
import os
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PACKAGE_NAME = "cyberpilot-finalops-v4-submission.zip"
TOP = "cyberpilot"
EXCLUDED_DIRS = {
    ".git", ".agents", ".claude", ".codex", ".skills",
    "node_modules", "__pycache__", ".pytest_cache", "dist", "backups",
    "ctf_runs", "vendor", "data",
}
EXCLUDED_NAMES = {".DS_Store", ".env"}
EXCLUDED_SUFFIXES = {".pyc"}
FORBIDDEN_ZIP_PARTS = {
    "node_modules",
    ".git",
    "__pycache__",
    ".pytest_cache",
    "__MACOSX",
    "backups",
    "ctf_runs",
    "evaluator",
    "vendor",
    ".skills",
    "data",
}
REQUIRED = [
    "README.md",
    "VERSION",
    ".env.example",
    "Makefile",
    "podman-compose.yml",
    "docker-compose.yml",
    "backend",
    "frontend",
    "docs",
    "samples",
]


def excluded(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    parts = rel.parts
    if any(part in EXCLUDED_DIRS or part == "__MACOSX" for part in parts):
        return True
    if "evaluator" in parts:
        return True
    if path.name in EXCLUDED_NAMES:
        return True
    if path.suffix in EXCLUDED_SUFFIXES:
        return True
    if len(parts) >= 2 and parts[0] == "data" and path.suffix == ".db":
        return True
    if parts[:2] == ("backend", "data"):
        return True
    if len(parts) >= 4 and parts[:4] == ("backend", "app", "storage", "uploads"):
        return True
    if len(parts) >= 4 and parts[:4] == ("backend", "app", "storage", "reports"):
        return True
    if parts[:2] == ("frontend", "dist"):
        return True
    return False


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    missing = [item for item in REQUIRED if not (ROOT / item).exists()]
    if missing:
        raise SystemExit(f"missing required release inputs: {missing}")

    DIST.mkdir(exist_ok=True)
    package_path = DIST / PACKAGE_NAME
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or excluded(path):
            continue
        files.append(path)

    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(files):
            rel = path.relative_to(ROOT)
            arcname = str(Path(TOP) / rel)
            if any(part in FORBIDDEN_ZIP_PARTS for part in Path(arcname).parts):
                raise SystemExit(f"forbidden path would be packaged: {arcname}")
            if arcname.endswith(".env") or arcname.endswith(".db") or "storage/uploads" in arcname or "storage/reports" in arcname:
                raise SystemExit(f"forbidden file would be packaged: {arcname}")
            zf.write(path, arcname)

    sums = DIST / "SHA256SUMS"
    sums.write_text(f"{sha256(package_path)}  {PACKAGE_NAME}\n", encoding="utf-8")
    print(f"created {package_path.relative_to(ROOT)}")
    print(f"created {sums.relative_to(ROOT)}")
    print(f"packaged files: {len(files)}")
    for prefix in ["docs", "samples", "backend/tests", "scripts"]:
        count = sum(1 for p in files if str(p.relative_to(ROOT)).startswith(prefix))
        print(f"  {prefix}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

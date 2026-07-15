#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import re
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARCHIVE = ROOT / "dist" / "cyberpilot-finalops-v4-submission.zip"
FORBIDDEN_PARTS = {
    ".git",
    ".skills",
    ".agent_state",
    ".agent_subagents",
    ".agent_artifacts",
    "__macosx",
    "__pycache__",
    ".pytest_cache",
    "node_modules",
    "ctf_runs",
    "evaluator",
    "hidden",
    "results",
}
FORBIDDEN_NAMES = {
    ".env",
    "benchmark_results.json",
    "provider_transcript.json",
    "runtime_config.json",
    "runtime_config_audit.jsonl",
}
REQUIRED_ENTRIES = {
    "cyberpilot/docs/refactor_glm52/00-baseline.md",
    "cyberpilot/docs/refactor_glm52/01-architecture.md",
    "cyberpilot/docs/refactor_glm52/02-glm52-protocol.md",
    "cyberpilot/docs/refactor_glm52/03-migration-plan.md",
    "cyberpilot/docs/refactor_glm52/04-verification-report.md",
    "cyberpilot/docs/refactor_glm52/05-live-model-eval.md",
}
SECRET_PATTERNS = {
    "OpenAI-style key": re.compile(rb"sk-[A-Za-z0-9_-]{20,}"),
    "GitHub token": re.compile(rb"gh[pousr]_[A-Za-z0-9]{20,}"),
    "AWS access key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "private key": re.compile(rb"BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY"),
}
PLACEHOLDER_MARKERS = (b"example", b"placeholder", b"replace_me", b"abcdefghijk")
OPENAI_FIXTURE_PREFIXES = ("cyberpilot/backend/tests/", "cyberpilot/examples/")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def forbidden_path(name: str) -> str | None:
    path = PurePosixPath(name)
    lowered = tuple(part.lower() for part in path.parts)
    if any(part in FORBIDDEN_PARTS for part in lowered):
        return "forbidden directory"
    if path.name.lower() in FORBIDDEN_NAMES:
        return "forbidden runtime file"
    if path.name.lower().startswith(("expected_flag", "expected_answer")):
        return "expected answer file"
    if path.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".pyc"}:
        return "runtime or cache suffix"
    return None


def check_secrets(archive: zipfile.ZipFile, names: list[str]) -> list[str]:
    findings: list[str] = []
    for name in names:
        info = archive.getinfo(name)
        if info.file_size > 5 * 1024 * 1024:
            continue
        suffix = PurePosixPath(name).suffix.lower()
        if suffix in {".png", ".jpg", ".jpeg", ".gif", ".zip", ".gz", ".bin", ".pcap"}:
            continue
        content = archive.read(info)
        for label, pattern in SECRET_PATTERNS.items():
            if label == "OpenAI-style key" and name.startswith(OPENAI_FIXTURE_PREFIXES):
                continue
            for match in pattern.finditer(content):
                value = match.group(0).lower()
                if any(marker in value for marker in PLACEHOLDER_MARKERS):
                    continue
                findings.append(f"{name}: {label}")
                break
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan a ZHULONG-X release archive and checksum.")
    parser.add_argument("archive", nargs="?", default=str(DEFAULT_ARCHIVE))
    parser.add_argument("--sums", default="")
    args = parser.parse_args()
    archive_path = Path(args.archive).expanduser().resolve()
    sums_path = Path(args.sums).expanduser().resolve() if args.sums else archive_path.with_name("SHA256SUMS")
    failures: list[str] = []
    if not archive_path.is_file():
        failures.append(f"archive is missing: {archive_path}")
    else:
        with zipfile.ZipFile(archive_path) as archive:
            corrupt = archive.testzip()
            if corrupt:
                failures.append(f"corrupt entry: {corrupt}")
            names = archive.namelist()
            failures.extend(
                f"{name}: {reason}"
                for name in names
                if (reason := forbidden_path(name)) is not None
            )
            failures.extend(f"missing required entry: {name}" for name in sorted(REQUIRED_ENTRIES - set(names)))
            failures.extend(check_secrets(archive, names))
    digest = sha256(archive_path) if archive_path.is_file() else ""
    if not sums_path.is_file():
        failures.append(f"checksum file is missing: {sums_path}")
    else:
        expected_line = f"{digest}  {archive_path.name}"
        if sums_path.read_text(encoding="utf-8").strip() != expected_line:
            failures.append("SHA256SUMS does not match the archive")
    if failures:
        print("release archive check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"release archive check passed: {archive_path.name}")
    print(f"sha256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

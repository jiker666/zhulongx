#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "safety_audit_report.md"
SKIP_DIRS = {".git", "node_modules", "dist", "__pycache__", ".pytest_cache", "frontend/dist", "backups", "ctf_runs"}
SECRET_RE = re.compile(r"(sk-[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY)")
DANGEROUS = [
    "reverse shell", "/bin/sh -i", "nc -e", "meterpreter", "msfvenom", "mimikatz", "hydra",
    "sqlmap", "masscan", "nmap -A", "rm -rf", "chmod +s", "crontab",
]
NETWORK_RE = re.compile(r"(?<![\w.])(requests|httpx|aiohttp)\.")
NETWORK_ALLOW = {
    "backend/app/agent_engine/tools/builtin/http.py",
    "backend/app/tools/http_fingerprint.py",
    "backend/app/tools/directory_probe.py",
    "backend/app/tools/js_interface_extractor.py",
    "backend/app/tools/http_replay.py",
    "backend/app/tools/api_runner.py",
    "backend/app/core/ctf_web_solver.py",
    "backend/app/core/agent_runtime.py",
    "backend/app/core/ctf_agent_orchestrator.py",
    "backend/app/core/llm_adapter.py",
    "backend/app/core/llm_client.py",
    "backend/app/core/worker_client.py",
    "backend/app/tools/web_fetch.py",
    "backend/app/tools/web_search.py",
    "backend/scripts/dasctf_batch.py",
}
NETWORK_ALLOW_PREFIXES = ("backend/app/agent_engine/providers/",)
DOC_PREFIXES = ("docs/", "samples/", "backend/tests/", "backend/app/skills/", "safety_audit_report.md")


def skip(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in SKIP_DIRS for part in rel.parts):
        return True
    if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".db", ".zip", ".pcap", ".bin"}:
        return True
    return False


def is_doc_context(rel: str) -> bool:
    return rel.startswith(DOC_PREFIXES)


def audit_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if result.returncode == 0:
        return [
            path
            for raw in result.stdout.split(b"\0")
            if raw and (path := ROOT / raw.decode("utf-8", errors="surrogateescape")).is_file()
        ]
    return [path for path in ROOT.rglob("*") if path.is_file()]


def main() -> int:
    failures: list[str] = []
    warnings: list[str] = []
    for path in audit_files():
        if skip(path):
            continue
        rel = str(path.relative_to(ROOT))
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in SECRET_RE.finditer(text):
            value = match.group(0)
            if "sk-example-placeholder" in value or is_doc_context(rel):
                warnings.append(f"{rel}: documented/fixture secret pattern")
            else:
                failures.append(f"{rel}: possible secret {value[:20]}")
        for term in DANGEROUS:
            if term.lower() not in text.lower():
                continue
            if is_doc_context(rel) or rel == "scripts/safety_audit.py":
                warnings.append(f"{rel}: documented/fixture dangerous term `{term}`")
            elif term == "rm -rf" and (rel == "Makefile" or rel.endswith("Dockerfile")):
                warnings.append(f"{rel}: constrained cleanup/build command `{term}`")
            elif term in {"sqlmap", "masscan"} and rel == "backend/app/tools/log_analyzer.py":
                warnings.append(f"{rel}: suspicious UA detection term `{term}`")
            elif rel == "backend/app/core/code_execution_sandbox.py":
                warnings.append(f"{rel}: sandbox deny/allow-list term `{term}`")
            elif "core/safety.py" in rel or "core/policy_engine.py" in rel:
                warnings.append(f"{rel}: deny-list term `{term}`")
            else:
                failures.append(f"{rel}: dangerous implementation term `{term}`")
        if NETWORK_RE.search(text) and rel != "scripts/safety_audit.py":
            if is_doc_context(rel):
                warnings.append(f"{rel}: documented/fixture network client usage")
            elif rel not in NETWORK_ALLOW and not rel.startswith(NETWORK_ALLOW_PREFIXES):
                failures.append(f"{rel}: network client usage outside approved ScopeGuard/LLM modules")

    package_findings = check_package()
    failures.extend(package_findings)
    REPORT.write_text(render(failures, warnings), encoding="utf-8")
    print(REPORT.relative_to(ROOT))
    if failures:
        print(json.dumps({"failures": failures[:20], "warnings": len(warnings)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"failures": 0, "warnings": len(warnings)}, ensure_ascii=False))
    return 0


def check_package() -> list[str]:
    findings: list[str] = []
    package = ROOT / "dist" / "cyberpilot-finalops-v4-submission.zip"
    legacy = ROOT / "dist" / "cyberpilot-v3-submission.zip"
    target = package if package.exists() else legacy
    if not target.exists():
        return []
    forbidden_parts = {"node_modules", ".git", "backups", "ctf_runs", "evaluator"}
    forbidden_suffixes = ("/.env", "cyberpilot.db")
    forbidden_substrings = ("storage/uploads", "storage/reports")
    with zipfile.ZipFile(target) as zf:
        for name in zf.namelist():
            parts = set(Path(name).parts)
            if parts.intersection(forbidden_parts):
                findings.append(f"package contains forbidden path: {name}")
                continue
            if any(name.endswith(term) for term in forbidden_suffixes) or any(term in name for term in forbidden_substrings):
                findings.append(f"package contains forbidden path: {name}")
    if legacy.exists() and package.exists():
        pass
    return findings


def render(failures: list[str], warnings: list[str]) -> str:
    lines = ["# Safety Audit Report", "", f"- Failures: {len(failures)}", f"- Warnings: {len(warnings)}", ""]
    lines.append("## Failures")
    lines.extend([f"- {item}" for item in failures] or ["- None"])
    lines.append("\n## Warnings")
    lines.extend([f"- {item}" for item in warnings] or ["- None"])
    lines.append("\n## Policy")
    lines.append("Documentation and fixtures may mention prohibited techniques only as denied behavior or sample log indicators. Implementation code must not add offensive capabilities or bypass ScopeGuard.")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())

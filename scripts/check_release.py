#!/usr/bin/env python3
"""
Release hygiene checks for CyberPilot.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_TRACKED = re.compile(r"(\.DS_Store|__MACOSX|node_modules|cyberpilot\.db|\.env$|storage/reports|storage/uploads|^backups/|^ctf_runs/|^backend/data/|^backend/vendor/|^\.skills/)")
LOCAL_ARTIFACTS = [
    ".DS_Store",
    ".env",
    "backend/.env",
    "data/cyberpilot.db",
    "backend/data",
    "backend/vendor/claude-code",
    "frontend/node_modules",
    ".skills",
    "backups",
    "ctf_runs",
]
SKIP_DIRS = {".git", ".skills", "vendor", "node_modules", "dist", "__pycache__", ".pytest_cache", "backups", "ctf_runs"}
SKIP_PARTS = {
    ("backend", "app", "storage", "reports"),
    ("backend", "app", "storage", "uploads"),
}
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY"),
]
ASSIGNMENT = re.compile(r"(?i)\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*['\"]?([^'\"\s#]+)")
ALLOWED_VALUES = {"replace_me", "your-api-key", "sk-example-placeholder", "example", "changeme", "false", "true", "none", "null", ""}
REQUIRED_DOCS = [
    "README.md",
    "docs/refactor/00-current-architecture.md",
    "docs/refactor/01-target-architecture.md",
    "docs/refactor/02-migration-plan.md",
    "docs/refactor/03-secret-rotation.md",
    "docs/refactor/05-agent-engine-v3-adr.md",
    "docs/refactor/07-provider-tool-protocol.md",
    "docs/refactor/08-scenario-workflows.md",
    "docs/refactor/09-threat-model.md",
    "docs/refactor/10-legacy-runtime-migration.md",
    "docs/refactor/11-operator-guide.md",
    "docs/refactor/12-verification-report.md",
    "docs/architecture_v3.md",
    "docs/security_boundary.md",
    "docs/developer_guide.md",
    "docs/evaluation_plan.md",
    "docs/demo_script.md",
    "docs/test_report.md",
    "docs/final_ops_runbook.md",
    "docs/team_sop.md",
    "docs/failure_playbook.md",
    "docs/range_onboarding.md",
    "docs/presentation_pack.md",
]


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def in_git_repo() -> bool:
    return run(["git", "rev-parse", "--is-inside-work-tree"]).returncode == 0


def check_tracked_files() -> list[str]:
    if not in_git_repo():
        print("WARN: 当前目录不是 git 仓库，跳过 git tracked 文件检查")
        return []
    result = run(["git", "ls-files"])
    offenders = [
        line for line in result.stdout.splitlines()
        if FORBIDDEN_TRACKED.search(line) and Path(line).name != ".gitkeep"
    ]
    if offenders:
        print("FAIL: 禁止提交的文件仍被 git 跟踪:")
        for item in offenders:
            print(f"  - {item}")
    return offenders


def check_local_artifacts() -> None:
    found = [path for path in LOCAL_ARTIFACTS if (ROOT / path).exists()]
    if found:
        print("WARN: 本地存在运行/隐私文件，打包脚本会排除，不会自动删除:")
        for item in found:
            print(f"  - {item}")


def should_skip(path: Path) -> bool:
    parts = path.relative_to(ROOT).parts
    if any(part in SKIP_DIRS for part in parts):
        return True
    for skip in SKIP_PARTS:
        if parts[: len(skip)] == skip:
            return True
    if path.suffix.lower() in {".db", ".png", ".jpg", ".jpeg", ".gif", ".zip"}:
        return True
    return False


def check_secrets() -> list[str]:
    findings: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or should_skip(path):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        rel = path.relative_to(ROOT)
        rel_text = str(rel)
        for pattern in SECRET_PATTERNS:
            for match in pattern.finditer(text):
                value = match.group(0)
                if "sk-example-placeholder" in value:
                    continue
                if rel_text.startswith(("backend/tests/", "examples/")):
                    continue
                findings.append(f"{rel}: sensitive pattern {value[:32]}")
        assignment_scan = path.suffix.lower() in {".env", ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg"} or path.name.startswith(".env")
        for match in ASSIGNMENT.finditer(text) if assignment_scan else ():
            value = match.group(2).strip().strip("'\"")
            lower = value.lower()
            if lower in ALLOWED_VALUES or value.startswith("${") or "replace_me" in lower or "sk-example-placeholder" in lower:
                continue
            if value.startswith(("settings.", "os.environ", "process.env")):
                continue
            if len(value) >= 16 and not value.startswith("http://") and not value.startswith("https://"):
                findings.append(f"{rel}: possible secret assignment for {match.group(1)}")
    if findings:
        print("FAIL: 检测到疑似真实密钥/敏感值:")
        for item in findings:
            print(f"  - {item}")
    else:
        print("OK: 未发现真实密钥特征，仅允许占位符")
    return findings


def check_docs() -> list[str]:
    missing = [doc for doc in REQUIRED_DOCS if not (ROOT / doc).exists()]
    if missing:
        print("FAIL: 缺少必要文档:")
        for doc in missing:
            print(f"  - {doc}")
    readme = (ROOT / "README.md").read_text(encoding="utf-8", errors="ignore")
    required_readme_terms = [
        "ZHULONG-X",
        "AgentSession",
        "make release-check",
        "make safety-audit",
        "ScopeGuard",
        "cyberpilot-finalops-v4-submission.zip",
    ]
    missing_terms = [term for term in required_readme_terms if term not in readme]
    for term in missing_terms:
        missing.append(f"README missing term: {term}")
    if not (ROOT / "VERSION").exists():
        missing.append("VERSION")
    if not missing:
        print("OK: README/docs/VERSION 基础检查通过")
    return missing


def check_runtime_authority() -> list[str]:
    formal_files = list((ROOT / "backend" / "app" / "api").glob("*.py")) + [
        ROOT / "backend" / "app" / "main.py",
        ROOT / "backend" / "app" / "agent_engine" / "service.py",
        ROOT / "backend" / "app" / "scenarios" / "ctf" / "service.py",
    ]
    forbidden = (
        "app.core.ctf_agent_orchestrator",
        "app.core.agent_runtime",
        "app.core.cc_bridge_runtime",
    )
    findings: list[str] = []
    for path in formal_files:
        source = path.read_text(encoding="utf-8", errors="ignore")
        for module in forbidden:
            if module in source:
                findings.append(f"formal runtime import in {path.relative_to(ROOT)}: {module}")
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8", errors="ignore")
    if "CC_RUNTIME_ENABLED" in env_example:
        findings.append(".env.example advertises experimental bridge selection")
    if findings:
        print("FAIL: 正式运行时权威检查失败:")
        for item in findings:
            print(f"  - {item}")
    else:
        print("OK: 正式 API 仅使用 Agent Engine v3，无旧运行时导入或默认桥接配置")
    return findings


def main() -> int:
    os.chdir(ROOT)
    failures: list[str] = []
    failures.extend(check_tracked_files())
    check_local_artifacts()
    failures.extend(check_secrets())
    failures.extend(check_docs())
    failures.extend(check_runtime_authority())
    if failures:
        print(f"release check failed: {len(failures)} issue(s)")
        return 1
    print("release check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

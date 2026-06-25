#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "ctf_runs"


def read_case_id(case_dir: Path) -> str:
    data = json.loads((case_dir / "challenge.json").read_text(encoding="utf-8"))
    return str(data.get("id") or case_dir.name)


def latest_run(case_id: str) -> Path:
    runs = sorted(RUN_ROOT.glob(f"{case_id}-*"))
    if not runs:
        raise SystemExit(f"no ctf_runs found for case id: {case_id}")
    return runs[-1]


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def audit(run_dir: Path) -> Dict[str, Any]:
    trace = _load_json(run_dir / "solve_trace.json", {})
    candidates = _load_json(run_dir / "answer_candidates.json", [])
    failures: List[str] = []
    warnings: List[str] = []
    access_log = trace.get("access_log", [])
    denied_access_log = trace.get("denied_access_log", [])
    ledger = trace.get("execution_ledger", [])
    current_run = run_dir.resolve()
    run_root = RUN_ROOT.resolve()

    if not trace:
        failures.append("missing solve_trace.json")
    if not candidates:
        failures.append("missing answer candidates")

    for item in access_log:
        path_text = str(item.get("normalized_path") or "")
        lower = path_text.lower()
        path = Path(path_text)
        if "/evaluator/" in lower or lower.endswith("/evaluator") or "expected_answer" in lower:
            failures.append(f"forbidden evaluator/expected read: {path_text}")
        if "samples/team_drill_outputs" in lower or "samples/final_drill_outputs" in lower:
            failures.append(f"forbidden sample output read: {path_text}")
        try:
            path.resolve().relative_to(run_root)
            try:
                path.resolve().relative_to(current_run)
            except ValueError:
                failures.append(f"historical ctf_runs read: {path_text}")
        except ValueError:
            pass
        if not item.get("allowed"):
            failures.append(f"denied access present in access_log: {path_text} ({item.get('reason')})")

    if denied_access_log:
        failures.append(f"denied access attempts present: {len(denied_access_log)}")
    if not trace.get("rag_disabled"):
        failures.append("rag_disabled is not true")
    if not trace.get("history_matching_disabled"):
        failures.append("history_matching_disabled is not true")
    if not trace.get("internet_search_disabled"):
        failures.append("internet_search_disabled is not true")
    if trace.get("evaluator_read_by_solver"):
        failures.append("evaluator_read_by_solver is true")
    if trace.get("historical_runs_read_by_solver"):
        failures.append("historical_runs_read_by_solver is true")
    if trace.get("any_disallowed_memory_guess"):
        failures.append("disallowed memory guess detected")

    for idx, candidate in enumerate(candidates, 1):
        evidence_ids = candidate.get("evidence_ids") or ([candidate.get("evidence_id")] if candidate.get("evidence_id") else [])
        if not evidence_ids:
            failures.append(f"candidate without evidence_id at rank {idx}: {candidate.get('candidate')}")
        if idx == 1 and candidate.get("source_type") == "llm_memory":
            failures.append("best candidate source_type is llm_memory")
        if idx == 1 and not evidence_ids:
            failures.append("best candidate has no evidence_id")

    if not ledger:
        failures.append("execution_ledger is empty")
    for item in ledger:
        if not item.get("action_id") or not item.get("action_type") or not item.get("tool_name"):
            failures.append(f"incomplete ledger item: {item}")
        if item.get("policy_decision") != "allow":
            failures.append(f"ledger policy decision is not allow: action_id={item.get('action_id')}")
        if item.get("action_type") == "mcp_tool" and "http" in str(item.get("tool_name", "")).lower():
            if item.get("allowed_by_scope_guard") is not True:
                failures.append(f"HTTP action missing ScopeGuard allow: action_id={item.get('action_id')}")

    if not trace.get("tools_used"):
        warnings.append("tools_used is empty")
    return {
        "passed": not failures,
        "failures": failures,
        "warnings": warnings,
        "run_dir": str(run_dir),
        "access_log_count": len(access_log),
        "denied_access_count": len(denied_access_log),
        "candidate_count": len(candidates),
        "ledger_count": len(ledger),
    }


def write_report(run_dir: Path, result: Dict[str, Any]) -> None:
    lines = [
        "# Solve Trace Audit",
        "",
        f"- Passed: {str(result['passed']).lower()}",
        f"- Run Dir: `{result['run_dir']}`",
        f"- Access Log Count: {result['access_log_count']}",
        f"- Denied Access Count: {result['denied_access_count']}",
        f"- Candidate Count: {result['candidate_count']}",
        f"- Ledger Count: {result['ledger_count']}",
        "",
        "## Failures",
    ]
    lines.extend([f"- {item}" for item in result["failures"]] or ["- None"])
    lines.append("")
    lines.append("## Warnings")
    lines.extend([f"- {item}" for item in result["warnings"]] or ["- None"])
    (run_dir / "audit_solve_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True)
    parser.add_argument("--run", default="latest")
    args = parser.parse_args()
    case_dir = Path(args.case).resolve()
    case_id = read_case_id(case_dir)
    run_dir = Path(args.run).resolve() if args.run and args.run != "latest" else latest_run(case_id)
    result = audit(run_dir)
    write_report(run_dir, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

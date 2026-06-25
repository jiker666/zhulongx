#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "ctf_runs"


def latest_run(case_id: str) -> Path:
    runs = sorted(RUN_ROOT.glob(f"{case_id}-*"))
    if not runs:
        raise SystemExit(f"no ctf_runs found for case id: {case_id}")
    return runs[-1]


def read_case_id(case_dir: Path) -> str:
    data = json.loads((case_dir / "challenge.json").read_text(encoding="utf-8"))
    return str(data.get("id") or case_dir.name)


def load_candidates(run_dir: Path) -> List[Dict[str, Any]]:
    path = run_dir / "answer_candidates.json"
    if not path.exists():
        raise SystemExit(f"missing answer_candidates.json: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True)
    parser.add_argument("--run", default="")
    args = parser.parse_args()
    case_dir = Path(args.case).resolve()
    expected_path = case_dir / "evaluator" / "expected_answer.txt"
    if not expected_path.exists():
        raise SystemExit(f"missing evaluator expected answer: {expected_path}")
    expected = expected_path.read_text(encoding="utf-8").strip()
    case_id = read_case_id(case_dir)
    run_dir = Path(args.run).resolve() if args.run and args.run != "latest" else latest_run(case_id)
    candidates = load_candidates(run_dir)
    evidence_path = run_dir / "evidence.json"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8")) if evidence_path.exists() else []

    best = candidates[0] if candidates else {}
    rank = 0
    for idx, item in enumerate(candidates, 1):
        if str(item.get("candidate", "")).strip() == expected:
            rank = idx
            break
    solved = rank > 0
    false_positive_count = len([c for c in candidates if str(c.get("candidate", "")).strip() and str(c.get("candidate", "")).strip() != expected])
    trace_path = run_dir / "solve_trace.json"
    trace = json.loads(trace_path.read_text(encoding="utf-8")) if trace_path.exists() else {}
    best_evidence_ids = best.get("evidence_ids") or ([best.get("evidence_id")] if best.get("evidence_id") else [])
    tools_used = trace.get("tools_used", [])
    mcp_calls_used = trace.get("mcp_calls_used", [])
    human_manual_actions = trace.get("human_manual_actions", trace.get("manual_actions", []))
    result = {
        "solved": solved,
        "expected_answer_read_by": "scripts/evaluate_ctf_case.py",
        "best_candidate": best.get("candidate", ""),
        "rank": rank,
        "confidence": best.get("confidence", 0),
        "evidence_count": len(evidence),
        "access_log_count": len(trace.get("access_log", [])),
        "denied_access_count": len(trace.get("denied_access_log", [])),
        "rag_disabled": bool(trace.get("rag_disabled", False)),
        "history_matching_disabled": bool(trace.get("history_matching_disabled", False)),
        "internet_search_disabled": bool(trace.get("internet_search_disabled", False)),
        "evaluator_read_by_solver": bool(trace.get("evaluator_read_by_solver", False)),
        "historical_runs_read_by_solver": bool(trace.get("historical_runs_read_by_solver", False)),
        "all_candidates_have_evidence": bool(trace.get("all_candidates_have_evidence", False)),
        "best_candidate_evidence_ids": best_evidence_ids,
        "tools_used": tools_used,
        "mcp_calls_used": mcp_calls_used,
        "human_manual_actions": human_manual_actions,
        "any_disallowed_memory_guess": bool(trace.get("any_disallowed_memory_guess", False)),
        "false_positive_count": false_positive_count,
        "time_cost": trace.get("time_cost_seconds", 0),
        "run_dir": str(run_dir),
    }
    lines = [
        f"# CTF Case Evaluation: {case_id}",
        "",
        f"- Solved: {str(solved).lower()}",
        f"- Best Candidate: `{result['best_candidate']}`",
        f"- Expected Rank: {rank or '(not found)'}",
        f"- Confidence: {result['confidence']}",
        f"- Evidence Count: {result['evidence_count']}",
        f"- Access Log Count: {result['access_log_count']}",
        f"- Denied Access Count: {result['denied_access_count']}",
        f"- RAG Disabled: {str(result['rag_disabled']).lower()}",
        f"- History Matching Disabled: {str(result['history_matching_disabled']).lower()}",
        f"- Internet Search Disabled: {str(result['internet_search_disabled']).lower()}",
        f"- Evaluator Read By Solver: {str(result['evaluator_read_by_solver']).lower()}",
        f"- Historical Runs Read By Solver: {str(result['historical_runs_read_by_solver']).lower()}",
        f"- All Candidates Have Evidence: {str(result['all_candidates_have_evidence']).lower()}",
        f"- Best Candidate Evidence IDs: {', '.join(result['best_candidate_evidence_ids']) or '(none)'}",
        f"- Tools Used: {', '.join(result['tools_used']) or '(none)'}",
        f"- MCP Calls Used: {len(result['mcp_calls_used'])}",
        f"- Human Manual Actions: {len(result['human_manual_actions'])}",
        f"- Any Disallowed Memory Guess: {str(result['any_disallowed_memory_guess']).lower()}",
        f"- False Positive Count: {false_positive_count}",
        f"- Time Cost: {result['time_cost']}s",
        "",
        "Evaluator is intentionally separate from solve_ctf_case.py and is the only script that reads evaluator/expected_answer.txt.",
    ]
    (run_dir / "evaluation.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if solved else 2


if __name__ == "__main__":
    raise SystemExit(main())

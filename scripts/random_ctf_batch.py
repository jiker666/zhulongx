#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parents[1]
SUMMARY = ROOT / "samples" / "random_ctf_eval_summary.md"


def _run(cmd: List[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _extract_json(text: str) -> Dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        return {}
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {}


def run_once(index: int) -> Dict[str, Any]:
    generate = _run([sys.executable, "scripts/generate_random_ctf_case.py"])
    generated = _extract_json(generate.stdout)
    solve = _run([sys.executable, "scripts/solve_ctf_case.py", "--case", "ctf_cases/generated/latest"])
    solve_json = _extract_json(solve.stdout)
    evaluate = _run([sys.executable, "scripts/evaluate_ctf_case.py", "--case", "ctf_cases/generated/latest", "--run", "latest"])
    evaluation = _extract_json(evaluate.stdout)
    audit = _run([sys.executable, "scripts/audit_solve_trace.py", "--case", "ctf_cases/generated/latest", "--run", "latest"])
    audit_json = _extract_json(audit.stdout)
    return {
        "index": index,
        "case_id": generated.get("case_id", ""),
        "generate_ok": generate.returncode == 0,
        "solve_ok": solve.returncode == 0,
        "eval_ok": evaluate.returncode == 0,
        "audit_ok": audit.returncode == 0 and bool(audit_json.get("passed")),
        "rank": evaluation.get("rank", 0),
        "solved": bool(evaluation.get("solved")),
        "best_candidate": evaluation.get("best_candidate", ""),
        "confidence": evaluation.get("confidence", 0),
        "run_dir": evaluation.get("run_dir", solve_json.get("output_dir", "")),
        "audit_failures": audit_json.get("failures", []),
        "stderr": {
            "generate": generate.stderr[-1200:],
            "solve": solve.stderr[-1200:],
            "evaluate": evaluate.stderr[-1200:],
            "audit": audit.stderr[-1200:],
        },
    }


def write_summary(rows: List[Dict[str, Any]]) -> None:
    rank1 = sum(1 for row in rows if row.get("rank") == 1)
    audit_pass = sum(1 for row in rows if row.get("audit_ok"))
    lines = [
        "# Random CTF Blind Solve Evaluation Summary",
        "",
        f"- Runs: {len(rows)}",
        f"- Rank1 Hits: {rank1}/{len(rows)}",
        f"- Audit Pass: {audit_pass}/{len(rows)}",
        "",
        "| # | Case | Solved | Rank | Confidence | Audit | Run Dir |",
        "|---|---|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['index']} | `{row.get('case_id')}` | {str(row.get('solved')).lower()} | "
            f"{row.get('rank') or 0} | {row.get('confidence')} | {str(row.get('audit_ok')).lower()} | `{row.get('run_dir')}` |"
        )
    failures = [row for row in rows if row.get("rank") != 1 or not row.get("audit_ok")]
    lines.extend(["", "## Failures"])
    if failures:
        for row in failures:
            lines.append(f"- #{row['index']} {row.get('case_id')}: rank={row.get('rank')} audit_ok={row.get('audit_ok')} audit_failures={row.get('audit_failures')}")
    else:
        lines.append("- None")
    SUMMARY.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    rows = [run_once(i) for i in range(1, 6)]
    write_summary(rows)
    rank1 = sum(1 for row in rows if row.get("rank") == 1)
    audit_ok = all(row.get("audit_ok") for row in rows)
    result = {"summary": str(SUMMARY), "rank1": rank1, "runs": len(rows), "audit_ok": audit_ok}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if rank1 >= 4 and audit_ok else 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Tuple


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.config import settings  # noqa: E402
from app.core.candidate_policy import enforce_candidate_evidence_policy  # noqa: E402
from app.core.rag_kill_switch import rag_kill_switch  # noqa: E402
from app.core.solve_access_guard import (  # noqa: E402
    SolveAccessDenied,
    SolveAccessGuard,
    reset_active_solve_guard,
    set_active_solve_guard,
)
from app.core.tool_execution_ledger import ToolExecutionLedger  # noqa: E402


RUN_ROOT = ROOT / "ctf_runs"
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def now_name() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def apply_scope(scope_env: str) -> None:
    for key, value in parse_scope_env(scope_env).items():
        if not hasattr(settings, key):
            continue
        current = getattr(settings, key)
        if isinstance(current, bool):
            setattr(settings, key, value.lower() in {"1", "true", "yes", "on"})
        elif isinstance(current, int):
            try:
                setattr(settings, key, int(value))
            except ValueError:
                pass
        else:
            setattr(settings, key, value)


def parse_scope_env(scope_env: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for raw in scope_env.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


def load_case(case_dir: Path, guard: SolveAccessGuard) -> tuple[Dict[str, Any], str, str]:
    challenge_path = case_dir / "challenge.json"
    readme_path = case_dir / "README.md"
    scope_path = case_dir / "scope.env.example"
    if not challenge_path.exists():
        raise SystemExit(f"missing challenge.json: {challenge_path}")
    challenge = json.loads(guard.read_text(challenge_path, tool_name="solve_ctf_case"))
    readme = guard.read_text(readme_path, tool_name="solve_ctf_case") if readme_path.exists() else ""
    scope_env = guard.read_text(scope_path, tool_name="solve_ctf_case") if scope_path.exists() else ""
    validate_agent_readable_paths(case_dir, challenge)
    return challenge, readme, scope_env


def validate_agent_readable_paths(case_dir: Path, challenge: Dict[str, Any]) -> None:
    for rel in [Path(item) for item in challenge.get("attachments", [])]:
        if rel.is_absolute() or ".." in rel.parts or "evaluator" in [part.lower() for part in rel.parts]:
            raise SystemExit(f"invalid attachment path: {rel}")
        if not (case_dir / rel).exists():
            raise SystemExit(f"missing attachment: {case_dir / rel}")
    for child in case_dir.iterdir():
        if child.name in {"attachments", "evaluator", "challenge.json", "README.md", "scope.env.example"}:
            continue
        lower = child.name.lower()
        if any(term in lower for term in ("expected_answer", "solution", "writeup", "solves")):
            raise SystemExit(f"forbidden agent-readable path: {child}")


def collect_inputs(case_dir: Path, challenge: Dict[str, Any], guard: SolveAccessGuard) -> tuple[List[str], List[Tuple[str, bytes | str]]]:
    attachments: List[str] = []
    inputs: List[Tuple[str, bytes | str]] = []
    for rel_text in challenge.get("attachments", []):
        path = (case_dir / rel_text).resolve(strict=False)
        data = guard.read_bytes(path, tool_name="solve_ctf_case", max_bytes=MAX_ATTACHMENT_BYTES)
        attachments.append(str(path))
        inputs.append((f"attachment:{Path(rel_text).name}", data))
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as zf:
                for info in zf.infolist()[:80]:
                    if info.is_dir() or info.file_size > MAX_ATTACHMENT_BYTES:
                        continue
                    try:
                        guard.validate_archive_member(path, info.filename, tool_name="solve_ctf_case")
                    except SolveAccessDenied:
                        continue
                    inputs.append((f"zip:{info.filename}", zf.read(info)[:MAX_ATTACHMENT_BYTES]))
    inputs.extend([
        ("challenge_description", challenge.get("description", "")),
        ("author_notes", challenge.get("author_notes", "")),
    ])
    return attachments, inputs


def create_challenge(challenge: Dict[str, Any], attachments: List[str]) -> int:
    from fastapi.testclient import TestClient  # noqa: E402
    from app.main import app  # noqa: E402

    with TestClient(app) as client:
        payload = {
            "name": challenge.get("title") or challenge.get("id") or "CTF Case",
            "challenge_type": challenge.get("category") or "unknown",
            "description": challenge.get("description") or "",
            "target": challenge.get("target_url") or challenge.get("target_host") or "",
            "uploaded_file": attachments[0] if attachments else "",
            "tags": ["ctf-case", str(challenge.get("id") or "")],
            "priority": "high",
            "assignee": "agent",
        }
        created = client.post("/api/challenges", json=payload)
        if created.status_code != 200:
            raise SystemExit(created.text)
        return int(created.json()["id"])


def persist_evidence_and_candidates(
    challenge_id: int,
    source_tool: str,
    input_summary: str,
    output: str,
    candidates: List[Dict[str, Any]],
    reproduction_hint: str,
) -> str:
    from app.core.evidence_vault import evidence_vault  # noqa: E402
    from app.database import SessionLocal  # noqa: E402
    from app.models.answer_candidate import AnswerCandidate  # noqa: E402

    db = SessionLocal()
    try:
        evidence = evidence_vault.create(db, source_tool, input_summary, output, challenge_id=challenge_id, reproduction_hint=reproduction_hint)
        existing = {row.candidate: row for row in db.query(AnswerCandidate).filter(AnswerCandidate.challenge_id == challenge_id).all()}
        prepared = []
        for raw in candidates[:30]:
            item = dict(raw)
            item["evidence_id"] = evidence.evidence_uid
            item["evidence_ids"] = [evidence.evidence_uid]
            item.setdefault("source", source_tool)
            prepared.append(item)
        for raw in enforce_candidate_evidence_policy(prepared):
            value = str(raw.get("candidate") or "").strip()
            if not value:
                continue
            note = json.dumps(raw.get("decode_chain", []), ensure_ascii=False)[:2000] if raw.get("decode_chain") else ""
            confidence = float(raw.get("confidence", 0.5) or 0.5)
            if value in existing:
                row = existing[value]
                if source_tool == "CTFMiscSolver" or confidence > float(row.confidence or 0):
                    row.source = str(raw.get("source") or source_tool)[:256]
                    row.evidence = str(raw.get("evidence") or "")[:2000]
                    row.evidence_id = evidence.evidence_uid
                    row.confidence = max(confidence, float(row.confidence or 0))
                    row.why_selected = str(raw.get("why_selected") or "CTF solver candidate")[:1000]
                    row.validation_status = str(raw.get("validation_status") or "unverified")[:32]
                    row.note = note or row.note
                continue
            row = AnswerCandidate(
                challenge_id=challenge_id,
                candidate=value,
                source=str(raw.get("source") or source_tool)[:256],
                evidence=str(raw.get("evidence") or "")[:2000],
                evidence_id=evidence.evidence_uid,
                confidence=confidence,
                why_selected=str(raw.get("why_selected") or "CTF solver candidate")[:1000],
                validation_status=str(raw.get("validation_status") or "unverified")[:32],
                note=note,
            )
            db.add(row)
            existing[value] = row
        db.commit()
        return evidence.evidence_uid
    finally:
        db.close()


def fetch_challenge_state(challenge_id: int) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    from app.database import SessionLocal  # noqa: E402
    from app.models.answer_candidate import AnswerCandidate  # noqa: E402
    from app.models.evidence import Evidence  # noqa: E402

    db = SessionLocal()
    try:
        raw_candidates = [
            {
                "id": c.id,
                "candidate": c.candidate,
                "source": c.source,
                "evidence": c.evidence,
                "evidence_id": c.evidence_id,
                "evidence_ids": [c.evidence_id] if c.evidence_id else [],
                "confidence": c.confidence,
                "why_selected": c.why_selected,
                "validation_status": c.validation_status,
                "note": c.note,
            }
            for c in db.query(AnswerCandidate).filter(AnswerCandidate.challenge_id == challenge_id).all()
        ]
        candidates = enforce_candidate_evidence_policy(raw_candidates)
        evidence = [
            {
                "evidence_uid": e.evidence_uid,
                "source_tool": e.source_tool,
                "input_summary": e.input_summary,
                "output_excerpt": e.output_excerpt,
                "content_hash": e.content_hash,
                "reproduction_hint": e.reproduction_hint,
            }
            for e in db.query(Evidence).filter(Evidence.challenge_id == challenge_id).order_by(Evidence.created_at.desc()).all()
        ]
        return candidates, evidence
    finally:
        db.close()


def run_artifact_triage(challenge_id: int, challenge: Dict[str, Any], attachments: List[str], case_dir: Path) -> str:
    from app.tools.artifact_triage import ArtifactTriageTool  # noqa: E402

    result = ArtifactTriageTool().safe_run({
        "uploaded_file": attachments[0] if attachments else "",
        "file_path": attachments[0] if attachments else "",
        "challenge_type": challenge.get("category") or "unknown",
        "description": challenge.get("description") or "",
        "challenge_id": challenge_id,
    })
    details = result.get("details", {})
    return persist_evidence_and_candidates(
        challenge_id,
        "ArtifactTriageTool",
        f"case={challenge.get('id')} file={attachments[0] if attachments else '(none)'}",
        json.dumps(details, ensure_ascii=False, indent=2)[:4000],
        details.get("answer_candidates", []),
        f"Artifact triage under Blind Solve Mode for {case_dir}",
    )


def build_blind_prompt_policy() -> Dict[str, Any]:
    return {
        "no_public_writeup_or_memory_guess": True,
        "allowed_basis": ["current challenge input", "attachments", "tool output", "manual result", "current Evidence"],
        "candidate_requires_evidence_id": True,
        "missing_evidence_confidence_cap": 0.3,
        "llm_memory_candidate_policy": "mark disallowed_memory_guess and reject",
        "allow_llm_reasoning": bool(settings.ALLOW_LLM_REASONING),
        "allow_llm_public_memory_guess": bool(settings.ALLOW_LLM_PUBLIC_MEMORY_GUESS),
    }


def build_brief(challenge: Dict[str, Any], candidates: List[Dict[str, Any]], evidence: List[Dict[str, Any]], trace: Dict[str, Any], out_dir: Path) -> str:
    best = candidates[0] if candidates else {}
    best_value = best.get("candidate", "(no candidate)")
    confidence = float(best.get("confidence", 0) or 0)
    evidence_lines = []
    for item in evidence[:3]:
        evidence_lines.append(f"- {item.get('evidence_uid')}: {item.get('output_excerpt', '')[:180].replace(chr(10), ' ')}")
    if not evidence_lines:
        evidence_lines.append("- None")
    chain = []
    if best.get("note"):
        try:
            chain = json.loads(best["note"])
        except Exception:
            chain = []
    methods = [step.get("method") for step in chain if step.get("method")]
    reproduce = ["Open only the current challenge README, challenge.json, scope config, and attachments."]
    if methods:
        reproduce.append("Apply decode chain: " + " -> ".join(methods[:5]) + ".")
    reproduce.append("Extract the best flag-like string from solver output and linked Evidence.")
    reproduce.append(f"Review evidence in {out_dir / 'evidence.json'}.")
    reproduce.append("Submit only after reviewer confirmation.")
    tools = trace.get("tools_used", [])
    manual_actions = trace.get("human_manual_actions", [])
    lines = [
        f"# Challenge Brief: {challenge.get('title') or challenge.get('id')}",
        "",
        "## Best Candidate",
        str(best_value),
        "",
        "## Confidence",
        f"{confidence:.2f}",
        "",
        "## Submission",
        "- Submit Status: not_submitted",
        "",
        "## Why this is likely correct",
        *evidence_lines,
        "",
        "## How this was solved",
        "- Current materials: challenge.json, README.md, scope.env.example, and current attachments only.",
        f"- Tools/skills/MCP: {', '.join(tools or ['ArtifactTriageTool', 'CTFMiscSolver'])}.",
        "- RAG/history matching/search: not used.",
        f"- Evaluator read by solver: {str(trace.get('evaluator_read_by_solver', False)).lower()}.",
        f"- Access log entries: {len(trace.get('access_log', []))}; denied attempts: {len(trace.get('denied_access_log', []))}.",
        "",
        "## Reproduce",
    ]
    lines.extend([f"{idx}. {step}" for idx, step in enumerate(reproduce[:5], 1)])
    lines.extend([
        "",
        "## Toolchain",
        ", ".join(tools or ["ArtifactTriageTool", "CTFMiscSolver"]),
        "",
        "## Manual Actions",
        "; ".join(action.get("reason", str(action)) for action in manual_actions[:3]) or "Reviewer should confirm before platform submission.",
        "",
        "## Submit Note",
        f"建议提交：{best_value}" if candidates else "未解出：请继续人工复核附件和题面。",
        "",
        "## Risk / Uncertainty",
        "No evaluator, expected answer, RAG store, historical run, or public writeup data was read during solve.",
    ])
    if not candidates:
        lines.extend(["", "## Next Steps", "1. Inspect attachments manually. 2. Add notes to FinalOps. 3. Re-run solve-ctf."])
    return "\n".join(lines) + "\n"


def _case_id_from_path(case_dir: Path) -> str:
    return case_dir.name


def _historical_runs_read(access_log: List[Dict[str, Any]], run_dir: Path) -> bool:
    run_root = RUN_ROOT.resolve()
    current = run_dir.resolve()
    for item in access_log:
        path = Path(item.get("normalized_path") or "")
        try:
            path.relative_to(run_root)
        except ValueError:
            continue
        try:
            path.relative_to(current)
            continue
        except ValueError:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True)
    parser.add_argument("--fast", action="store_true")
    args = parser.parse_args()
    started = time.time()
    case_dir = Path(args.case).resolve()
    if not case_dir.exists():
        raise SystemExit(f"case not found: {case_dir}")

    stamp = now_name()
    preliminary_case_id = _case_id_from_path(case_dir)
    out_dir = RUN_ROOT / f"{preliminary_case_id}-{stamp}"
    guard = SolveAccessGuard(case_dir, out_dir, case_id=preliminary_case_id)
    challenge, readme, scope_env = load_case(case_dir, guard)
    case_id = str(challenge.get("id") or preliminary_case_id)
    if case_id != preliminary_case_id:
        final_dir = RUN_ROOT / f"{case_id}-{stamp}"
        final_guard = SolveAccessGuard(case_dir, final_dir, case_id=case_id)
        final_guard.access_log = list(guard.access_log)
        final_guard.denied_access_log = list(guard.denied_access_log)
        guard = final_guard
        out_dir = final_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    apply_scope(scope_env)
    rag_kill_switch.require_blind_solve_controls("solve_ctf_case")

    from app.core.ctf_misc_solver import CTFMiscSolver  # noqa: E402
    from app.core.ctf_static_solver import CTFStaticSolver  # noqa: E402
    from app.core.ctf_web_solver import CTFWebSolver  # noqa: E402
    from app.core.final_runbook import final_runbook_planner  # noqa: E402
    from app.database import init_db  # noqa: E402

    init_db()
    ledger = ToolExecutionLedger()
    guard_context = set_active_solve_guard(guard)
    web_result: Dict[str, Any] = {}
    try:
        attachments, inputs = collect_inputs(case_dir, challenge, guard)
        challenge_id = create_challenge(challenge, attachments)
        guard.challenge_id = str(challenge_id)
        ledger.record("llm_reasoning", "BlindSolvePromptPolicy", f"case={case_id}", json.dumps(build_blind_prompt_policy(), ensure_ascii=False), policy_decision="allow")
        triage_evidence_id = run_artifact_triage(challenge_id, challenge, attachments, case_dir)
        ledger.record("registered_tool", "ArtifactTriageTool", f"attachments={len(attachments)}", "artifact triage completed", triage_evidence_id, True, None, "allow")

        runbook = final_runbook_planner.build(challenge.get("category", "unknown"), challenge.get("description", ""), challenge.get("target_url", ""), {}, {}, 20)
        ledger.record("skill", "ctf-misc", f"case={case_id}", "offline recursive decoding strategy selected", "", True, None, "allow")
        misc = CTFMiscSolver(max_depth=4 if args.fast else 6, flag_format=challenge.get("flag_format", "flag{...}")).solve(inputs + [("README.md", readme)])
        misc_output = json.dumps({"summary": misc["summary"], "decode_trace": misc["decode_trace"][:40]}, ensure_ascii=False, indent=2)
        misc_evidence_id = persist_evidence_and_candidates(
            challenge_id,
            "CTFMiscSolver",
            f"case={case_id} max_depth={misc['max_depth']}",
            misc_output,
            misc["candidates"],
            f"make solve-ctf CASE={case_dir}",
        )
        ledger.record("registered_tool", "CTFMiscSolver", f"inputs={len(inputs)} max_depth={misc['max_depth']}", misc_output, misc_evidence_id, True, None, "allow")

        static = CTFStaticSolver().analyze_many(attachments)
        static_output = json.dumps(static, ensure_ascii=False, indent=2)[:4000]
        static_evidence_id = persist_evidence_and_candidates(
            challenge_id,
            "CTFStaticSolver",
            f"case={case_id} attachments={len(attachments)}",
            static_output,
            static.get("candidates", []),
            f"Static strings/hash triage for {case_dir}",
        )
        ledger.record("registered_tool", "CTFStaticSolver", f"attachments={len(attachments)}", static_output, static_evidence_id, True, None, "allow")

        if challenge.get("target_url") and (challenge.get("category") or "").lower() == "web":
            web_result = CTFWebSolver(max_requests=3 if args.fast else 6).solve(challenge["target_url"])
            for item in web_result.get("evidence", []):
                evidence_id = persist_evidence_and_candidates(
                    challenge_id,
                    "CTFWebSolver",
                    item.get("input_summary", ""),
                    item.get("output_excerpt", ""),
                    web_result.get("answer_candidates", []),
                    item.get("reproduction_hint", ""),
                )
                ledger.record("registered_tool", "CTFWebSolver", item.get("input_summary", ""), item.get("output_excerpt", ""), evidence_id, True, True, "allow")
            for request in web_result.get("requests", []):
                ledger.record("mcp_tool", "ScopeGuardHTTP", request.get("url", ""), json.dumps(request, ensure_ascii=False), "", None, bool(request.get("allowed")), "allow" if request.get("allowed") else "deny")
        else:
            static = static

        candidates, evidence = fetch_challenge_state(challenge_id)
    finally:
        reset_active_solve_guard(guard_context)

    access_trace = guard.to_trace()
    all_candidates_have_evidence = all(bool(c.get("evidence_ids")) for c in candidates)
    any_disallowed_memory_guess = any(c.get("source_type") == "llm_memory" or c.get("memory_guess_detected") for c in candidates)
    best = candidates[0] if candidates else {}
    trace = {
        "case_dir": str(case_dir),
        "challenge_id": challenge_id,
        "case_id": case_id,
        "title": challenge.get("title"),
        "category": challenge.get("category"),
        "target_url": challenge.get("target_url"),
        "attachments": attachments,
        "read_files": [item.get("normalized_path") for item in access_trace["access_log"] if item.get("allowed")],
        "forbidden_accesses": access_trace["denied_access_log"],
        "evaluator_read_by_solver": False,
        "historical_runs_read_by_solver": _historical_runs_read(access_trace["access_log"], out_dir),
        **rag_kill_switch.state(),
        "llm_prompt_policy": build_blind_prompt_policy(),
        "runbook": runbook,
        "misc_summary": misc.get("summary"),
        "static_summary": static.get("summary"),
        "web_summary": web_result.get("summary", ""),
        "manual_actions": web_result.get("manual_actions", []),
        "human_manual_actions": web_result.get("manual_actions", []),
        "time_cost_seconds": round(time.time() - started, 3),
        "output_dir": str(out_dir),
        "access_log": access_trace["access_log"],
        "denied_access_log": access_trace["denied_access_log"],
        "execution_ledger": ledger.to_list(),
        "tools_used": ledger.tools_used(),
        "mcp_calls_used": [item for item in ledger.to_list() if item.get("action_type") == "mcp_tool"],
        "all_candidates_have_evidence": all_candidates_have_evidence,
        "best_candidate_evidence_ids": best.get("evidence_ids", []),
        "best_candidate_source_type": best.get("source_type", ""),
        "any_disallowed_memory_guess": any_disallowed_memory_guess,
        "mcp_only_enforced": bool(settings.MCP_ONLY_SOLVE),
    }
    brief = build_brief(challenge, candidates, evidence, trace, out_dir)
    write_json(out_dir / "answer_candidates.json", candidates)
    write_json(out_dir / "evidence.json", evidence)
    write_json(out_dir / "solve_trace.json", trace)
    (out_dir / "brief.md").write_text(brief, encoding="utf-8")
    (out_dir / "operator_notes.md").write_text(
        "\n".join([
            f"# Operator Notes: {challenge.get('title') or case_id}",
            "",
            f"- Challenge ID: {challenge_id}",
            f"- Network target: {challenge.get('target_url') or '(none)'}",
            f"- Blind Solve Mode: {trace['blind_solve_mode']}",
            f"- RAG Disabled: {trace['rag_disabled']}",
            f"- Historical Matching Disabled: {trace['history_matching_disabled']}",
            f"- Evaluator read by solver: {trace['evaluator_read_by_solver']}",
            f"- Best candidate: {candidates[0]['candidate'] if candidates else '(none)'}",
            "- Reviewer must confirm before submission.",
        ]) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "success": True,
        "case": case_id,
        "challenge_id": challenge_id,
        "output_dir": str(out_dir),
        "best_candidate": candidates[0]["candidate"] if candidates else "",
        "candidate_count": len(candidates),
        "evidence_count": len(evidence),
        "blind_solve_mode": trace["blind_solve_mode"],
        "rag_disabled": trace["rag_disabled"],
        "history_matching_disabled": trace["history_matching_disabled"],
        "internet_search_disabled": trace["internet_search_disabled"],
        "evaluator_read_by_solver": False,
        "historical_runs_read_by_solver": trace["historical_runs_read_by_solver"],
        "all_candidates_have_evidence": all_candidates_have_evidence,
        "denied_access_count": len(trace["denied_access_log"]),
        "time_cost_seconds": trace["time_cost_seconds"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

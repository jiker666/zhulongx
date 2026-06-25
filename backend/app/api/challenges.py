"""
Final Ops challenge APIs.
"""
from __future__ import annotations

import csv
import datetime
import hashlib
import io
import json
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.answer_extractor import AnswerCandidateExtractor
from app.core.candidate_policy import enforce_candidate_evidence_policy
from app.core.evidence_vault import evidence_vault
from app.core.final_runbook import final_runbook_planner
from app.core.rag_kill_switch import rag_kill_switch
from app.core.scope_guard import scope_guard
from app.core.planner import PlanStep
from app.database import get_db
from app.models.answer_candidate import AnswerCandidate
from app.models.challenge import Challenge
from app.models.challenge_note import ChallengeNote
from app.models.evidence import Evidence
from app.models.report import Report
from app.models.step import Step
from app.models.task import Task
from app.schemas.challenge import (
    AnswerCandidateCreate,
    AnswerCandidateOut,
    AnswerCandidatePatch,
    ChallengeCreate,
    ChallengeImport,
    ChallengeNoteCreate,
    ChallengeOut,
    ChallengePatch,
    FinalOpsImportPayload,
    ManualResultCreate,
    ScopeCheckRequest,
    SubmissionCreate,
)
from app.tools.artifact_triage import ArtifactTriageTool
from app.tools.http_fingerprint import HttpFingerprintTool
from app.core.reporter import Reporter


router = APIRouter()
extractor = AnswerCandidateExtractor()


def _json_list(raw: str) -> List[str]:
    try:
        value = json.loads(raw or "[]")
        return value if isinstance(value, list) else []
    except Exception:
        return []


def _json_dict(raw: str) -> Dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _challenge_out(db: Session, challenge: Challenge) -> ChallengeOut:
    task_ids = [row[0] for row in db.query(Task.id).filter(Task.challenge_id == challenge.id).order_by(Task.id.desc()).all()]
    evidence = db.query(Evidence).filter(Evidence.challenge_id == challenge.id).order_by(Evidence.created_at.desc()).limit(50).all()
    candidates = db.query(AnswerCandidate).filter(AnswerCandidate.challenge_id == challenge.id).order_by(AnswerCandidate.confidence.desc(), AnswerCandidate.updated_at.desc()).all()
    data = {
        "id": challenge.id,
        "name": challenge.name,
        "challenge_type": challenge.challenge_type,
        "description": challenge.description or "",
        "target": challenge.target or "",
        "uploaded_file": challenge.uploaded_file or "",
        "tags": _json_list(challenge.tags),
        "priority": challenge.priority or "medium",
        "status": challenge.status or "new",
        "assignee": challenge.assignee or "",
        "reviewer": challenge.reviewer or "",
        "submitter": challenge.submitter or "",
        "submit_status": challenge.submit_status or "not_submitted",
        "submitted_answer": challenge.submitted_answer or "",
        "submitted_at": challenge.submitted_at,
        "submission_note": challenge.submission_note or "",
        "notes": challenge.notes or "",
        "latest_summary": challenge.latest_summary or "",
        "next_suggestion": challenge.next_suggestion or "",
        "confidence": challenge.confidence or "0.0",
        "runbook": _json_dict(challenge.runbook_json),
        "task_ids": task_ids,
        "evidence": evidence,
        "answer_candidates": candidates,
        "created_at": challenge.created_at,
        "updated_at": challenge.updated_at,
    }
    return ChallengeOut.model_validate(data)


def _set_fields(challenge: Challenge, payload: ChallengePatch | ChallengeCreate) -> None:
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        if key == "tags":
            challenge.tags = json.dumps(value or [], ensure_ascii=False)
        elif hasattr(challenge, key):
            setattr(challenge, key, value)
    challenge.updated_at = datetime.datetime.utcnow()


@router.post("/scope/check")
def scope_check(payload: ScopeCheckRequest):
    decision = scope_guard.validate_url(payload.url)
    return {
        "allowed": decision.allowed,
        "reason": decision.reason,
        "matched_rule": decision.matched_scope,
        "normalized_target": decision.normalized_url,
        "resolved_ip_summary": decision.resolved_ips or [],
        "host": decision.host,
        "port": decision.port,
        "competition_mode": decision.competition_mode,
    }


@router.get("/challenges", response_model=List[ChallengeOut])
def list_challenges(status: str = "", challenge_type: str = "", assignee: str = "", db: Session = Depends(get_db)):
    query = db.query(Challenge)
    if status:
        query = query.filter(Challenge.status == status)
    if challenge_type:
        query = query.filter(Challenge.challenge_type == challenge_type)
    if assignee:
        query = query.filter(Challenge.assignee == assignee)
    challenges = query.order_by(Challenge.updated_at.desc()).all()
    return [_challenge_out(db, item) for item in challenges]


@router.post("/challenges", response_model=ChallengeOut)
def create_challenge(payload: ChallengeCreate, db: Session = Depends(get_db)):
    challenge = Challenge()
    _set_fields(challenge, payload)
    if not challenge.status:
        challenge.status = "new"
    db.add(challenge)
    db.commit()
    db.refresh(challenge)
    return _challenge_out(db, challenge)


@router.get("/challenges/{challenge_id}", response_model=ChallengeOut)
def get_challenge(challenge_id: int, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    return _challenge_out(db, challenge)


@router.patch("/challenges/{challenge_id}", response_model=ChallengeOut)
def patch_challenge(challenge_id: int, payload: ChallengePatch, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    _set_fields(challenge, payload)
    db.commit()
    db.refresh(challenge)
    return _challenge_out(db, challenge)


@router.post("/challenges/import")
def import_challenges(payload: ChallengeImport, db: Session = Depends(get_db)):
    records = _parse_import(payload)
    created: List[int] = []
    for record in records:
        record.setdefault("assignee", payload.default_assignee)
        challenge = Challenge()
        _set_fields(challenge, ChallengeCreate(**record))
        db.add(challenge)
        db.commit()
        db.refresh(challenge)
        created.append(challenge.id)
    return {"created": len(created), "challenge_ids": created}


@router.post("/challenges/{challenge_id}/run-triage", response_model=ChallengeOut)
def run_triage(challenge_id: int, db: Session = Depends(get_db)):
    rag_kill_switch.require_blind_solve_controls("FinalOps.run_triage")
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    challenge.status = "triaging"
    challenge.updated_at = datetime.datetime.utcnow()
    db.commit()

    task = Task(
        title=f"FinalOps Triage - {challenge.name}",
        description=challenge.description,
        task_type=challenge.challenge_type or "unknown",
        target=challenge.target or "",
        uploaded_file=challenge.uploaded_file or "",
        challenge_id=challenge.id,
        status="running",
        plan_source="runbook",
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    runbook = final_runbook_planner.build(
        challenge.challenge_type,
        challenge.description,
        challenge.target,
        {},
        scope_guard.summary(),
        20,
    )
    triage_result = ArtifactTriageTool().safe_run({
        "uploaded_file": challenge.uploaded_file,
        "file_path": challenge.uploaded_file,
        "challenge_type": challenge.challenge_type,
        "description": challenge.description,
        "challenge_id": challenge.id,
        "task_id": task.id,
    })
    step_records = []
    triage_step = PlanStep("题目附件分诊", "ArtifactTriageTool", "FinalOps run-triage 统一提取题目线索", "planning", "runbook")
    step = _save_api_step(db, task, 1, triage_step, f"file={challenge.uploaded_file or '(none)'}", triage_result)
    step_records.append(_step_record(step, triage_result))

    details = triage_result.get("details", {})
    runbook = final_runbook_planner.build(
        challenge.challenge_type,
        challenge.description,
        challenge.target,
        details,
        scope_guard.summary(),
        20,
    )

    fingerprint_result = None
    if challenge.target and (challenge.challenge_type or "").lower() == "web":
        fingerprint_result = HttpFingerprintTool().safe_run({"target": challenge.target, "challenge_id": challenge.id, "task_id": task.id})
        fp_step = PlanStep("HTTP 指纹识别", "HttpFingerprintTool", "Web 题第一轮只读指纹观察", "execution", "runbook")
        step = _save_api_step(db, task, 2, fp_step, f"target={challenge.target}", fingerprint_result)
        step_records.append(_step_record(step, fingerprint_result))

    evidence_text = json.dumps(details, ensure_ascii=False, indent=2)[:3000]
    evidence = evidence_vault.create(
        db,
        "ArtifactTriageTool",
        f"challenge={challenge.name}",
        evidence_text,
        challenge_id=challenge.id,
        task_id=task.id,
        reproduction_hint=f"POST /api/challenges/{challenge.id}/run-triage",
    )
    candidates = details.get("answer_candidates") or []
    if fingerprint_result:
        candidates.extend(fingerprint_result.get("details", {}).get("answer_candidates", []))
    _persist_candidates(db, challenge.id, task.id, candidates, evidence.evidence_uid)

    challenge.runbook_json = json.dumps(runbook, ensure_ascii=False)
    challenge.latest_summary = triage_result.get("summary", "分诊完成")
    challenge.next_suggestion = "; ".join((runbook.get("first_3_actions") or [])[:3])
    challenge.confidence = str(details.get("confidence", 0.5))
    challenge.status = "candidate_found" if candidates else "need_human"
    challenge.updated_at = datetime.datetime.utcnow()
    task.status = "completed"
    task.updated_at = datetime.datetime.utcnow()

    reporter = Reporter()
    report_content = reporter.generate(
        task_id=task.id,
        task_title=task.title,
        task_type=task.task_type,
        task_description=task.description,
        target=task.target,
        plan_steps=[triage_step.to_dict()],
        step_records=step_records,
        plan_source="runbook",
        intent={"intent_type": challenge.challenge_type, "recommended_scenario": challenge.challenge_type, "confidence": details.get("confidence", 0.5), "constraints": ["ScopeGuard", "只读分诊"]},
    )
    file_path = reporter.save_report(task.id, report_content)
    reporter.save_html_report(task.id, report_content)
    db.add(Report(task_id=task.id, content=report_content, file_path=file_path))
    db.commit()
    db.refresh(challenge)
    return _challenge_out(db, challenge)


@router.post("/challenges/{challenge_id}/add-note", response_model=ChallengeOut)
def add_note(challenge_id: int, payload: ChallengeNoteCreate, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    note = ChallengeNote(challenge_id=challenge.id, author=payload.author, note=payload.note, note_type=payload.note_type)
    db.add(note)
    challenge.notes = ((challenge.notes or "") + f"\n[{payload.author or 'team'}] {payload.note}").strip()
    challenge.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(challenge)
    return _challenge_out(db, challenge)


@router.post("/challenges/{challenge_id}/answer-candidate", response_model=AnswerCandidateOut)
def add_candidate(challenge_id: int, payload: AnswerCandidateCreate, db: Session = Depends(get_db)):
    if not db.query(Challenge).filter(Challenge.id == challenge_id).first():
        raise HTTPException(status_code=404, detail="Challenge not found")
    candidate = AnswerCandidate(challenge_id=challenge_id, **payload.model_dump())
    db.add(candidate)
    db.commit()
    db.refresh(candidate)
    return candidate


@router.patch("/answer-candidates/{candidate_id}", response_model=AnswerCandidateOut)
def patch_candidate(candidate_id: int, payload: AnswerCandidatePatch, db: Session = Depends(get_db)):
    candidate = db.query(AnswerCandidate).filter(AnswerCandidate.id == candidate_id).first()
    if not candidate:
        raise HTTPException(status_code=404, detail="Answer candidate not found")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(candidate, key, value)
    candidate.updated_at = datetime.datetime.utcnow()
    if candidate.validation_status == "rejected":
        candidate.confidence = min(candidate.confidence or 0.5, 0.15)
    if candidate.challenge_id:
        challenge = db.query(Challenge).filter(Challenge.id == candidate.challenge_id).first()
        if challenge and candidate.validation_status in {"submitted", "accepted"}:
            challenge.status = "submitted" if candidate.validation_status == "submitted" else "solved"
            challenge.submit_status = "submitted" if candidate.validation_status == "submitted" else "accepted"
            challenge.updated_at = datetime.datetime.utcnow()
        if challenge and candidate.validation_status == "rejected":
            challenge.submit_status = "rejected"
            challenge.status = "candidate_found"
            challenge.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(candidate)
    return candidate


@router.post("/challenges/{challenge_id}/submit", response_model=ChallengeOut)
def submit_challenge(challenge_id: int, payload: SubmissionCreate, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    if not payload.answer.strip() or not payload.submitter.strip():
        raise HTTPException(status_code=400, detail="answer and submitter are required")
    now = datetime.datetime.utcnow()
    challenge.submitted_answer = payload.answer.strip()
    challenge.submitter = payload.submitter.strip()
    challenge.submission_note = payload.submission_note.strip()
    challenge.submit_status = payload.submit_status if payload.submit_status in {"ready_to_submit", "submitted", "accepted", "rejected"} else "submitted"
    challenge.submitted_at = now
    challenge.status = "submitted" if challenge.submit_status == "submitted" else ("solved" if challenge.submit_status == "accepted" else challenge.status)
    challenge.updated_at = now
    if payload.candidate_id:
        candidate = db.query(AnswerCandidate).filter(AnswerCandidate.id == payload.candidate_id, AnswerCandidate.challenge_id == challenge_id).first()
        if candidate:
            candidate.validation_status = "submitted" if challenge.submit_status == "submitted" else challenge.submit_status
            candidate.updated_at = now
            if candidate.validation_status == "rejected":
                candidate.confidence = min(candidate.confidence or 0.5, 0.15)
    db.add(ChallengeNote(
        challenge_id=challenge_id,
        author=payload.submitter,
        note=f"提交答案: {payload.answer} | 状态: {challenge.submit_status} | 备注: {payload.submission_note}",
        note_type="submission",
    ))
    db.commit()
    db.refresh(challenge)
    return _challenge_out(db, challenge)


@router.post("/challenges/{challenge_id}/manual-result", response_model=ChallengeOut)
def challenge_manual_result(challenge_id: int, payload: ManualResultCreate, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    note = ChallengeNote(challenge_id=challenge.id, author=payload.author, note=payload.result, note_type="manual_result")
    db.add(note)
    challenge.notes = ((challenge.notes or "") + f"\n[manual:{payload.author or 'team'}] {payload.result}").strip()
    candidates = extractor.extract(payload.result, "manual_result")
    if payload.candidate:
        candidates.insert(0, {"candidate": payload.candidate, "source": "manual_result", "evidence": payload.result, "confidence": 0.85, "why_selected": "人工回填候选", "validation_status": payload.validation_status or "likely"})
    _persist_candidates(db, challenge.id, None, candidates, "")
    if candidates:
        challenge.status = "candidate_found"
    if payload.validation_status in {"submitted", "accepted"}:
        challenge.status = "submitted" if payload.validation_status == "submitted" else "solved"
    challenge.latest_summary = payload.result[:1000]
    challenge.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(challenge)
    return _challenge_out(db, challenge)


@router.get("/challenges/{challenge_id}/brief")
def challenge_brief(challenge_id: int, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    candidates = db.query(AnswerCandidate).filter(AnswerCandidate.challenge_id == challenge.id).order_by(AnswerCandidate.confidence.desc()).limit(5).all()
    evidence = db.query(Evidence).filter(Evidence.challenge_id == challenge.id).order_by(Evidence.created_at.desc()).limit(5).all()
    best = candidates[0] if candidates else None
    evidence_lines = [f"- Evidence {e.evidence_uid}: {e.output_excerpt[:180].replace(chr(10), ' ')}" for e in evidence[:3]] or ["- None"]
    reproduce = [
        "Open the challenge in FinalOps and review the top candidate.",
        "Inspect evidence IDs listed below.",
        "Re-run triage or solve-ctf with the same attachment if needed.",
        "Reviewer confirms before platform submission.",
        "Submit the best candidate and record Accepted/Rejected.",
    ]
    tools = sorted({e.source_tool for e in evidence if e.source_tool})
    md = [
        f"# Challenge Brief: {challenge.name}",
        "",
        "## Best Candidate",
        best.candidate if best else "(no candidate)",
        "",
        "## Confidence",
        f"{best.confidence:.2f}" if best else "0.00",
        "",
        "## Submission",
        f"- Submit Status: {challenge.submit_status or 'not_submitted'}",
        "",
        "## Why this is likely correct",
        *evidence_lines,
        "",
        "## Reproduce",
    ]
    md.extend([f"{idx}. {step}" for idx, step in enumerate(reproduce[:5], 1)])
    md.extend([
        "",
        "## Toolchain",
        ", ".join(tools or ["ArtifactTriageTool"]),
        "",
        "## Manual Actions",
        challenge.next_suggestion or "Reviewer should confirm before submission.",
        "",
        "## Submit Note",
        f"建议提交：{best.candidate}" if best else "未解出：请继续人工复核附件和题面。",
        "",
        "## Risk / Uncertainty",
        "Candidate is not submitted until a human reviewer confirms it.",
    ])
    content = "\n".join(md)
    return {"challenge_id": challenge.id, "markdown": content, "answer_candidates": [c.candidate for c in candidates], "evidence_ids": [e.evidence_uid for e in evidence]}


@router.get("/final-ops/debrief")
def final_ops_debrief(db: Session = Depends(get_db)):
    challenges = db.query(Challenge).all()
    candidates = db.query(AnswerCandidate).all()
    evidence_count = db.query(Evidence).count()
    manual_count = db.query(ChallengeNote).filter(ChallengeNote.note_type.in_(["manual", "manual_result"])).count()
    by_status: Dict[str, int] = {}
    by_type: Dict[str, int] = {}
    for item in challenges:
        by_status[item.status] = by_status.get(item.status, 0) + 1
        by_type[item.challenge_type] = by_type.get(item.challenge_type, 0) + 1
    solved = [c.name for c in challenges if c.status == "solved"]
    unsolved = [c.name for c in challenges if c.status != "solved"]
    submitted = [c for c in challenges if c.submit_status in {"submitted", "accepted", "rejected"}]
    accepted = [c for c in challenges if c.submit_status == "accepted"]
    rejected = [c for c in challenges if c.submit_status == "rejected"]
    submit_deltas = [(c.submitted_at - c.created_at).total_seconds() for c in submitted if c.submitted_at and c.created_at]
    accept_deltas = [(c.updated_at - c.submitted_at).total_seconds() for c in accepted if c.submitted_at and c.updated_at]
    markdown = [
        "# Team Debrief",
        "",
        f"- 总题目数: {len(challenges)}",
        f"- 已解决: {len(solved)}",
        f"- 未解决: {len(unsolved)}",
        f"- 答案候选数: {len(candidates)}",
        f"- 证据数: {evidence_count}",
        f"- 人工回填次数: {manual_count}",
        f"- 已提交: {len(submitted)}",
        f"- Accepted: {len(accepted)}",
        f"- Rejected: {len(rejected)}",
        "",
        f"- 状态统计: {json.dumps(by_status, ensure_ascii=False)}",
        f"- 类型统计: {json.dumps(by_type, ensure_ascii=False)}",
    ]
    return {
        "total_challenges": len(challenges),
        "solved": solved,
        "unsolved": unsolved,
        "by_status": by_status,
        "by_type": by_type,
        "tool_call_stats": _tool_stats(db),
        "agent_candidate_hits": len([c for c in candidates if c.source != "manual"]),
        "manual_backfills": manual_count,
        "submitted_count": len(submitted),
        "accepted_count": len(accepted),
        "rejected_count": len(rejected),
        "average_time_to_submit_seconds": round(sum(submit_deltas) / len(submit_deltas), 3) if submit_deltas else 0,
        "average_time_to_accepted_seconds": round(sum(accept_deltas) / len(accept_deltas), 3) if accept_deltas else 0,
        "failure_reasons": {"blocked": by_status.get("blocked", 0), "need_human": by_status.get("need_human", 0)},
        "markdown": "\n".join(markdown),
    }


@router.get("/final-ops/export")
def final_ops_export(db: Session = Depends(get_db)):
    challenges = db.query(Challenge).order_by(Challenge.id).all()
    tasks = db.query(Task).order_by(Task.id).all()
    evidence = db.query(Evidence).order_by(Evidence.id).all()
    candidates = db.query(AnswerCandidate).order_by(AnswerCandidate.id).all()
    notes = db.query(ChallengeNote).order_by(ChallengeNote.id).all()
    payload = {
        "schema": "cyberpilot-finalops-export-v1",
        "exported_at": datetime.datetime.utcnow().isoformat() + "Z",
        "challenges": [_export_challenge(c) for c in challenges],
        "tasks": [_export_task(t) for t in tasks],
        "evidence": [_export_evidence(e) for e in evidence],
        "answer_candidates": [_export_candidate(c) for c in candidates],
        "manual_notes": [_export_note(n) for n in notes],
    }
    return payload


@router.post("/final-ops/import")
def final_ops_import(payload: FinalOpsImportPayload, db: Session = Depends(get_db)):
    data = payload.data or {}
    if data.get("schema") != "cyberpilot-finalops-export-v1":
        raise HTTPException(status_code=400, detail="Unsupported export schema")
    challenge_map: Dict[int, int] = {}
    imported = 0
    for raw in data.get("challenges", []):
        if not isinstance(raw, dict):
            continue
        existing = db.query(Challenge).filter(Challenge.name == raw.get("name", ""), Challenge.description == raw.get("description", "")).first()
        challenge = existing or Challenge()
        for key in [
            "name", "challenge_type", "description", "target", "uploaded_file", "tags", "priority", "status",
            "assignee", "reviewer", "submitter", "submit_status", "submitted_answer", "submission_note",
            "notes", "latest_summary", "next_suggestion", "confidence", "runbook_json",
        ]:
            if key in raw:
                setattr(challenge, key, raw.get(key) or "")
        if raw.get("submitted_at"):
            challenge.submitted_at = _parse_dt(raw["submitted_at"])
        challenge.updated_at = datetime.datetime.utcnow()
        if not existing:
            db.add(challenge)
            imported += 1
        db.commit()
        db.refresh(challenge)
        if raw.get("id") is not None:
            challenge_map[int(raw["id"])] = challenge.id

    for raw in data.get("evidence", []):
        if not isinstance(raw, dict):
            continue
        old_cid = raw.get("challenge_id")
        new_cid = challenge_map.get(int(old_cid)) if old_cid is not None and str(old_cid).isdigit() else None
        uid = raw.get("evidence_uid") or _uid("EV", raw)
        existing = db.query(Evidence).filter(Evidence.evidence_uid == uid).first()
        if existing:
            continue
        db.add(Evidence(
            evidence_uid=uid,
            source_tool=raw.get("source_tool", ""),
            challenge_id=new_cid,
            task_id=None,
            input_summary=raw.get("input_summary", ""),
            output_excerpt=raw.get("output_excerpt", ""),
            content_hash=raw.get("content_hash", ""),
            reproduction_hint=raw.get("reproduction_hint", ""),
        ))
    for raw in data.get("answer_candidates", []):
        if not isinstance(raw, dict):
            continue
        old_cid = raw.get("challenge_id")
        new_cid = challenge_map.get(int(old_cid)) if old_cid is not None and str(old_cid).isdigit() else None
        value = str(raw.get("candidate", "")).strip()
        if not value or (new_cid and db.query(AnswerCandidate).filter(AnswerCandidate.challenge_id == new_cid, AnswerCandidate.candidate == value).first()):
            continue
        db.add(AnswerCandidate(
            challenge_id=new_cid,
            candidate=value,
            source=raw.get("source", ""),
            evidence=raw.get("evidence", ""),
            evidence_id=raw.get("evidence_id", ""),
            confidence=float(raw.get("confidence", 0.5) or 0.5),
            why_selected=raw.get("why_selected", ""),
            validation_status=raw.get("validation_status", "unverified"),
            note=raw.get("note", ""),
        ))
    for raw in data.get("manual_notes", []):
        if not isinstance(raw, dict):
            continue
        old_cid = raw.get("challenge_id")
        new_cid = challenge_map.get(int(old_cid)) if old_cid is not None and str(old_cid).isdigit() else None
        if not new_cid:
            continue
        db.add(ChallengeNote(
            challenge_id=new_cid,
            author=raw.get("author", ""),
            note=raw.get("note", ""),
            note_type=raw.get("note_type", "manual"),
        ))
    db.commit()
    return {"imported_challenges": imported, "total_challenges": db.query(Challenge).count()}


def _save_api_step(db: Session, task: Task, idx: int, plan_step: PlanStep, input_summary: str, result: Dict[str, Any]) -> Step:
    step = Step(
        task_id=task.id,
        step_index=idx,
        phase=plan_step.phase,
        action=plan_step.action,
        reason=plan_step.reason,
        tool_name=plan_step.tool,
        input_summary=input_summary[:500],
        output_summary=(result.get("summary") or "")[:1000],
        next_decision="写入 EvidenceVault 并更新 FinalOps",
        status="success" if result.get("success") else "failed",
        plan_source="runbook",
        risk_level="low",
        confidence=float(result.get("details", {}).get("confidence", 0.6) or 0.6),
        requires_confirmation=False,
        decision_trace=json.dumps({
            "observation": result.get("summary", ""),
            "evidence": result.get("evidence", [])[:10],
            "hypothesis": "FinalOps triage result",
            "selected_action": "save_evidence_and_candidates",
            "rejected_actions": ["out_of_scope_requests", "destructive_actions"],
            "safety_check": {"decision": "allow", "reason": "只读分诊"},
            "confidence": result.get("details", {}).get("confidence", 0.6),
        }, ensure_ascii=False),
    )
    db.add(step)
    db.commit()
    db.refresh(step)
    return step


def _step_record(step: Step, result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "step_index": step.step_index,
        "phase": step.phase,
        "action": step.action,
        "reason": step.reason,
        "tool_name": step.tool_name,
        "input_summary": step.input_summary,
        "output_summary": step.output_summary,
        "next_decision": step.next_decision,
        "status": step.status,
        "plan_source": step.plan_source,
        "risk_level": step.risk_level,
        "confidence": step.confidence,
        "requires_confirmation": step.requires_confirmation,
        "tool_details": result.get("details", {}),
        "tool_evidence": result.get("evidence", []),
        "decision_trace": json.loads(step.decision_trace or "{}"),
    }


def _persist_candidates(db: Session, challenge_id: int, task_id: int | None, candidates: List[Dict[str, Any]], evidence_id: str) -> None:
    existing = {row[0] for row in db.query(AnswerCandidate.candidate).filter(AnswerCandidate.challenge_id == challenge_id).all()}
    prepared = []
    for raw in candidates[:30]:
        item = dict(raw)
        if evidence_id and not item.get("evidence_id") and not item.get("evidence_ids"):
            item["evidence_id"] = evidence_id
            item["evidence_ids"] = [evidence_id]
        prepared.append(item)
    for raw in enforce_candidate_evidence_policy(prepared):
        value = str(raw.get("candidate", "")).strip()
        if not value or value in existing:
            continue
        note = raw.get("note", "")
        policy_note = {
            "source_type": raw.get("source_type", ""),
            "evidence_ids": raw.get("evidence_ids", []),
            "memory_guess_detected": raw.get("memory_guess_detected", False),
            "confidence_cap_reason": raw.get("confidence_cap_reason", ""),
        }
        if policy_note:
            note = (str(note).strip() + "\n" + json.dumps(policy_note, ensure_ascii=False)).strip()
        candidate = AnswerCandidate(
            challenge_id=challenge_id,
            task_id=task_id,
            candidate=value,
            source=str(raw.get("source", "tool"))[:256],
            evidence=str(raw.get("evidence", ""))[:2000],
            evidence_id=str((raw.get("evidence_ids") or [raw.get("evidence_id", "")])[0] or ""),
            confidence=float(raw.get("confidence", 0.5) or 0.5),
            why_selected=str(raw.get("why_selected", "匹配答案候选规则"))[:1000],
            validation_status=str(raw.get("validation_status", "unverified")),
            note=note[:4000],
        )
        db.add(candidate)
        existing.add(value)
    db.commit()


def _parse_import(payload: ChallengeImport) -> List[Dict[str, Any]]:
    content = payload.content or ""
    fmt = (payload.format or "json").lower()
    if not content.strip():
        return []
    if fmt == "json":
        data = json.loads(content)
        if isinstance(data, dict):
            data = data.get("challenges", [data])
        return [_normalize_import_record(item) for item in data if isinstance(item, dict)]
    if fmt == "csv":
        reader = csv.DictReader(io.StringIO(content))
        return [_normalize_import_record(row) for row in reader]
    records: List[Dict[str, Any]] = []
    current: Dict[str, Any] = {}
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            if current:
                records.append(_normalize_import_record(current))
            current = {"name": line.lstrip("#").strip()}
        elif ":" in line:
            key, value = line.split(":", 1)
            current[key.strip().lower().replace(" ", "_")] = value.strip()
        else:
            current["description"] = (current.get("description", "") + "\n" + line).strip()
    if current:
        records.append(_normalize_import_record(current))
    return records


def _normalize_import_record(record: Dict[str, Any]) -> Dict[str, Any]:
    name = record.get("name") or record.get("title") or record.get("题目名称") or "Imported Challenge"
    tags = record.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.replace(";", ",").split(",") if t.strip()]
    return {
        "name": str(name),
        "challenge_type": str(record.get("challenge_type") or record.get("type") or record.get("题目类型") or "unknown"),
        "description": str(record.get("description") or record.get("desc") or record.get("题目描述") or ""),
        "target": str(record.get("target") or record.get("url") or record.get("目标") or ""),
        "uploaded_file": str(record.get("uploaded_file") or record.get("attachment") or ""),
        "tags": tags,
        "priority": str(record.get("priority") or "medium"),
        "assignee": str(record.get("assignee") or ""),
        "reviewer": str(record.get("reviewer") or ""),
        "submitter": str(record.get("submitter") or ""),
        "status": str(record.get("status") or "new"),
    }


def _tool_stats(db: Session) -> Dict[str, int]:
    stats: Dict[str, int] = {}
    for row in db.query(Step.tool_name).all():
        name = row[0] or "(none)"
        stats[name] = stats.get(name, 0) + 1
    return stats


def _parse_dt(value: str):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace("Z", ""))


def _uid(prefix: str, raw: Dict[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(raw, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return f"{prefix}-{digest[:12]}"


def _export_challenge(c: Challenge) -> Dict[str, Any]:
    return {
        "id": c.id,
        "name": c.name,
        "challenge_type": c.challenge_type,
        "description": c.description,
        "target": c.target,
        "uploaded_file": c.uploaded_file,
        "uploaded_file_summary": PathSummary.from_path(c.uploaded_file),
        "tags": c.tags,
        "priority": c.priority,
        "status": c.status,
        "assignee": c.assignee,
        "reviewer": c.reviewer,
        "submitter": c.submitter,
        "submit_status": c.submit_status,
        "submitted_answer": c.submitted_answer,
        "submitted_at": c.submitted_at.isoformat() + "Z" if c.submitted_at else "",
        "submission_note": c.submission_note,
        "notes": c.notes,
        "latest_summary": c.latest_summary,
        "next_suggestion": c.next_suggestion,
        "confidence": c.confidence,
        "runbook_json": c.runbook_json,
        "created_at": c.created_at.isoformat() + "Z" if c.created_at else "",
        "updated_at": c.updated_at.isoformat() + "Z" if c.updated_at else "",
    }


class PathSummary:
    @staticmethod
    def from_path(path: str) -> Dict[str, Any]:
        from pathlib import Path
        p = Path(path or "")
        if not path:
            return {"path": "", "name": "", "exists": False, "sha256": "", "size": 0}
        digest = ""
        size = 0
        if p.exists() and p.is_file():
            size = p.stat().st_size
            h = hashlib.sha256()
            with p.open("rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    h.update(chunk)
            digest = h.hexdigest()
        return {"path": str(p), "name": p.name, "exists": p.exists(), "sha256": digest, "size": size}


def _export_task(t: Task) -> Dict[str, Any]:
    return {
        "id": t.id,
        "challenge_id": t.challenge_id,
        "title": t.title,
        "task_type": t.task_type,
        "target": t.target,
        "status": t.status,
        "uploaded_file": t.uploaded_file,
        "uploaded_file_summary": PathSummary.from_path(t.uploaded_file),
        "created_at": t.created_at.isoformat() + "Z" if t.created_at else "",
        "updated_at": t.updated_at.isoformat() + "Z" if t.updated_at else "",
    }


def _export_evidence(e: Evidence) -> Dict[str, Any]:
    return {
        "id": e.id,
        "evidence_uid": e.evidence_uid,
        "source_tool": e.source_tool,
        "task_id": e.task_id,
        "challenge_id": e.challenge_id,
        "input_summary": e.input_summary,
        "output_excerpt": e.output_excerpt,
        "content_hash": e.content_hash,
        "reproduction_hint": e.reproduction_hint,
        "created_at": e.created_at.isoformat() + "Z" if e.created_at else "",
    }


def _export_candidate(c: AnswerCandidate) -> Dict[str, Any]:
    return {
        "id": c.id,
        "challenge_id": c.challenge_id,
        "task_id": c.task_id,
        "candidate": c.candidate,
        "source": c.source,
        "evidence": c.evidence,
        "evidence_id": c.evidence_id,
        "confidence": c.confidence,
        "why_selected": c.why_selected,
        "validation_status": c.validation_status,
        "note": c.note,
        "created_at": c.created_at.isoformat() + "Z" if c.created_at else "",
        "updated_at": c.updated_at.isoformat() + "Z" if c.updated_at else "",
    }


def _export_note(n: ChallengeNote) -> Dict[str, Any]:
    return {
        "id": n.id,
        "challenge_id": n.challenge_id,
        "author": n.author,
        "note": n.note,
        "note_type": n.note_type,
        "created_at": n.created_at.isoformat() + "Z" if n.created_at else "",
    }

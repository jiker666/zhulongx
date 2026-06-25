"""
Tasks API
"""
import datetime
import json
import logging
import threading
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.task import Task
from app.models.step import Step
from app.models.report import Report
from app.schemas.task import TaskCreate, TaskOut
from app.schemas.step import StepOut
from app.schemas.report import ReportOut
from app.core.planner import Planner
from app.core.executor import Executor, _broadcast_sync
from app.core.reporter import Reporter
from app.core.intent_analyzer import looks_like_uploaded_path

router = APIRouter()
planner = Planner()
logger = logging.getLogger(__name__)
_task_semaphore = threading.BoundedSemaphore(max(int(settings.MAX_CONCURRENT_TASKS or 1), 1))


@router.post("/tasks", response_model=TaskOut)
def create_task(payload: TaskCreate, db: Session = Depends(get_db)):
    target = payload.target or ""
    uploaded_file = payload.uploaded_file or ""
    if not uploaded_file and looks_like_uploaded_path(target):
        uploaded_file = target
        target = ""
    intent = planner.analyze_intent(payload.task_type, payload.description, target, uploaded_file)
    task = Task(
        title=payload.title,
        description=payload.description,
        task_type=payload.task_type,
        target=target,
        uploaded_file=uploaded_file,
        challenge_id=payload.challenge_id,
        intent_result=json.dumps(intent, ensure_ascii=False),
        status="created",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    task.report_status = "missing"
    return task


@router.get("/tasks", response_model=List[TaskOut])
def list_tasks(db: Session = Depends(get_db)):
    reports = {row[0] for row in db.query(Report.task_id).all()}
    tasks = db.query(Task).order_by(Task.created_at.desc()).all()
    for task in tasks:
        task.report_status = "ready" if task.id in reports else "missing"
    return tasks


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.report_status = "ready" if db.query(Report).filter(Report.task_id == task_id).first() else "missing"
    return task


@router.post("/tasks/{task_id}/run")
def run_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status in ("running", "planning", "queued", "paused"):
        raise HTTPException(status_code=400, detail="Task is already running")

    # Run in background thread to avoid blocking
    def _run():
        from app.database import SessionLocal
        bg_db = SessionLocal()
        acquired = False
        try:
            bg_task = bg_db.query(Task).filter(Task.id == task_id).first()
            if not bg_task:
                return
            if not _task_semaphore.acquire(blocking=False):
                bg_task.status = "queued"
                bg_task.updated_at = datetime.datetime.utcnow()
                bg_db.commit()
                _broadcast_sync(task_id, {"type": "task_status", "task_id": task_id, "data": {"status": "queued"}})
                _task_semaphore.acquire()
            acquired = True

            # Re-run starts from a clean execution surface.
            bg_db.query(Step).filter(Step.task_id == task_id).delete()
            bg_db.query(Report).filter(Report.task_id == task_id).delete()
            bg_task.status = "planning"
            bg_task.updated_at = datetime.datetime.utcnow()
            bg_db.commit()
            _broadcast_sync(task_id, {"type": "task_reset", "task_id": task_id, "data": {"status": "planning"}})
            _broadcast_sync(task_id, {"type": "task_status", "task_id": task_id, "data": {"status": "planning"}})

            # Generate plan
            intent = planner.analyze_intent(bg_task.task_type, bg_task.description, bg_task.target, bg_task.uploaded_file or "")
            bg_task.intent_result = json.dumps(intent, ensure_ascii=False)
            bg_db.commit()
            plan = planner.generate_plan(
                bg_task.task_type,
                bg_task.description,
                bg_task.target,
                uploaded_file=bg_task.uploaded_file or "",
            )

            # Execute
            executor = Executor(bg_db)
            step_records = executor.execute(bg_task, plan)
            bg_db.refresh(bg_task)
            if bg_task.status in {"waiting_confirmation", "cancelled", "paused"}:
                return

            # Generate report
            reporter = Reporter()
            plan_dicts = [s.to_dict() for s in plan]
            report_content = reporter.generate(
                task_id=bg_task.id,
                task_title=bg_task.title,
                task_type=bg_task.task_type,
                task_description=bg_task.description,
                target=bg_task.target,
                plan_steps=plan_dicts,
                step_records=step_records,
                plan_source=getattr(bg_task, "plan_source", "rule") or "rule",
                llm_model=getattr(bg_task, "llm_model", "") or "",
                llm_enabled=getattr(bg_task, "llm_enabled", False) or False,
                intent=planner.analyze_intent(bg_task.task_type, bg_task.description, bg_task.target, bg_task.uploaded_file or ""),
            )
            file_path = reporter.save_report(bg_task.id, report_content)
            reporter.save_html_report(bg_task.id, report_content)

            # Save report to DB
            existing_report = bg_db.query(Report).filter(Report.task_id == task_id).first()
            if existing_report:
                existing_report.content = report_content
                existing_report.file_path = file_path
            else:
                report = Report(
                    task_id=task_id,
                    content=report_content,
                    file_path=file_path,
                )
                bg_db.add(report)
            bg_db.commit()

            reporter_step = next((s for s in plan if s.tool == "Reporter"), None)
            if reporter_step:
                report_record = executor.save_report_step(bg_task, len(step_records) + 1, reporter_step, file_path)
                step_records.append(report_record)

            bg_task.status = "completed"
            bg_task.updated_at = datetime.datetime.utcnow()
            bg_db.commit()
            _broadcast_sync(task_id, {
                "type": "task_status", "task_id": task_id, "data": {"status": "completed"}
            })
            _broadcast_sync(task_id, {
                "type": "report_ready", "task_id": task_id,
                "data": {"report_url": f"/api/tasks/{task_id}/report"}
            })

        except Exception as e:
            logger.exception("Task %s execution failed", task_id)
            bg_task = bg_db.query(Task).filter(Task.id == task_id).first()
            if bg_task:
                bg_task.status = "failed"
                bg_task.updated_at = datetime.datetime.utcnow()
                bg_db.commit()
                _broadcast_sync(task_id, {"type": "task_status", "task_id": task_id, "data": {"status": "failed", "error": str(e)}})
        finally:
            if acquired:
                _task_semaphore.release()
            bg_db.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return {"message": "Task started", "task_id": task_id}


@router.get("/tasks/{task_id}/steps", response_model=List[StepOut])
def get_steps(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return db.query(Step).filter(Step.task_id == task_id).order_by(Step.step_index).all()


@router.get("/tasks/{task_id}/report", response_model=ReportOut)
def get_report(task_id: int, db: Session = Depends(get_db)):
    report = db.query(Report).filter(Report.task_id == task_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@router.get("/tasks/{task_id}/report/html")
def get_report_html(task_id: int, db: Session = Depends(get_db)):
    report = db.query(Report).filter(Report.task_id == task_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    from fastapi.responses import HTMLResponse
    from pathlib import Path
    html_path = Path(report.file_path).with_suffix(".html")
    if not html_path.exists():
        Reporter().save_html_report(task_id, report.content)
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@router.post("/tasks/{task_id}/confirm-step")
def confirm_step(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.status = "created"
    task.updated_at = datetime.datetime.utcnow()
    db.commit()
    return {"message": "Step confirmation recorded. Please re-run the task to continue.", "task_id": task_id}


@router.post("/tasks/{task_id}/deny-step")
def deny_step(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.status = "failed"
    task.updated_at = datetime.datetime.utcnow()
    db.commit()
    return {"message": "Step denied and task marked failed.", "task_id": task_id}


@router.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.status = "cancelled"
    task.updated_at = datetime.datetime.utcnow()
    db.commit()
    _broadcast_sync(task_id, {"type": "task_status", "task_id": task_id, "data": {"status": "cancelled"}})
    return {"message": "Task cancelled", "task_id": task_id}


@router.post("/tasks/{task_id}/pause")
def pause_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status not in {"running", "planning", "queued"}:
        raise HTTPException(status_code=400, detail="Task is not running")
    task.status = "paused"
    task.updated_at = datetime.datetime.utcnow()
    db.commit()
    _broadcast_sync(task_id, {"type": "task_status", "task_id": task_id, "data": {"status": "paused"}})
    return {"message": "Task paused", "task_id": task_id}


@router.post("/tasks/{task_id}/resume")
def resume_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status != "paused":
        raise HTTPException(status_code=400, detail="Task is not paused")
    task.status = "running"
    task.updated_at = datetime.datetime.utcnow()
    db.commit()
    _broadcast_sync(task_id, {"type": "task_status", "task_id": task_id, "data": {"status": "running"}})
    return {"message": "Task resumed", "task_id": task_id}


@router.post("/tasks/{task_id}/manual-result")
def task_manual_result(task_id: int, payload: dict, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    result = str(payload.get("result") or payload.get("note") or "")
    author = str(payload.get("author") or "team")
    if not result:
        raise HTTPException(status_code=400, detail="manual result is required")
    next_index = (db.query(Step).filter(Step.task_id == task_id).count() or 0) + 1
    trace = {
        "observation": result[:1000],
        "evidence": [result[:300]],
        "hypothesis": "人工动作结果已回填，Agent 可基于该结果继续判断",
        "selected_action": "record_manual_result",
        "rejected_actions": ["continue_without_human_context"],
        "safety_check": {"decision": "allow", "reason": "manual backfill"},
        "confidence": 1.0,
    }
    step = Step(
        task_id=task_id,
        step_index=next_index,
        phase="manual",
        action="人工结果回填",
        reason=f"{author} 回填现场验证结果",
        tool_name="ManualActionStep",
        input_summary=f"author={author}",
        output_summary=result[:1000],
        next_decision="结合人工结果继续判断候选答案或生成报告",
        status="success",
        plan_source="human",
        risk_level="low",
        confidence=1.0,
        requires_confirmation=False,
        decision_trace=json.dumps(trace, ensure_ascii=False),
    )
    db.add(step)
    if task.status in {"waiting_confirmation", "paused"}:
        task.status = "created"
    task.updated_at = datetime.datetime.utcnow()
    db.commit()
    _broadcast_sync(task_id, {"type": "step_created", "task_id": task_id, "data": {
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
        "decision_trace": trace,
    }})
    return {"message": "Manual result recorded", "task_id": task_id, "step_index": next_index}

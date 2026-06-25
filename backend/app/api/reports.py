"""
Reports API
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pathlib import Path
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.report import Report
from app.schemas.report import ReportOut
from app.core.reporter import Reporter

router = APIRouter()


@router.get("/reports/{task_id}", response_model=ReportOut)
def get_report(task_id: int, db: Session = Depends(get_db)):
    report = db.query(Report).filter(Report.task_id == task_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@router.get("/reports/{task_id}/html")
def get_report_html(task_id: int, db: Session = Depends(get_db)):
    report = db.query(Report).filter(Report.task_id == task_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    html_path = Path(report.file_path).with_suffix(".html")
    if not html_path.exists():
        Reporter().save_html_report(task_id, report.content)
    return HTMLResponse(html_path.read_text(encoding="utf-8"))

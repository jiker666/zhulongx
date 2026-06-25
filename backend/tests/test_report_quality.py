import time

from fastapi.testclient import TestClient

from app.main import app
from app.core.reporter import Reporter


def test_reporter_contains_required_sections_and_html(tmp_path, monkeypatch):
    monkeypatch.setattr("app.config.settings.REPORT_DIR", str(tmp_path))
    content = Reporter().generate(
        task_id=7,
        task_title="quality",
        task_type="web_scan",
        task_description="本地 mock",
        target="http://example.test",
        plan_steps=[{"action": "HTTP 指纹识别", "phase": "execution", "tool": "HttpFingerprintTool", "reason": "识别标题"}],
        step_records=[{
            "step_index": 1,
            "phase": "execution",
            "action": "HTTP 指纹识别",
            "reason": "识别标题",
            "tool_name": "HttpFingerprintTool",
            "input_summary": "target=http://example.test",
            "output_summary": "HTTP 200 | Title: demo",
            "next_decision": "继续",
            "status": "success",
            "plan_source": "rule",
            "risk_level": "low",
            "confidence": 1.0,
            "tool_details": {"title": "demo"},
            "tool_evidence": ["HTTP 200"],
            "decision_trace": {"observation": "HTTP 200", "hypothesis": "站点可访问", "selected_action": "continue_plan", "reproducibility": {"result_hash": "abc"}},
        }],
        intent={"intent_type": "web_scan", "recommended_scenario": "web_scan", "input_modalities": ["url"], "confidence": 0.9},
    )
    for section in [
        "任务概览",
        "任务理解结果",
        "Agent 执行计划",
        "动态决策链",
        "工具调用结果摘要",
        "关键证据",
        "风险发现",
        "修复建议",
        "安全边界声明",
        "可复现信息",
        "DecisionTrace JSON",
    ]:
        assert section in content
    html_path = Reporter().save_html_report(7, content)
    html = open(html_path, encoding="utf-8").read()
    assert "<!doctype html>" in html.lower()
    assert "@media print" in html


def test_report_exists_before_completed_status():
    with TestClient(app) as client:
        upload = client.post(
            "/api/upload",
            files={"file": ("access.log", b'1.1.1.1 - - [01/Jan/2026:10:00:00 +0800] "GET /admin HTTP/1.1" 403 12\n')},
        )
        uploaded = upload.json()["path"]
        created = client.post("/api/tasks", json={
            "title": "report timing",
            "description": "日志分析",
            "task_type": "log_analysis",
            "target": "",
            "uploaded_file": uploaded,
        })
        task_id = created.json()["id"]
        client.post(f"/api/tasks/{task_id}/run")
        for _ in range(100):
            task = client.get(f"/api/tasks/{task_id}").json()
            if task["status"] == "completed":
                report = client.get(f"/api/tasks/{task_id}/report")
                assert report.status_code == 200
                assert task["report_status"] == "ready"
                steps = client.get(f"/api/tasks/{task_id}/steps").json()
                assert steps[-1]["tool_name"] == "Reporter"
                return
            time.sleep(0.1)
        raise AssertionError("task did not complete")


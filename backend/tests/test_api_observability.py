from fastapi.testclient import TestClient

from app.main import app


def test_health_and_tools_observability_fields():
    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        body = health.json()
        assert body["status"] == "ok"
        # 烛龙·玄枢 v5
        assert body["version"].startswith("5.")
        assert "烛龙" in body["app"]
        version = client.get("/api/version").json()
        assert version["edition"].startswith("烛龙·玄枢")
        assert body["database"] == "ok"
        assert isinstance(body["enabled_tools_count"], int)
        assert body["storage"]["uploads"] == "writable"
        assert body["storage"]["reports"] == "writable"

        tools = client.get("/api/tools").json()
        assert tools
        for tool in tools:
            for field in ["input_schema", "output_schema", "permissions", "risk_level", "enabled", "tags", "timeout_seconds"]:
                assert field in tool


def test_task_detail_exposes_uploaded_intent_report_status_and_step_trace(tmp_path):
    with TestClient(app) as client:
        upload = client.post(
            "/api/upload",
            files={"file": ("access.log", b'1.1.1.1 - - [01/Jan/2026:10:00:00 +0800] "GET / HTTP/1.1" 200 12\n')},
        )
        uploaded_path = upload.json()["path"]
        created = client.post("/api/tasks", json={
            "title": "observable task",
            "description": "日志分析",
            "task_type": "log_analysis",
            "target": "",
            "uploaded_file": uploaded_path,
        })
        task_id = created.json()["id"]
        detail = client.get(f"/api/tasks/{task_id}").json()
        assert detail["uploaded_file"] == uploaded_path
        assert "log_analysis" in detail["intent_result"]
        assert detail["report_status"] == "missing"

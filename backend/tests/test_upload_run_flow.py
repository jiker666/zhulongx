import time
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app


def _wait_for_done(client: TestClient, task_id: int, timeout: float = 10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = client.get(f"/api/tasks/{task_id}").json()
        if task["status"] in {"completed", "failed", "waiting_confirmation"}:
            return task
        time.sleep(0.1)
    raise AssertionError("task did not finish in time")


def test_upload_log_create_run_uses_uploaded_file_path(tmp_path: Path):
    with TestClient(app) as client:
        upload = client.post(
            "/api/upload",
            files={"file": ("access.log", b'1.1.1.1 - - [01/Jan/2026:10:00:00 +0800] "GET /admin HTTP/1.1" 403 12\n')},
        )
        assert upload.status_code == 200
        uploaded_path = upload.json()["path"]

        created = client.post("/api/tasks", json={
            "title": "log flow",
            "description": "分析上传日志",
            "task_type": "log_analysis",
            "target": "",
            "uploaded_file": uploaded_path,
        })
        task_id = created.json()["id"]
        client.post(f"/api/tasks/{task_id}/run")
        task = _wait_for_done(client, task_id)

        steps = client.get(f"/api/tasks/{task_id}/steps").json()
        assert task["status"] == "completed"
        assert any(s["tool_name"] == "FileParserTool" and uploaded_path in s["input_summary"] for s in steps)
        assert any(s["tool_name"] == "LogAnalyzerTool" and uploaded_path in s["input_summary"] for s in steps)


def test_upload_java_zip_create_run_reaches_java_audit(tmp_path: Path):
    archive = tmp_path / "code.zip"
    controller = """
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/order")
public class OrderController {
  @GetMapping("/{orderId}")
  public String detail(@PathVariable Long orderId) { return "ok"; }
}
"""
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("src/main/java/OrderController.java", controller)

    with TestClient(app) as client:
        upload = client.post("/api/upload", files={"file": ("code.zip", archive.read_bytes())})
        uploaded_path = upload.json()["path"]
        created = client.post("/api/tasks", json={
            "title": "java flow",
            "description": "审计 Java 越权",
            "task_type": "code_audit",
            "target": "",
            "uploaded_file": uploaded_path,
        })
        task_id = created.json()["id"]
        client.post(f"/api/tasks/{task_id}/run")
        task = _wait_for_done(client, task_id)

        steps = client.get(f"/api/tasks/{task_id}/steps").json()
        assert task["status"] == "completed"
        java_steps = [s for s in steps if s["tool_name"] == "JavaCodeAuditTool"]
        assert java_steps
        assert all(uploaded_path in s["input_summary"] for s in java_steps)
        assert any("HIGH" in s["output_summary"] or "风险" in s["output_summary"] for s in java_steps)

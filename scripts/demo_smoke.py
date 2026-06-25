#!/usr/bin/env python3
"""
Run three end-to-end demo scenarios with FastAPI TestClient.
"""
from __future__ import annotations

import http.server
import json
import os
import socketserver
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "samples" / "demo_outputs"
TMP_ROOT = Path(tempfile.mkdtemp(prefix="cyberpilot-demo-smoke-"))

os.environ["DATABASE_URL"] = f"sqlite:///{TMP_ROOT / 'demo_smoke.db'}"
os.environ["UPLOAD_DIR"] = str(TMP_ROOT / "uploads")
os.environ["REPORT_DIR"] = str(TMP_ROOT / "reports")
os.environ["LLM_ENABLED"] = "false"
os.environ["COMPETITION_MODE"] = "true"
os.environ["SCOPE_ALLOW_LOCALHOST"] = "true"
os.environ["SCOPE_ALLOW_PRIVATE_IPS"] = "true"
os.environ["SCOPE_CIDRS"] = "127.0.0.1/32"
os.environ["SCOPE_DOMAINS"] = "localhost"

sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402


def wait_for_done(client: TestClient, task_id: int, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = client.get(f"/api/tasks/{task_id}").json()
        if task["status"] in {"completed", "failed", "waiting_confirmation"}:
            return task
        time.sleep(0.1)
    raise AssertionError(f"task {task_id} did not finish within {timeout}s")


def upload_file(client: TestClient, path: Path, filename: str | None = None) -> str:
    response = client.post("/api/upload", files={"file": (filename or path.name, path.read_bytes())})
    assert response.status_code == 200, response.text
    return response.json()["path"]


def create_and_run(client: TestClient, payload: dict) -> tuple[dict, list[dict], dict]:
    created = client.post("/api/tasks", json=payload)
    assert created.status_code == 200, created.text
    task_id = created.json()["id"]
    run = client.post(f"/api/tasks/{task_id}/run")
    assert run.status_code == 200, run.text
    task = wait_for_done(client, task_id)
    assert task["status"] == "completed", task
    steps = client.get(f"/api/tasks/{task_id}/steps").json()
    report = client.get(f"/api/tasks/{task_id}/report").json()
    return task, steps, report


def write_report(name: str, report: dict) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{name}_report.md"
    path.write_text(report["content"], encoding="utf-8")
    return path


def java_demo(client: TestClient) -> dict:
    archive = TMP_ROOT / "java_insecure_demo.zip"
    sample_dir = ROOT / "backend" / "app" / "storage" / "samples" / "java_auth_demo"
    with zipfile.ZipFile(archive, "w") as zf:
        for java_file in sample_dir.glob("*.java"):
            zf.write(java_file, arcname=f"src/main/java/demo/{java_file.name}")
    uploaded = upload_file(client, archive, "java_insecure_demo.zip")
    task, steps, report = create_and_run(client, {
        "title": "Demo Java 越权审计",
        "description": "分析上传 Java ZIP 中的水平越权和资源归属校验风险",
        "task_type": "code_audit",
        "target": "",
        "uploaded_file": uploaded,
    })
    java_steps = [s for s in steps if s["tool_name"] == "JavaCodeAuditTool"]
    assert java_steps, "JavaCodeAuditTool was not executed"
    assert all(uploaded in s["input_summary"] for s in java_steps), "Java audit did not use uploaded_file"
    content = report["content"]
    for expected in ["OrderController", "getOrderDetail", "/api/order", "越权", "DecisionTrace"]:
        assert expected in content, f"Java report missing {expected}"
    out = write_report("java_audit", report)
    return {"task_id": task["id"], "report": str(out.relative_to(ROOT)), "steps": [s["tool_name"] for s in steps]}


def log_demo(client: TestClient) -> dict:
    uploaded = upload_file(client, ROOT / "samples" / "access.log")
    task, steps, report = create_and_run(client, {
        "title": "Demo 日志应急分析",
        "description": "分析 Nginx access.log 中的异常状态码、可疑路径和可疑 UA",
        "task_type": "log_analysis",
        "target": "",
        "uploaded_file": uploaded,
    })
    log_steps = [s for s in steps if s["tool_name"] == "LogAnalyzerTool"]
    assert log_steps, "LogAnalyzerTool was not executed"
    summary = "\n".join(s["output_summary"] for s in log_steps)
    for expected in ["4xx", "5xx", "可疑路径", "可疑 UA"]:
        assert expected in summary or expected in report["content"], f"log demo missing {expected}"
    for expected in ["Top IP", "Top Path", "时间窗口", "修复建议"]:
        assert expected in report["content"], f"log report missing {expected}"
    out = write_report("log_analysis", report)
    return {"task_id": task["id"], "report": str(out.relative_to(ROOT)), "steps": [s["tool_name"] for s in steps]}


class MockHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        routes = {
            "/": (200, "text/html", b'<html><title>CyberPilot Local Mock</title><script src="/assets/app.js"></script></html>'),
            "/robots.txt": (200, "text/plain", b"User-agent: *\nDisallow: /admin\n"),
            "/sitemap.xml": (200, "application/xml", b"<urlset></urlset>"),
            "/admin": (403, "text/plain", b"forbidden"),
            "/.well-known/security.txt": (200, "text/plain", b"Contact: security@example.test\n"),
            "/assets/app.js": (200, "application/javascript", b"fetch('/api/health'); axios.get('/v1/users'); axios.post('/graphql');"),
        }
        status, content_type, body = routes.get(self.path, (404, "text/plain", b"not found"))
        self.send_response(status)
        self.send_header("Server", "CyberPilotMock/1.0")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


def web_demo(client: TestClient) -> dict:
    with socketserver.TCPServer(("127.0.0.1", 0), MockHandler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        target = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            task, steps, report = create_and_run(client, {
                "title": "Demo Web 只读扫描",
                "description": "对授权本地 mock 站点执行只读指纹、固定路径探测和 JS API 提取",
                "task_type": "web_scan",
                "target": target,
                "uploaded_file": "",
            })
        finally:
            server.shutdown()
    tools = [s["tool_name"] for s in steps]
    for expected in ["HttpFingerprintTool", "DirectoryProbeTool", "JSInterfaceExtractorTool"]:
        assert expected in tools, f"{expected} was not executed"
    content = report["content"]
    for expected in ["CyberPilot Local Mock", "/api/health", "/v1/users", "/graphql"]:
        assert expected in content, f"web report missing {expected}"
    out = write_report("web_scan", report)
    return {"task_id": task["id"], "report": str(out.relative_to(ROOT)), "steps": tools}


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results: dict[str, dict] = {}
    with TestClient(app) as client:
        results["java_audit"] = java_demo(client)
        results["log_analysis"] = log_demo(client)
        results["web_scan"] = web_demo(client)
    summary_path = OUTPUT_DIR / "summary.json"
    summary_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    readme_path = OUTPUT_DIR / "README.md"
    readme_path.write_text(
        "# Demo Outputs\n\n"
        "Generated by `make demo-smoke`. Use these Markdown reports for PPT screenshots and demo video fallback.\n\n"
        "- `java_audit_report.md`: Java IDOR/BOLA audit evidence.\n"
        "- `log_analysis_report.md`: Nginx/JSON/Spring-style log analysis evidence.\n"
        "- `web_scan_report.md`: local mock read-only web scan evidence.\n"
        "- `summary.json`: task ids, reports, and executed tool chain.\n",
        encoding="utf-8",
    )
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

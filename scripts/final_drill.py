#!/usr/bin/env python3
"""
Generate and run FinalOps drill samples through the local FastAPI app.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SAMPLE_DIR = ROOT / "samples" / "final_drill"
OUTPUT_DIR = ROOT / "samples" / "final_drill_outputs"
TMP_ROOT = Path(tempfile.mkdtemp(prefix="cyberpilot-final-drill-"))


def write_json(path: Path, data: dict | list) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_sample(name: str, meta: dict, files: dict[str, bytes | str], expected: list[str]) -> None:
    d = SAMPLE_DIR / name
    d.mkdir(parents=True, exist_ok=True)
    attachment = meta.get("attachment", "artifact.txt")
    challenge = {
        "name": meta.get("title", name),
        "challenge_type": meta.get("type", "unknown"),
        "description": meta.get("description", ""),
        "target": meta.get("target", ""),
        "attachment": attachment,
        "tags": ["final-drill", meta.get("type", "unknown")],
        "priority": meta.get("priority", "medium"),
        "assignee": meta.get("assignee", ""),
    }
    write_json(d / "challenge.json", challenge)
    (d / "README.md").write_text(f"# {challenge['name']}\n\n{challenge['description']}\n", encoding="utf-8")
    write_json(d / "expected_findings.json", {"interesting": meta.get("findings", []), "recommended_tools": meta.get("tools", [])})
    write_json(d / "expected_answer_candidates.json", [{"candidate": c, "validation_status": "unverified"} for c in expected])
    for rel, content in files.items():
        path = d / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")


def ensure_samples() -> None:
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    samples = [
        ("web-js-api-demo", {"type": "web", "attachment": "index.html", "description": "HTML/JS 附件提取 API 路径和候选答案", "tools": ["JSInterfaceExtractorTool", "APIRunnerTool"]}, {
            "index.html": "<html data-answer=\"flag{web_js_api_demo}\"><script src=\"app.js\"></script></html>",
            "app.js": "fetch('/api/profile'); const answer='flag{web_js_api_demo}';",
        }, ["flag{web_js_api_demo}"]),
        ("web-openapi-demo", {"type": "web", "attachment": "openapi.json", "description": "OpenAPI 路径识别和 GET 接口建议", "tools": ["APIRunnerTool"]}, {
            "openapi.json": json.dumps({"openapi": "3.0.0", "paths": {"/api/flag": {"get": {"summary": "flag{web_openapi_demo}"}}}}, ensure_ascii=False),
        }, ["flag{web_openapi_demo}"]),
        ("java-authz-demo", {"type": "code", "attachment": "java-authz-demo.zip", "description": "Java Controller 与资源 ID 线索", "tools": ["JavaCodeAuditTool"]}, {}, ["flag{java_authz_demo}"]),
        ("spring-log-incident-demo", {"type": "log", "attachment": "spring.log", "description": "Spring 日志时间线与异常事件", "tools": ["LogAnalyzerTool"]}, {
            "spring.log": "2026-06-09 10:01:02 WARN auth GET /admin 403 flag{spring_log_incident_demo}\n",
        }, ["flag{spring_log_incident_demo}"]),
        ("nginx-suspicious-path-demo", {"type": "log", "attachment": "access.log", "description": "Nginx suspicious path drill", "tools": ["LogAnalyzerTool"]}, {
            "access.log": '10.1.1.2 - - [09/Jun/2026:10:00:00 +0800] "GET /admin?next=flag{nginx_path_demo} HTTP/1.1" 403 12 "-" "curl/8"\n',
        }, ["flag{nginx_path_demo}"]),
        ("misc-base64-chain-demo", {"type": "misc", "attachment": "encoded.txt", "description": "Base64 编码链识别", "tools": ["ArtifactTriageTool"]}, {
            "encoded.txt": "payload=" + base64.b64encode(b"flag{misc_base64_chain_demo}").decode() + "\n",
        }, ["flag{misc_base64_chain_demo}"]),
        ("crypto-simple-xor-demo", {"type": "crypto", "attachment": "cipher.txt", "description": "简单编码/crypto 训练样例", "tools": ["ArtifactTriageTool"]}, {
            "cipher.txt": "hex=666c61677b63727970746f5f786f725f64656d6f7d\nhint=xor key is in title\n",
        }, ["flag{crypto_xor_demo}"]),
        ("reverse-strings-demo", {"type": "reverse", "attachment": "mock.bin", "description": "逆向 strings 只读识别", "tools": ["FileParserTool"]}, {
            "mock.bin": b"MZ\x90\x00This program cannot be run in DOS mode.\x00flag{reverse_strings_demo}\x00",
        }, ["flag{reverse_strings_demo}"]),
        ("pcap-http-demo", {"type": "pcap", "attachment": "traffic.pcap", "description": "pcap mock HTTP 明文线索", "tools": ["ArtifactTriageTool"]}, {
            "traffic.pcap": b"\xd4\xc3\xb2\xa1\x02\x00\x04\x00" + b"GET /flag{pcap_http_demo} HTTP/1.1\r\nHost: target\r\n\r\n",
        }, ["flag{pcap_http_demo}"]),
        ("mixed-project-demo", {"type": "misc", "attachment": "mixed-project.zip", "description": "混合前端/配置项目线索", "tools": ["ArtifactTriageTool", "JSInterfaceExtractorTool"]}, {}, ["flag{mixed_project_demo}"]),
    ]
    for name, meta, files, expected in samples:
        write_sample(name, meta, files, expected)

    java_zip = SAMPLE_DIR / "java-authz-demo" / "java-authz-demo.zip"
    with zipfile.ZipFile(java_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("src/main/java/demo/OrderController.java", """
package demo;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/order")
public class OrderController {
  @GetMapping("/{orderId}")
  public String detail(@PathVariable String orderId) { return "flag{java_authz_demo}"; }
}
""")

    mixed_zip = SAMPLE_DIR / "mixed-project-demo" / "mixed-project.zip"
    with zipfile.ZipFile(mixed_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("package.json", '{"scripts":{"start":"vite"}}')
        zf.writestr("src/app.js", "const encoded='ZmxhZ3ttaXhlZF9wcm9qZWN0X2RlbW99'; fetch('/api/mixed')")

    artifact_zip = ROOT / "samples" / "artifact_triage_demo.zip"
    with zipfile.ZipFile(artifact_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("README.md", "base64=" + base64.b64encode(b"flag{artifact_triage_demo}").decode())
        zf.writestr("logs/access.log", '127.0.0.1 - - "GET /admin HTTP/1.1" 403 12 "-" "curl/8"')
        zf.writestr("src/app.js", "fetch('/api/demo')")


def main() -> int:
    ensure_samples()
    os.environ["DATABASE_URL"] = f"sqlite:///{TMP_ROOT / 'final_drill.db'}"
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

    results = []
    started = time.time()
    with TestClient(app) as client:
        for challenge_json in sorted(SAMPLE_DIR.glob("*/challenge.json")):
            data = json.loads(challenge_json.read_text(encoding="utf-8"))
            attachment = data.pop("attachment", "")
            if attachment:
                data["uploaded_file"] = str(challenge_json.parent / attachment)
            created = client.post("/api/challenges", json=data)
            if created.status_code != 200:
                results.append({"sample": challenge_json.parent.name, "success": False, "error": created.text})
                continue
            cid = created.json()["id"]
            triage = client.post(f"/api/challenges/{cid}/run-triage")
            ok = triage.status_code == 200
            body = triage.json() if ok else {"error": triage.text}
            results.append({
                "sample": challenge_json.parent.name,
                "challenge_id": cid,
                "success": ok,
                "status": body.get("status"),
                "candidate_count": len(body.get("answer_candidates", [])) if ok else 0,
                "evidence_count": len(body.get("evidence", [])) if ok else 0,
                "top_candidate": (body.get("answer_candidates", [{}]) or [{}])[0].get("candidate", "") if ok else "",
            })
    elapsed = round(time.time() - started, 3)
    success = sum(1 for r in results if r["success"])
    failures = len(results) - success
    candidates = sum(r.get("candidate_count", 0) for r in results)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = {"elapsed_seconds": elapsed, "success": success, "failures": failures, "candidate_count": candidates, "results": results}
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "README.md").write_text(
        "# Final Drill Outputs\n\nGenerated by `make final-drill`.\n\n"
        f"- elapsed_seconds: {elapsed}\n- success: {success}\n- failures: {failures}\n- candidate_count: {candidates}\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

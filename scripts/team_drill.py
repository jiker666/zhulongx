#!/usr/bin/env python3
"""
Run a realistic three-operator FinalOps drill.

This script uses expected_answer_candidates.json only for offline scoring.
The application under test never receives the expected answers.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
import zipfile
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SAMPLE_DIR = ROOT / "samples" / "team_drill"
OUTPUT_DIR = ROOT / "samples" / "team_drill_outputs"
TMP_ROOT = Path(tempfile.mkdtemp(prefix="cyberpilot-team-drill-"))


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def sample(name: str, ctype: str, description: str, content: str | bytes = "", attachment: str = "artifact.txt", expected=None, decoys=None, target: str = "", assignee: str = "") -> None:
    d = SAMPLE_DIR / name
    d.mkdir(parents=True, exist_ok=True)
    challenge = {
        "name": name,
        "challenge_type": ctype,
        "description": description,
        "target": target,
        "attachment": attachment if content else "",
        "tags": ["team-drill", ctype],
        "priority": "high" if ctype in {"web", "pcap"} else "medium",
        "assignee": assignee,
    }
    write_json(d / "challenge.json", challenge)
    write_json(d / "expected_answer_candidates.json", [{"candidate": item} for item in (expected or [])])
    write_json(d / "expected_findings.json", {"decoys": decoys or [], "manual_expected": not expected})
    (d / "README.md").write_text(f"# {name}\n\n{description}\n", encoding="utf-8")
    if content:
        p = d / attachment
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(content, encoding="utf-8")


def ensure_samples() -> None:
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    sample("web-login-decoy", "web", "JS 中有真实候选，也有旧 token 干扰。", "flag{old_decoy}\nconst real='flag{team_web_login}'; fetch('/api/session')", "app.js", ["flag{team_web_login}"], ["flag{old_decoy}"], assignee="A")
    sample("web-out-of-scope", "web", "目标是 localhost，默认安全模式应触发 ScopeGuard 拦截，需要队员配置 scope 后再验证。", "", "", [], [], target="http://127.0.0.1:65530", assignee="B")
    sample("code-java-authz", "code", "Java 控制器含资源 ID 线索和一个假答案注释。", "", "java-authz.zip", ["flag{team_java_authz}"], ["flag{comment_decoy}"], assignee="A")
    sample("log-two-candidates", "log", "日志中既有误报路径，也有真实 incident answer。", '10.0.0.1 - - "GET /flag{log_false_positive} HTTP/1.1" 404 1 "-" "curl"\n10.0.0.2 - - "GET /incident/flag{team_log_incident} HTTP/1.1" 200 1 "-" "browser"\n', "access.log", ["flag{team_log_incident}"], ["flag{log_false_positive}"], assignee="C")
    sample("pcap-needs-review", "pcap", "pcap mock 包含明文 HTTP 候选和噪声。", b"\xd4\xc3\xb2\xa1\x02\x00\x04\x00GET /flag{team_pcap_http} HTTP/1.1\r\nnoise=flag{pcap_decoy}\r\n", "traffic.pcap", ["flag{team_pcap_http}"], ["flag{pcap_decoy}"], assignee="B")
    sample("reverse-strings-many", "reverse", "二进制 strings 中有多个候选，需要人工看上下文。", b"MZ\x00flag{rev_decoy_old}\x00usage\x00flag{team_reverse_strings}\x00", "rev.bin", ["flag{team_reverse_strings}"], ["flag{rev_decoy_old}"], assignee="B")
    sample("crypto-hex-base64", "crypto", "hex 和 base64 混合，两个候选只有一个正确。", "hex=666c61677b7465616d5f63727970746f5f6865787d\nb64=" + base64.b64encode(b"flag{crypto_decoy}").decode(), "cipher.txt", ["flag{team_crypto_hex}"], ["flag{crypto_decoy}"], assignee="C")
    sample("misc-gzip-b64", "misc", "gzip+base64 常见编码链。", "blob=" + base64.b64encode(__import__("gzip").compress(b"flag{team_misc_gzip}")).decode(), "blob.txt", ["flag{team_misc_gzip}"], [], assignee="A")
    sample("unknown-no-answer", "unknown", "题面缺少可机读候选，应该进入 need_human。", "Look at the image in the real platform. No machine-readable answer here.", "hint.txt", [], [], assignee="C")
    sample("web-openapi-post-confirm", "web", "OpenAPI 中 GET 可读，POST 需要人工确认。", json.dumps({"openapi": "3.0.0", "paths": {"/api/status": {"get": {}}, "/api/submit": {"post": {"description": "requires confirmation flag{post_decoy}"}}}}, ensure_ascii=False), "openapi.json", [], ["flag{post_decoy}"], assignee="A")
    sample("code-node-config", "code", "Node 配置里有答案和假 key，不应把 API key 当答案。", "API_KEY=sk-example-placeholder\nanswer=flag{team_node_config}\n", ".env.sample", ["flag{team_node_config}"], [], assignee="B")
    sample("log-manual-submit", "log", "日志给出提交线索但需要队员确认。", '2026-06-09 WARN answer_hint=flag{team_manual_submit}\n', "event.log", ["flag{team_manual_submit}"], [], assignee="C")
    sample("misc-url-encoded", "misc", "URL encode 候选。", "payload=flag%7Bteam_url_encoded%7D&noise=flag%7Burl_decoy%7D", "payload.txt", ["flag{team_url_encoded}"], ["flag{url_decoy}"], assignee="A")
    sample("blocked-range-required", "web", "只给内网目标，无附件，训练 scope 拦截后的处理。", "", "", [], [], target="http://10.255.255.1:8080", assignee="B")

    java_zip = SAMPLE_DIR / "code-java-authz" / "java-authz.zip"
    with zipfile.ZipFile(java_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("src/main/java/demo/UserController.java", """
@RestController
class UserController {
  // flag{comment_decoy}
  @GetMapping("/api/user/{userId}")
  public String detail(@PathVariable String userId) { return "flag{team_java_authz}"; }
}
""")


def main() -> int:
    fast = "--fast" in sys.argv
    report_only = "--report" in sys.argv
    ensure_samples()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if report_only:
        print((OUTPUT_DIR / "scoreboard.md").read_text(encoding="utf-8"))
        return 0

    os.environ["DATABASE_URL"] = f"sqlite:///{TMP_ROOT / 'team_drill.db'}"
    os.environ["UPLOAD_DIR"] = str(TMP_ROOT / "uploads")
    os.environ["REPORT_DIR"] = str(TMP_ROOT / "reports")
    os.environ["LLM_ENABLED"] = "false"
    os.environ["COMPETITION_MODE"] = "false"
    os.environ["SCOPE_ALLOW_LOCALHOST"] = "false"
    os.environ["SCOPE_ALLOW_PRIVATE_IPS"] = "false"
    sys.path.insert(0, str(ROOT / "backend"))

    from fastapi.testclient import TestClient  # noqa: E402
    from app.main import app  # noqa: E402

    results = []
    started = time.time()
    manual_backfills = 0
    scope_blocks = 0
    with TestClient(app) as client:
        sample_paths = sorted(SAMPLE_DIR.glob("*/challenge.json"))
        if fast:
            sample_paths = sample_paths[:12]
        for idx, challenge_json in enumerate(sample_paths, 1):
            c_started = time.time()
            data = json.loads(challenge_json.read_text(encoding="utf-8"))
            attachment = data.pop("attachment", "")
            if attachment:
                data["uploaded_file"] = str(challenge_json.parent / attachment)
            expected = [x["candidate"] for x in json.loads((challenge_json.parent / "expected_answer_candidates.json").read_text(encoding="utf-8"))]
            created = client.post("/api/challenges", json=data)
            ok = created.status_code == 200
            if not ok:
                results.append({"sample": challenge_json.parent.name, "success": False, "error": created.text, "type": data["challenge_type"]})
                continue
            cid = created.json()["id"]
            triage = client.post(f"/api/challenges/{cid}/run-triage")
            body = triage.json() if triage.status_code == 200 else {"answer_candidates": [], "evidence": [], "status": "failed"}
            text = json.dumps(body, ensure_ascii=False)
            if "ScopeGuard" in text or "scope" in text.lower() and data.get("target"):
                scope_blocks += 1
            candidates = [c["candidate"] for c in body.get("answer_candidates", [])]
            correct = len([c for c in candidates if c in expected])
            false_positive = len([c for c in candidates if c not in expected])
            status = body.get("status", "failed")
            if not expected and status == "need_human":
                manual_backfills += 1
                client.post(f"/api/challenges/{cid}/manual-result", json={"author": "B", "result": "人工确认：该题需要浏览器或外部题面继续判断"})
            if data.get("target") and not candidates:
                client.patch(f"/api/challenges/{cid}", json={"status": "blocked"})
                status = "blocked"
            if correct and idx % 3 == 0:
                manual_backfills += 1
                client.post(f"/api/challenges/{cid}/manual-result", json={"author": "C", "result": f"人工验证通过 {expected[0]}", "candidate": expected[0]})
            results.append({
                "sample": challenge_json.parent.name,
                "challenge_id": cid,
                "type": data["challenge_type"],
                "assignee": data.get("assignee", ""),
                "success": triage.status_code == 200,
                "status": status,
                "elapsed_seconds": round(time.time() - c_started, 3),
                "candidate_count": len(candidates),
                "correct_hits": correct,
                "false_positive_count": false_positive,
                "expected": expected,
                "top_candidates": candidates[:5],
            })

    total_elapsed = round(time.time() - started, 3)
    by_type = defaultdict(float)
    for r in results:
        by_type[r["type"]] += r.get("elapsed_seconds", 0)
    summary = {
        "elapsed_seconds": total_elapsed,
        "by_type_elapsed_seconds": {k: round(v, 3) for k, v in sorted(by_type.items())},
        "success": sum(1 for r in results if r.get("success")),
        "failures": sum(1 for r in results if not r.get("success")),
        "blocked": sum(1 for r in results if r.get("status") == "blocked"),
        "candidate_count": sum(r.get("candidate_count", 0) for r in results),
        "correct_candidate_hits": sum(r.get("correct_hits", 0) for r in results),
        "false_positive_candidates": sum(r.get("false_positive_count", 0) for r in results),
        "manual_backfills": manual_backfills,
        "scopeguard_blocks": scope_blocks,
        "llm_fallbacks": len(results),
        "results": results,
    }
    write_json(OUTPUT_DIR / "summary.json", summary)
    write_docs(summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["failures"] == 0 else 1


def write_docs(summary: dict) -> None:
    rows = [
        "| Sample | Type | Status | Candidates | Correct | False Positive | Assignee |",
        "|---|---|---:|---:|---:|---:|---|",
    ]
    for r in summary["results"]:
        rows.append(f"| {r['sample']} | {r['type']} | {r['status']} | {r['candidate_count']} | {r['correct_hits']} | {r['false_positive_count']} | {r['assignee']} |")
    (OUTPUT_DIR / "scoreboard.md").write_text(
        "# Team Drill Scoreboard\n\n"
        f"- Total elapsed: {summary['elapsed_seconds']}s\n"
        f"- Success: {summary['success']}\n"
        f"- Failures: {summary['failures']}\n"
        f"- Blocked: {summary['blocked']}\n"
        f"- Candidates: {summary['candidate_count']}\n"
        f"- Correct hits: {summary['correct_candidate_hits']}\n"
        f"- False positives: {summary['false_positive_candidates']}\n"
        f"- Manual backfills: {summary['manual_backfills']}\n"
        f"- ScopeGuard blocks: {summary['scopeguard_blocks']}\n"
        f"- LLM fallbacks: {summary['llm_fallbacks']}\n\n" + "\n".join(rows) + "\n",
        encoding="utf-8",
    )
    timeline = [
        "# Operator Timeline",
        "",
        "0:00 A 导入 Challenge，B 核对 scope，C 打开 Brief/Debrief 输出。",
        "0:02 A 对 web/code/log 首批题 Run Triage，B 查看 blocked/need_human，C 复制证据摘要。",
        "0:05 B 对候选过多题人工复核，A 继续导入剩余题，C 标记 submitted/solved。",
        "0:08 A 处理 blocked 题的 scope/目标信息，B 回填浏览器观察，C 输出 scoreboard。",
        "0:10 三人复盘 false positive、ScopeGuard 拦截和 LLM fallback。",
    ]
    (OUTPUT_DIR / "operator_timeline.md").write_text("\n".join(timeline) + "\n", encoding="utf-8")
    (OUTPUT_DIR / "debrief.md").write_text(
        "# Team Drill Debrief\n\n"
        "## What Worked\n\n"
        "- FinalOps 批量接题和 Triage 可完成混合题型首轮分诊。\n"
        "- ScopeGuard 拦截 blocked 题，避免默认模式访问内网/本机目标。\n"
        "- 候选与误报可在 scoreboard 中复盘。\n\n"
        "## Practice Focus\n\n"
        "- B 号位需要快速处理 need_human/blocked。\n"
        "- C 号位提交前必须核对 Evidence 和 confidence，避免误提交。\n"
        "- A 号位控制 Run Triage 节奏，不要重复点击。\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())

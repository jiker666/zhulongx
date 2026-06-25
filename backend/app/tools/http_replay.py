"""
Controlled HTTP replay for in-scope competition targets.
"""
from __future__ import annotations

from typing import Any, Dict
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.core.answer_extractor import AnswerCandidateExtractor
from app.core.evidence_vault import evidence_vault
from app.core.scope_guard import scope_guard
from app.database import SessionLocal
from app.tools.base import BaseTool


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
MAX_RESPONSE_BYTES = 512 * 1024


class HttpReplayTool(BaseTool):
    name = "HttpReplayTool"
    description = "在 ScopeGuard 授权范围内重放少量 HTTP 请求；默认只执行 GET/HEAD/OPTIONS"
    category = "web"
    input_schema = {
        "type": "object",
        "properties": {
            "method": {"type": "string"},
            "url": {"type": "string"},
            "headers": {"type": "object"},
            "params": {"type": "object"},
            "body": {"type": "string"},
            "reason": {"type": "string"},
            "challenge_id": {"type": "integer"},
            "confirmed": {"type": "boolean"},
        },
        "required": ["method", "url", "reason"],
    }
    output_schema = {"type": "object", "properties": {"status_code": {"type": "integer"}, "evidence_id": {"type": "string"}}}
    permissions = ["network_read"]
    risk_level = "medium"
    timeout_seconds = 10
    tags = ["web", "api", "replay", "scope_guard", "final_ops"]

    def __init__(self) -> None:
        self.extractor = AnswerCandidateExtractor()

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        method = (context.get("method") or "GET").upper()
        url = context.get("url") or context.get("target") or ""
        reason = (context.get("reason") or "").strip()
        if not reason:
            return {"success": False, "summary": "缺少 reason，拒绝发送请求", "details": {"requires_reason": True}, "evidence": []}
        if method not in SAFE_METHODS | UNSAFE_METHODS:
            return {"success": False, "summary": f"不支持的 HTTP 方法: {method}", "details": {"method": method}, "evidence": []}
        if method in UNSAFE_METHODS and not bool(context.get("confirmed")):
            return {
                "success": False,
                "summary": f"{method} 请求需要人工确认，未发送",
                "details": {"requires_confirmation": True, "method": method, "url": url, "reason": reason},
                "evidence": ["中高风险/可能改变状态的请求必须人工确认"],
            }

        decision = scope_guard.validate_and_record(url, context.get("task_id"))
        if not decision.allowed:
            return {
                "success": False,
                "summary": f"目标被 ScopeGuard 拒绝: {decision.reason}",
                "details": {"error_type": "scope_blocked", "scope_decision": decision.to_dict()},
                "evidence": [decision.reason],
            }
        normalized = decision.normalized_url
        params = context.get("params") or {}
        headers = self._safe_headers(context.get("headers") or {})
        body = context.get("body") or None

        try:
            with httpx.Client(timeout=settings.DEFAULT_HTTP_TIMEOUT, follow_redirects=True) as client:
                resp = client.request(method, normalized, headers=headers, params=params, content=body)
            content = resp.content[:MAX_RESPONSE_BYTES]
            body_text = content.decode(resp.encoding or "utf-8", errors="ignore")
            candidates = self.extractor.extract(body_text, f"http:{method}:{normalized}")
            evidence_id = ""
            challenge_id = context.get("challenge_id")
            task_id = context.get("task_id")
            if challenge_id or task_id:
                db = SessionLocal()
                try:
                    evidence = evidence_vault.create(
                        db,
                        "HttpReplayTool",
                        f"{method} {normalized} | reason={reason}",
                        f"HTTP {resp.status_code}\n{body_text[:1200]}",
                        challenge_id=challenge_id,
                        task_id=task_id,
                        reproduction_hint=f"HttpReplayTool {method} {normalized}",
                    )
                    evidence_id = evidence.evidence_uid
                finally:
                    db.close()
            details = {
                "url": str(resp.url),
                "status_code": resp.status_code,
                "headers": {k: v for k, v in list(resp.headers.items())[:20]},
                "body_excerpt": body_text[:2000],
                "response_size": len(resp.content),
                "response_truncated": len(resp.content) > MAX_RESPONSE_BYTES,
                "redirect_chain": [str(r.url) for r in resp.history] + [str(resp.url)],
                "evidence_id": evidence_id,
                "answer_candidates": candidates,
                "scope_decision": decision.to_dict(),
                "next_suggestion": "若需发送非 GET 请求，请在 FinalOps 中补充 reason 并人工确认。",
            }
            return {
                "success": True,
                "summary": f"{method} {normalized} -> HTTP {resp.status_code}，候选答案 {len(candidates)} 个",
                "details": details,
                "evidence": [f"HTTP {resp.status_code} {normalized}", evidence_id] + [c["candidate"] for c in candidates[:3]],
            }
        except httpx.TimeoutException:
            return {"success": False, "summary": f"请求超时: {normalized}", "details": {"error_type": "timeout"}, "evidence": ["HTTP 请求超时"]}
        except Exception as exc:
            return {"success": False, "summary": f"HTTP 请求失败: {type(exc).__name__}: {exc}", "details": {"error_type": type(exc).__name__, "error": str(exc)}, "evidence": []}

    def _safe_headers(self, headers: Dict[str, Any]) -> Dict[str, str]:
        blocked = {"authorization", "cookie", "x-api-key"}
        safe: Dict[str, str] = {}
        for key, value in headers.items():
            if str(key).lower() in blocked:
                continue
            safe[str(key)] = str(value)[:500]
        return safe

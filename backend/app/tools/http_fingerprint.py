"""
HttpFingerprintTool - HTTP fingerprint detection (non-attack, read-only).
"""
from typing import Any, Dict

import httpx

from app.config import settings
from app.core.scope_guard import scope_guard
from app.tools.base import BaseTool


class HttpFingerprintTool(BaseTool):
    name = "HttpFingerprintTool"
    description = "对目标 URL 执行 HTTP GET，获取状态码、标题、Server、Content-Type 等基础信息（非攻击性）"
    category = "web"
    input_schema = {
        "type": "object",
        "properties": {"target": {"type": "string", "description": "授权分析目标 URL"}},
        "required": ["target"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "status_code": {"type": "integer"},
            "redirect_chain": {"type": "array", "items": {"type": "string"}},
            "title": {"type": "string"},
            "server": {"type": "string"},
            "content_type": {"type": "string"},
            "response_size": {"type": "integer"},
        },
    }
    permissions = ["network_read"]
    risk_level = "low"
    timeout_seconds = 10
    tags = ["web", "fingerprint", "ssrf_protected"]

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        url: str = context.get("target", "")
        if not url:
            return {
                "success": False,
                "summary": "未提供目标 URL",
                "details": {},
                "evidence": [],
            }

        decision = scope_guard.validate_and_record(url, context.get("task_id"))
        url = decision.normalized_url
        if not decision.allowed:
            return {
                "success": False,
                "summary": f"目标被 ScopeGuard 拒绝: {decision.reason}",
                "details": {"url": url, "error_type": "ssrf_blocked", "reason": decision.reason, "scope_decision": decision.to_dict()},
                "evidence": [decision.reason],
            }

        try:
            resp = httpx.get(url, timeout=settings.DEFAULT_HTTP_TIMEOUT, follow_redirects=True)
            title = ""
            content = resp.text[:4096]
            # Simple title extraction
            import re
            title_match = re.search(r"<title[^>]*>(.*?)</title>", content, re.IGNORECASE | re.DOTALL)
            if title_match:
                title = title_match.group(1).strip()[:128]

            server = resp.headers.get("server", "")
            content_type = resp.headers.get("content-type", "")
            x_powered_by = resp.headers.get("x-powered-by", "")

            details = {
                "url": url,
                "status_code": resp.status_code,
                "redirect_chain": [str(r.url) for r in resp.history] + [str(resp.url)],
                "title": title,
                "server": server,
                "content_type": content_type,
                "x_powered_by": x_powered_by,
                "response_size": len(resp.content),
                "scope_decision": decision.to_dict(),
            }

            evidence = [f"HTTP {resp.status_code} | Server: {server} | Title: {title}"]

            return {
                "success": True,
                "summary": f"HTTP {resp.status_code} | {url} | Server: {server or 'unknown'} | Title: {title or '(无标题)'}",
                "details": details,
                "evidence": evidence,
            }
        except httpx.TimeoutException:
            return {
                "success": False,
                "summary": f"请求超时: {url}",
                "details": {"url": url, "error_type": "timeout", "next_suggestion": "缩短目标或检查网络连通性后重试"},
                "evidence": ["HTTP 请求超时"],
            }
        except Exception as e:
            return {
                "success": False,
                "summary": f"HTTP 请求失败: {str(e)}",
                "details": {"url": url, "error_type": type(e).__name__, "error": str(e), "next_suggestion": "确认目标 URL、DNS 和授权范围"},
                "evidence": [f"HTTP 请求失败: {type(e).__name__}"],
            }

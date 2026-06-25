"""
DirectoryProbeTool - probe a small fixed set of safe paths (non-attack).
"""
from typing import Any, Dict, List

import httpx

from app.config import settings
from app.core.scope_guard import scope_guard
from app.tools.base import BaseTool

SAFE_PATHS = [
    "/",
    "/robots.txt",
    "/sitemap.xml",
    "/favicon.ico",
    "/login",
    "/admin",
    "/.well-known/security.txt",
]


class DirectoryProbeTool(BaseTool):
    name = "DirectoryProbeTool"
    description = "探测目标站点少量固定安全路径，获取 HTTP 状态码（非爆破、非攻击）"
    category = "web"
    input_schema = {
        "type": "object",
        "properties": {"target": {"type": "string", "description": "授权分析目标 URL"}},
        "required": ["target"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "base_url": {"type": "string"},
            "probed_paths": {"type": "array", "items": {"type": "object"}},
        },
    }
    permissions = ["network_read"]
    risk_level = "low"
    timeout_seconds = 8
    tags = ["web", "safe_probe", "ssrf_protected"]

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        url: str = context.get("target", "")
        if not url:
            return {
                "success": False,
                "summary": "未提供目标 URL",
                "details": {},
                "evidence": [],
            }

        decision = scope_guard.validate_url(url)
        url = decision.normalized_url
        if not decision.allowed:
            return {
                "success": False,
                "summary": f"目标被 ScopeGuard 拒绝: {decision.reason}",
                "details": {"url": url, "error_type": "ssrf_blocked", "reason": decision.reason, "scope_decision": decision.to_dict()},
                "evidence": [decision.reason],
            }

        base = url.rstrip("/")
        results: List[Dict] = []
        evidence: List[str] = []

        for path in SAFE_PATHS:
            req_url = base + path
            req_decision = scope_guard.validate_and_record(req_url, context.get("task_id"))
            if not req_decision.allowed:
                results.append({"path": path, "url": req_url, "status": "blocked", "reason": req_decision.reason})
                continue
            try:
                resp = httpx.get(req_decision.normalized_url, timeout=settings.DEFAULT_HTTP_TIMEOUT, follow_redirects=False)
                item = {
                    "path": path,
                    "url": req_decision.normalized_url,
                    "status": resp.status_code,
                    "content_type": resp.headers.get("content-type", ""),
                    "response_size": len(resp.content),
                    "scope": req_decision.matched_scope,
                }
                results.append(item)
                if resp.status_code in (200, 301, 302):
                    evidence.append(f"{req_url} -> {resp.status_code} {item['content_type']} {item['response_size']}B")
            except Exception as e:
                results.append({"path": path, "url": req_url, "status": "error", "error_type": type(e).__name__})

        accessible = [r for r in results if r["status"] in (200, 301, 302)]

        return {
            "success": True,
            "summary": f"探测 {len(SAFE_PATHS)} 个路径，发现 {len(accessible)} 个可访问路径",
            "details": {"probed_paths": results, "base_url": base},
            "evidence": evidence,
        }

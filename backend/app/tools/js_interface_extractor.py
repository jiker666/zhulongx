"""
JSInterfaceExtractorTool - extract API paths from JS/HTML content.
"""
import re
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urljoin, urlparse

import httpx

from app.config import settings
from app.core.scope_guard import scope_guard
from app.tools.base import BaseTool
from app.tools.http_safety import validate_http_target

API_PATTERN = re.compile(
    r"""['"]((?:/api|/v\d+|/graphql|/admin|/auth|/user|/internal|/service)[/\w\-\.{}:?=&%]*)['""]""",
    re.IGNORECASE,
)
CALL_PATTERN = re.compile(
    r"""(?:fetch|axios(?:\.\w+)?)\s*\(\s*['"]([^'"]+)['"]""",
    re.IGNORECASE,
)
SCRIPT_PATTERN = re.compile(r"""<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']""", re.IGNORECASE)
FULL_URL_PATTERN = re.compile(r"""https?://[^\s"'<>]+""", re.IGNORECASE)
MAX_JS_FILES = 5
MAX_JS_BYTES = 1024 * 1024


class JSInterfaceExtractorTool(BaseTool):
    name = "JSInterfaceExtractorTool"
    description = "从 JS 文件或 HTML 内容中提取疑似 API 路径"
    category = "code"
    input_schema = {
        "type": "object",
        "properties": {
            "target": {"type": "string", "description": "授权 Web 目标 URL"},
            "file_path": {"type": "string", "description": "本地 JS/HTML 文件路径"},
            "content": {"type": "string", "description": "可选内联内容"},
        },
    }
    output_schema = {
        "type": "object",
        "properties": {
            "api_paths": {"type": "array", "items": {"type": "string"}},
            "sources": {"type": "array", "items": {"type": "object"}},
        },
    }
    permissions = ["local_file_read", "network_read"]
    risk_level = "low"
    timeout_seconds = 8
    tags = ["js", "api_discovery", "ssrf_protected"]

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        file_path: str = context.get("file_path", "")
        content: str = context.get("content", "")
        target: str = context.get("target", "")
        sources: List[Dict[str, Any]] = []

        if file_path and not content:
            try:
                p = Path(file_path)
                content = p.read_text(encoding="utf-8", errors="ignore")
                sources.append({"type": "file", "location": str(p), "size": len(content.encode("utf-8", errors="ignore"))})
            except Exception as e:
                return {
                    "success": False,
                    "summary": f"读取文件失败: {e}",
                    "details": {},
                    "evidence": [],
                }

        if target and not content:
            fetched = self._fetch_target_content(target)
            if not fetched["success"]:
                return fetched
            content = fetched["content"]
            sources = fetched["sources"]

        if not content:
            return {
                "success": False,
                "summary": "没有可分析的内容",
                "details": {},
                "evidence": [],
            }

        unique_paths = self._extract_paths(content, target)

        return {
            "success": True,
            "summary": f"提取到 {len(unique_paths)} 个疑似 API 路径",
            "details": {"api_paths": unique_paths, "total": len(unique_paths), "sources": sources},
            "evidence": unique_paths[:20],
        }

    def _fetch_target_content(self, target: str) -> Dict[str, Any]:
        decision = scope_guard.validate_and_record(target)
        url = decision.normalized_url
        if not decision.allowed:
            return {
                "success": False,
                "summary": f"目标被 ScopeGuard 拒绝: {decision.reason}",
                "details": {"url": url, "error_type": "ssrf_blocked", "reason": decision.reason, "scope_decision": decision.to_dict()},
                "evidence": [decision.reason],
            }

        try:
            with httpx.Client(timeout=settings.DEFAULT_HTTP_TIMEOUT, follow_redirects=True) as client:
                home = client.get(url)
                home.raise_for_status()
                content_type = home.headers.get("content-type", "")
                parts = [home.text[:MAX_JS_BYTES]]
                sources: List[Dict[str, Any]] = [{
                    "type": "html",
                    "location": str(home.url),
                    "status": home.status_code,
                    "content_type": content_type,
                    "size": len(home.content),
                }]
                base_origin = urlparse(str(home.url)).netloc
                script_urls: List[str] = []
                for src in SCRIPT_PATTERN.findall(home.text):
                    js_url = urljoin(str(home.url), src)
                    parsed = urlparse(js_url)
                    if parsed.netloc != base_origin:
                        continue
                    if js_url not in script_urls:
                        script_urls.append(js_url)
                    if len(script_urls) >= MAX_JS_FILES:
                        break

                for js_url in script_urls:
                    js_decision = scope_guard.validate_and_record(js_url)
                    if not js_decision.allowed:
                        sources.append({"type": "js", "location": js_url, "skipped": js_decision.reason})
                        continue
                    normalized_js = js_decision.normalized_url
                    resp = client.get(normalized_js)
                    if len(resp.content) > MAX_JS_BYTES:
                        sources.append({"type": "js", "location": normalized_js, "status": resp.status_code, "skipped": "超过 1MB 上限"})
                        continue
                    if resp.status_code >= 400:
                        sources.append({"type": "js", "location": normalized_js, "status": resp.status_code, "skipped": "HTTP 错误"})
                        continue
                    parts.append(resp.text)
                    sources.append({
                        "type": "js",
                        "location": normalized_js,
                        "status": resp.status_code,
                        "content_type": resp.headers.get("content-type", ""),
                        "size": len(resp.content),
                    })
                return {"success": True, "content": "\n".join(parts), "sources": sources}
        except Exception as e:
            return {
                "success": False,
                "summary": f"URL 内容读取失败: {type(e).__name__}: {e}",
                "details": {"url": url, "error_type": type(e).__name__, "error": str(e)},
                "evidence": [],
            }

    def _extract_paths(self, content: str, target: str = "") -> List[str]:
        paths = set(API_PATTERN.findall(content))

        base_host = ""
        if target:
            _, normalized, _ = validate_http_target(target)
            base_host = urlparse(normalized).netloc

        for call_target in CALL_PATTERN.findall(content):
            parsed_call = urlparse(call_target)
            if parsed_call.scheme and base_host and parsed_call.netloc != base_host:
                continue
            candidate = parsed_call.path if parsed_call.scheme else call_target
            if parsed_call.query:
                candidate += "?" + parsed_call.query
            if candidate.startswith(("/api", "/v", "/graphql")):
                paths.add(candidate)

        for full_url in FULL_URL_PATTERN.findall(content):
            parsed = urlparse(full_url)
            if base_host and parsed.netloc != base_host:
                continue
            candidate = parsed.path or "/"
            if parsed.query:
                candidate += "?" + parsed.query
            if API_PATTERN.search(f"'{candidate}'") or candidate.startswith(("/api", "/v", "/graphql")):
                paths.add(candidate)

        return sorted({p for p in paths if isinstance(p, str) and p})

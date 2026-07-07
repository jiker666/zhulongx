"""
WebFetchTool — 让 Agent 能获取网页内容（CTF writeup、技术文档）。

支持获取网页 HTML/JSON/text，提取关键内容。
仅在 authorized + allow_network 时可用。
"""
from __future__ import annotations

import re
from typing import Any, Dict

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec


class WebFetchTool(BaseTool):
    name = "web_fetch"
    description = "获取网页内容。用于阅读 CTF writeup、技术文档。返回清理后的文本内容。"
    category = "recon"
    input_schema = {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "要获取的 URL"},
            "max_chars": {"type": "integer", "description": "最大返回字符数", "default": 8000},
        },
        "required": ["url"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "content": {"type": "string"},
            "status_code": {"type": "integer"},
        },
    }
    permissions = ["network_access"]
    risk_level = "medium"
    timeout_seconds = 20

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        import httpx

        url = context.get("url", "")
        if not url:
            return {"success": False, "summary": "empty url", "details": {"error": "empty_url"}, "evidence": []}

        if not context.get("allow_network", False):
            return {"success": False, "summary": "network not authorized", "details": {"error": "no_network"}, "evidence": []}

        max_chars = int(context.get("max_chars", 8000))
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }

        try:
            with httpx.Client(timeout=15, follow_redirects=True, verify=False) as client:
                resp = client.get(url, headers=headers)
                resp.raise_for_status()
                content_type = resp.headers.get("content-type", "")
                if "json" in content_type:
                    text = resp.text[:max_chars]
                else:
                    text = self._html_to_text(resp.text)[:max_chars]
                return {
                    "success": True,
                    "summary": f"HTTP {resp.status_code}, {len(text)} chars",
                    "details": {"url": url, "status_code": resp.status_code, "content": text},
                    "evidence": [],
                }
        except Exception as e:
            return {"success": False, "summary": f"获取失败: {type(e).__name__}: {e}", "details": {"error": str(e)}, "evidence": []}

    @staticmethod
    def _html_to_text(html: str) -> str:
        html = re.sub(r'<script[^>]*>[\s\S]*?</script>', '', html, flags=re.IGNORECASE)
        html = re.sub(r'<style[^>]*>[\s\S]*?</style>', '', html, flags=re.IGNORECASE)
        html = re.sub(r'<nav[^>]*>[\s\S]*?</nav>', '', html, flags=re.IGNORECASE)
        html = re.sub(r'<header[^>]*>[\s\S]*?</header>', '', html, flags=re.IGNORECASE)
        html = re.sub(r'<footer[^>]*>[\s\S]*?</footer>', '', html, flags=re.IGNORECASE)
        text = re.sub(r'<br\s*/?>', '\n', html)
        text = re.sub(r'<p[^>]*>', '\n', text)
        text = re.sub(r'</p>', '\n', text)
        text = re.sub(r'<li[^>]*>', '\n- ', text)
        text = re.sub(r'<h[1-6][^>]*>', '\n## ', text)
        text = re.sub(r'</h[1-6]>', '\n', text)
        text = re.sub(r'<pre[^>]*>', '\n```\n', text)
        text = re.sub(r'</pre>', '\n```\n', text)
        text = re.sub(r'<code[^>]*>', '`', text)
        text = re.sub(r'</code>', '`', text)
        text = re.sub(r'<[^>]+>', '', text)
        text = re.sub(r'&nbsp;', ' ', text)
        text = re.sub(r'&lt;', '<', text)
        text = re.sub(r'&gt;', '>', text)
        text = re.sub(r'&amp;', '&', text)
        text = re.sub(r'&#\d+;', '', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = re.sub(r'[ \t]+', ' ', text)
        return text.strip()

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )

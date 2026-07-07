"""
WebSearchTool — 让 Agent 能联网搜索 CTF writeup 和技术资料。

使用 Google 搜索（通过 httpx 请求），返回搜索结果摘要。
仅在 authorized + allow_network 时可用。
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec


class WebSearchTool(BaseTool):
    name = "web_search"
    description = "搜索互联网获取 CTF writeup、技术文档和解题思路。搜索关键词应包含题名+CTF+writeup。"
    category = "recon"
    input_schema = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "搜索关键词，例如 'SSRFme HITCON 2017 CTF writeup'"
            },
            "max_results": {
                "type": "integer",
                "description": "最大结果数",
                "default": 5
            },
        },
        "required": ["query"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "url": {"type": "string"},
                        "snippet": {"type": "string"},
                    }
                }
            },
        },
    }
    permissions = ["network_access"]
    risk_level = "medium"
    timeout_seconds = 30

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        import httpx

        query = context.get("query", "")
        if not query:
            return {"success": False, "summary": "empty query", "details": {"error": "empty_query"}, "evidence": []}

        if not context.get("allow_network", False):
            return {"success": False, "summary": "network not authorized", "details": {"error": "no_network"}, "evidence": []}

        max_results = int(context.get("max_results", 5))
        results = []

        try:
            results = self._duckduckgo_search(query, max_results)
        except Exception as e:
            try:
                results = self._google_search(query, max_results)
            except Exception as e2:
                return {"success": False, "summary": f"搜索失败: {e}; fallback: {e2}", "details": {"error": str(e)}, "evidence": []}

        if not results:
            return {"success": False, "summary": "无搜索结果", "details": {"query": query}, "evidence": []}

        return {
            "success": True,
            "summary": f"找到 {len(results)} 条结果",
            "details": {"query": query, "results": results},
            "evidence": [],
        }

    def _google_search(self, query: str, max_results: int) -> List[Dict[str, str]]:
        import httpx
        url = "https://www.google.com/search"
        params = {"q": query, "num": max_results, "hl": "zh-CN"}
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
        with httpx.Client(timeout=15, follow_redirects=True, verify=False) as client:
            resp = client.get(url, params=params, headers=headers)
            resp.raise_for_status()
            html = resp.text
        return self._parse_google_html(html, max_results)

    def _parse_google_html(self, html: str, max_results: int) -> List[Dict[str, str]]:
        results = []
        for m in re.finditer(r'<a href="/url\?q=(https?://[^&"]+)&[^"]*"[^>]*>(.*?)</a>', html):
            url = m.group(1)
            title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
            if not title or 'google.com' in url:
                continue
            snippet = ""
            after = html[m.end():m.end() + 500]
            sm = re.search(r'<span[^>]*>(.*?)</span>', after)
            if sm:
                snippet = re.sub(r'<[^>]+>', '', sm.group(1)).strip()
            results.append({"title": title, "url": url, "snippet": snippet[:300]})
            if len(results) >= max_results:
                break
        if not results:
            for m in re.finditer(r'<a href="(https?://(?!google\.)[^"]+)"[^>]*>(.*?)</a>', html):
                url = m.group(1)
                title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
                if title and 'google.com' not in url and 'webcache' not in url:
                    results.append({"title": title, "url": url, "snippet": ""})
                    if len(results) >= max_results:
                        break
        return results

    def _duckduckgo_search(self, query: str, max_results: int) -> List[Dict[str, str]]:
        import httpx
        url = "https://html.duckduckgo.com/html/"
        data = {"q": query, "b": ""}
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        }
        with httpx.Client(timeout=15, follow_redirects=True, verify=False) as client:
            resp = client.post(url, data=data, headers=headers)
            resp.raise_for_status()
            html = resp.text
        results = []
        for m in re.finditer(r'class="result__a"[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', html):
            url = m.group(1)
            title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
            snippet = ""
            after = html[m.end():m.end() + 500]
            sm = re.search(r'class="result__snippet"[^>]*>(.*?)</[at]', after)
            if sm:
                snippet = re.sub(r'<[^>]+>', '', sm.group(1)).strip()
            results.append({"title": title, "url": url, "snippet": snippet[:300]})
            if len(results) >= max_results:
                break
        return results

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )

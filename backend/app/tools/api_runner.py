"""
Small, controlled API runner for OpenAPI/Postman/JS-discovered paths.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urljoin

from app.tools.base import BaseTool
from app.tools.http_replay import HttpReplayTool


class APIRunnerTool(BaseTool):
    name = "APIRunnerTool"
    description = "从 OpenAPI/Swagger/Postman/JS 路径生成少量安全 GET 请求；非 GET 只给建议"
    category = "web"
    input_schema = {"type": "object", "properties": {"base_url": {"type": "string"}, "api_paths": {"type": "array"}, "file_path": {"type": "string"}}}
    output_schema = {"type": "object", "properties": {"api_map": {"type": "array"}, "responses": {"type": "array"}}}
    permissions = ["network_read", "local_file_read"]
    risk_level = "medium"
    timeout_seconds = 20
    tags = ["web", "api", "scope_guard", "triage", "final_ops"]

    def __init__(self) -> None:
        self.replay = HttpReplayTool()

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        base_url = context.get("base_url") or context.get("target") or ""
        api_map = self._collect_api_map(context)
        if not api_map:
            return {"success": False, "summary": "未发现可运行 API 路径", "details": {"api_map": []}, "evidence": []}

        responses: List[Dict[str, Any]] = []
        suggestions: List[Dict[str, Any]] = []
        candidates: List[Dict[str, Any]] = []
        for item in api_map[:10]:
            method = item.get("method", "GET").upper()
            path = item.get("path", "/")
            full_url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/")) if base_url else path
            if method != "GET":
                suggestions.append({"method": method, "url": full_url, "requires_confirmation": True, "reason": "非 GET 接口不自动执行"})
                continue
            result = self.replay.run({
                "method": "GET",
                "url": full_url,
                "reason": "APIRunnerTool 自动执行 GET 类接口",
                "challenge_id": context.get("challenge_id"),
                "task_id": context.get("task_id"),
            })
            responses.append({"method": method, "url": full_url, "success": result.get("success"), "summary": result.get("summary"), "details": result.get("details", {})})
            candidates.extend(result.get("details", {}).get("answer_candidates", []))

        details = {
            "api_map": api_map,
            "responses": responses,
            "suggestions": suggestions,
            "answer_candidates": candidates[:20],
            "abnormal_endpoints": [r for r in responses if not r.get("success") or r.get("details", {}).get("status_code", 200) >= 400],
        }
        return {
            "success": True,
            "summary": f"识别 {len(api_map)} 个接口，执行 {len(responses)} 个 GET，请求建议 {len(suggestions)} 个，候选 {len(candidates)} 个",
            "details": details,
            "evidence": [r["summary"] for r in responses[:5]] + [c["candidate"] for c in candidates[:5]],
        }

    def _collect_api_map(self, context: Dict[str, Any]) -> List[Dict[str, str]]:
        raw_paths = context.get("api_paths") or []
        api_map: List[Dict[str, str]] = []
        for path in raw_paths:
            if isinstance(path, str):
                api_map.append({"method": "GET", "path": path})
            elif isinstance(path, dict):
                api_map.append({"method": str(path.get("method", "GET")).upper(), "path": str(path.get("path", "/"))})

        file_path = context.get("file_path") or context.get("uploaded_file") or ""
        if file_path and Path(file_path).exists():
            text = Path(file_path).read_text(encoding="utf-8", errors="ignore")[:500000]
            api_map.extend(self._from_text(text))

        content = context.get("content") or ""
        if content:
            api_map.extend(self._from_text(content[:500000]))

        seen = set()
        unique: List[Dict[str, str]] = []
        for item in api_map:
            key = (item["method"], item["path"])
            if key not in seen and item["path"].startswith("/"):
                seen.add(key)
                unique.append(item)
        return unique

    def _from_text(self, text: str) -> List[Dict[str, str]]:
        api_map: List[Dict[str, str]] = []
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                if "paths" in data and isinstance(data["paths"], dict):
                    for path, methods in data["paths"].items():
                        if isinstance(methods, dict):
                            for method in methods:
                                api_map.append({"method": method.upper(), "path": path})
                elif "item" in data:
                    api_map.extend(self._from_postman_items(data.get("item", [])))
        except Exception:
            pass
        for match in re.finditer(r"(?i)\b(get|post|put|patch|delete|head|options)\s*[: ]\s*['\"](/[^'\"]+)['\"]", text):
            api_map.append({"method": match.group(1).upper(), "path": match.group(2)})
        for path in re.findall(r"['\"]((?:/api|/v\d+|/graphql|/admin|/auth|/user)[/\w\-\.{}:?=&%]*)['\"]", text, re.I):
            api_map.append({"method": "GET", "path": path})
        return api_map

    def _from_postman_items(self, items: List[Any]) -> List[Dict[str, str]]:
        api_map: List[Dict[str, str]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            if "item" in item:
                api_map.extend(self._from_postman_items(item["item"]))
                continue
            req = item.get("request", {})
            method = str(req.get("method", "GET")).upper()
            url = req.get("url", {})
            path = ""
            if isinstance(url, dict):
                parts = url.get("path") or []
                path = "/" + "/".join(str(p) for p in parts)
            elif isinstance(url, str):
                path = "/" + url.split("/", 3)[-1] if "://" in url else url
            if path:
                api_map.append({"method": method, "path": path})
        return api_map

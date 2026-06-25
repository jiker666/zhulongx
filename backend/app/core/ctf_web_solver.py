"""
Low-risk Web CTF solve lane.

Only GET requests are sent automatically. Forms and non-GET actions become
manual actions. Every request is checked by ScopeGuard first.
"""
from __future__ import annotations

import hashlib
import json
import re
from html.parser import HTMLParser
from typing import Any, Dict, List
from urllib.parse import urljoin, urlparse

import httpx

from app.config import settings
from app.core.answer_extractor import AnswerCandidateExtractor
from app.core.scope_guard import scope_guard


class _FormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.forms: List[Dict[str, Any]] = []
        self.scripts: List[str] = []
        self._current: Dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: List[tuple[str, str | None]]) -> None:
        data = {k.lower(): v or "" for k, v in attrs}
        if tag.lower() == "form":
            self._current = {"method": (data.get("method") or "GET").upper(), "action": data.get("action") or "", "inputs": []}
            self.forms.append(self._current)
        elif tag.lower() == "input" and self._current is not None:
            self._current["inputs"].append({
                "name": data.get("name", ""),
                "type": data.get("type", "text"),
                "hidden": data.get("type", "").lower() == "hidden",
                "csrf_like": bool(re.search(r"csrf|xsrf|token", data.get("name", ""), re.I)),
            })
        elif tag.lower() == "script" and data.get("src"):
            self.scripts.append(data["src"])

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "form":
            self._current = None


class CTFWebSolver:
    def __init__(self, max_requests: int = 6, timeout: int | None = None) -> None:
        self.max_requests = max_requests
        self.timeout = timeout or settings.DEFAULT_HTTP_TIMEOUT
        self.extractor = AnswerCandidateExtractor()

    def solve(self, target_url: str, cookies: str = "", challenge_id: int | None = None, task_id: int | None = None) -> Dict[str, Any]:
        requests: List[Dict[str, Any]] = []
        evidence: List[Dict[str, Any]] = []
        candidates: List[Dict[str, Any]] = []
        manual_actions: List[Dict[str, Any]] = []
        api_paths: List[str] = []
        forms: List[Dict[str, Any]] = []
        cookie_summary = self._cookie_summary(cookies)

        with httpx.Client(timeout=self.timeout, follow_redirects=True, headers=self._headers(cookies)) as client:
            first = self._get(client, target_url, requests, evidence)
            if not first.get("success"):
                return {
                    "success": False,
                    "summary": first["summary"],
                    "requests": requests,
                    "evidence": evidence,
                    "answer_candidates": [],
                    "forms": [],
                    "api_paths": [],
                    "manual_actions": [],
                    "cookie_summary": cookie_summary,
                }
            body = first.get("body", "")
            candidates.extend(self.extractor.extract(body, f"web:{target_url}"))
            parser = _FormParser()
            parser.feed(body)
            forms = parser.forms
            for form in forms:
                if form.get("method") != "GET":
                    manual_actions.append({
                        "type": "manual_confirmed_post",
                        "requires_confirmation": True,
                        "method": form.get("method"),
                        "action": urljoin(target_url, form.get("action") or ""),
                        "input_names": [i.get("name") for i in form.get("inputs", [])],
                        "reason": "POST/unsafe form is not submitted automatically",
                    })

            api_paths.extend(self._extract_paths(body))
            script_urls = [urljoin(target_url, src) for src in parser.scripts[:3]]
            for script_url in script_urls:
                if len(requests) >= self.max_requests:
                    break
                result = self._get(client, script_url, requests, evidence)
                if not result.get("success"):
                    continue
                text = result.get("body", "")
                candidates.extend(self.extractor.extract(text, f"web-js:{script_url}"))
                api_paths.extend(self._extract_paths(text))

            for path in self._dedup(api_paths):
                if len(requests) >= self.max_requests:
                    break
                if not path.startswith("/"):
                    continue
                result = self._get(client, urljoin(target_url, path), requests, evidence)
                if not result.get("success"):
                    continue
                candidates.extend(self.extractor.extract(result.get("body", ""), f"web-api:{path}"))

        ranked = self._rank_candidates(candidates)
        return {
            "success": True,
            "summary": f"web solve lane sent {len(requests)} GET request(s), found {len(ranked)} candidate(s)",
            "requests": requests,
            "evidence": evidence,
            "answer_candidates": ranked[:20],
            "forms": forms,
            "api_paths": self._dedup(api_paths)[:40],
            "manual_actions": manual_actions,
            "cookie_summary": cookie_summary,
            "challenge_id": challenge_id,
            "task_id": task_id,
        }

    def _get(self, client: httpx.Client, url: str, requests: List[Dict[str, Any]], evidence: List[Dict[str, Any]]) -> Dict[str, Any]:
        decision = scope_guard.validate_and_record(url)
        if not decision.allowed:
            item = {"method": "GET", "url": url, "allowed": False, "reason": decision.reason, "scope": decision.to_dict()}
            requests.append(item)
            return {"success": False, "summary": f"ScopeGuard blocked {url}: {decision.reason}"}
        try:
            resp = client.get(decision.normalized_url)
        except Exception as exc:
            requests.append({"method": "GET", "url": decision.normalized_url, "allowed": True, "error": type(exc).__name__})
            return {"success": False, "summary": f"GET failed: {type(exc).__name__}: {exc}"}
        body = resp.text[:500_000]
        body_excerpt = body[:1600]
        requests.append({"method": "GET", "url": str(resp.url), "allowed": True, "status_code": resp.status_code, "scope": decision.to_dict()})
        evidence.append({
            "source_tool": "CTFWebSolver",
            "input_summary": f"GET {resp.url}",
            "output_excerpt": f"HTTP {resp.status_code}\n{body_excerpt}",
            "reproduction_hint": f"curl -s {resp.url}",
        })
        return {"success": True, "summary": f"GET {resp.url} -> {resp.status_code}", "body": body, "status_code": resp.status_code}

    def _extract_paths(self, text: str) -> List[str]:
        paths = []
        for pattern in [
            r"['\"]((?:/api|/v\d+|/graphql|/admin|/auth|/flag|/user)[/\w\-\.{}:?=&%]*)['\"]",
            r"\bfetch\(\s*['\"]([^'\"]+)['\"]",
            r"\baxios\.(?:get|post)\(\s*['\"]([^'\"]+)['\"]",
        ]:
            paths.extend(re.findall(pattern, text or "", re.I))
        return [p for p in paths if p.startswith("/")]

    def _headers(self, cookies: str) -> Dict[str, str]:
        headers = {"User-Agent": "CyberPilot-FinalOps-v4/ctf-web-solver"}
        if cookies:
            headers["Cookie"] = cookies[:4000]
        return headers

    def _cookie_summary(self, cookies: str) -> Dict[str, Any]:
        if not cookies:
            return {"configured": False, "hash": "", "names": []}
        names = []
        for chunk in cookies.split(";"):
            name = chunk.split("=", 1)[0].strip()
            if name:
                names.append(name[:60])
        return {
            "configured": True,
            "hash": hashlib.sha256(cookies.encode("utf-8", errors="ignore")).hexdigest(),
            "names": names[:20],
        }

    def _rank_candidates(self, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        by_value: Dict[str, Dict[str, Any]] = {}
        for item in candidates:
            value = str(item.get("candidate") or "")
            if not value:
                continue
            item = dict(item)
            if "flag{" in value.lower():
                item["confidence"] = max(float(item.get("confidence", 0.5)), 0.9)
            if value not in by_value or float(by_value[value].get("confidence", 0)) < float(item.get("confidence", 0)):
                by_value[value] = item
        return sorted(by_value.values(), key=lambda c: float(c.get("confidence", 0)), reverse=True)

    def _dedup(self, values: List[str]) -> List[str]:
        out: List[str] = []
        seen: set[str] = set()
        for value in values:
            if value not in seen:
                seen.add(value)
                out.append(value)
        return out


def web_result_json(result: Dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False, indent=2)

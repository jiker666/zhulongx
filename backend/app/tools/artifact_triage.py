"""
ArtifactTriageTool - safe read-only triage for competition attachments.
"""
from __future__ import annotations

import gzip
import hashlib
import math
import os
import re
import shutil
import tarfile
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from app.core.answer_extractor import AnswerCandidateExtractor
from app.core.solve_access_guard import SolveAccessDenied, get_active_solve_guard
from app.tools.base import BaseTool


MAX_FILES = 300
MAX_TOTAL_BYTES = 25 * 1024 * 1024
MAX_SINGLE_BYTES = 2 * 1024 * 1024
TEXT_EXTS = {".txt", ".log", ".json", ".xml", ".yaml", ".yml", ".md", ".csv", ".ini", ".conf", ".properties", ".env", ".http"}
CODE_EXTS = {".java", ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".php", ".rb", ".c", ".cpp", ".h"}
WEB_EXTS = {".html", ".htm", ".js", ".map", ".css"}
REVERSE_EXTS = {".elf", ".exe", ".dll", ".so", ".jar", ".class", ".apk"}


class ArtifactTriageTool(BaseTool):
    name = "ArtifactTriageTool"
    description = "对比赛题目附件做安全只读分诊，提取文件类型、线索、答案候选和推荐工具"
    category = "file"
    input_schema = {
        "type": "object",
        "properties": {
            "uploaded_file": {"type": "string"},
            "file_path": {"type": "string"},
            "challenge_type": {"type": "string"},
            "description": {"type": "string"},
        },
    }
    output_schema = {
        "type": "object",
        "properties": {
            "artifact_type": {"type": "string"},
            "detected_formats": {"type": "array"},
            "files_summary": {"type": "object"},
            "interesting_files": {"type": "array"},
            "extracted_indicators": {"type": "object"},
            "answer_candidates": {"type": "array"},
            "recommended_tools": {"type": "array"},
            "confidence": {"type": "number"},
            "skipped_reasons": {"type": "array"},
        },
    }
    permissions = ["local_file_read"]
    risk_level = "low"
    timeout_seconds = 20
    tags = ["triage", "file", "pcap", "reverse", "misc", "final_ops"]

    def __init__(self) -> None:
        self.extractor = AnswerCandidateExtractor()

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        file_path = context.get("uploaded_file") or context.get("file_path") or ""
        description = context.get("description") or context.get("task_description") or ""
        challenge_type = context.get("challenge_type") or context.get("task_type") or "unknown"
        if not file_path:
            candidates = self.extractor.extract(description, "challenge_description")
            return self._result(
                artifact_type="description_only",
                detected_formats=["text"],
                files=[],
                interesting_files=[],
                indicators=self._indicators(description),
                candidates=candidates,
                recommended=self._recommend(challenge_type, ["text"], []),
                skipped=[],
                confidence=0.45 if candidates else 0.25,
            )

        path = Path(file_path)
        guard = get_active_solve_guard()
        try:
            if guard:
                guard.validate_path(path, tool_name=self.name)
        except SolveAccessDenied as exc:
            return {"success": False, "summary": f"SolveAccessGuard blocked attachment: {exc}", "details": {"skipped_reasons": [str(exc)]}, "evidence": []}

        if not path.exists() or not path.is_file():
            return {"success": False, "summary": f"附件不存在: {file_path}", "details": {}, "evidence": []}

        skipped: List[str] = []
        entries: List[Dict[str, Any]] = []
        raw_text_parts: List[str] = [description]
        detected = set()
        artifact_type = "single_file"

        try:
            if zipfile.is_zipfile(path):
                artifact_type = "zip"
                detected.add("zip")
                entries, skipped, texts = self._read_zip(path)
                raw_text_parts.extend(texts)
            elif tarfile.is_tarfile(path):
                artifact_type = "tar"
                detected.add("tar")
                entries, skipped, texts = self._read_tar(path)
                raw_text_parts.extend(texts)
            elif path.suffix.lower() == ".gz":
                artifact_type = "gz"
                detected.add("gz")
                entries, skipped, texts = self._read_gz(path)
                raw_text_parts.extend(texts)
            else:
                data = guard.read_bytes(path, tool_name=self.name, max_bytes=MAX_SINGLE_BYTES) if guard else path.read_bytes()[:MAX_SINGLE_BYTES]
                entry, text = self._describe_bytes(path.name, data)
                entries.append(entry)
                raw_text_parts.append(text)
        except Exception as exc:
            return {"success": False, "summary": f"附件分诊失败: {type(exc).__name__}: {exc}", "details": {"skipped_reasons": skipped}, "evidence": skipped}

        for entry in entries:
            detected.update(entry.get("formats", []))
        all_text = "\n".join(part for part in raw_text_parts if part)
        indicators = self._indicators(all_text)
        interesting = self._interesting(entries)
        candidates = self.extractor.extract(all_text, f"artifact:{path.name}")
        recommended = self._recommend(challenge_type, list(detected), entries)
        confidence = min(0.95, 0.35 + len(detected) * 0.05 + len(candidates) * 0.08 + len(interesting) * 0.02)

        return self._result(artifact_type, sorted(detected) or ["unknown"], entries, interesting, indicators, candidates, recommended, skipped, confidence)

    def _result(self, artifact_type: str, detected_formats: List[str], files: List[Dict[str, Any]], interesting_files: List[Dict[str, Any]], indicators: Dict[str, Any], candidates: List[Dict[str, Any]], recommended: List[str], skipped: List[str], confidence: float) -> Dict[str, Any]:
        details = {
            "artifact_type": artifact_type,
            "detected_formats": detected_formats,
            "files_summary": {
                "total_files": len(files),
                "total_size": sum(int(f.get("size", 0)) for f in files),
                "extensions": Counter(Path(f.get("path", "")).suffix.lower() or "(none)" for f in files),
            },
            "interesting_files": interesting_files[:50],
            "extracted_indicators": indicators,
            "answer_candidates": candidates[:20],
            "recommended_tools": recommended,
            "confidence": round(confidence, 2),
            "skipped_reasons": skipped[:100],
        }
        details["files_summary"]["extensions"] = dict(details["files_summary"]["extensions"])
        summary = f"附件类型 {artifact_type}，识别 {len(detected_formats)} 类格式、{len(files)} 个文件、{len(candidates)} 个答案候选"
        evidence = [summary]
        evidence.extend([f"{c['candidate']} ({c['source']})" for c in candidates[:5]])
        evidence.extend([f"{f.get('path')} [{','.join(f.get('formats', []))}]" for f in interesting_files[:5]])
        return {"success": True, "summary": summary, "details": details, "evidence": evidence}

    def _safe_member(self, name: str) -> bool:
        pure = Path(name)
        return not (pure.is_absolute() or ".." in pure.parts)

    def _read_zip(self, path: Path) -> Tuple[List[Dict[str, Any]], List[str], List[str]]:
        entries: List[Dict[str, Any]] = []
        skipped: List[str] = []
        texts: List[str] = []
        total = 0
        guard = get_active_solve_guard()
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist()[:MAX_FILES]:
                if info.is_dir():
                    continue
                if not self._safe_member(info.filename):
                    skipped.append(f"unsafe zip path skipped: {info.filename}")
                    continue
                if guard:
                    try:
                        guard.validate_archive_member(path, info.filename, tool_name=self.name)
                    except SolveAccessDenied as exc:
                        skipped.append(f"SolveAccessGuard blocked zip member: {info.filename} ({exc})")
                        continue
                if info.file_size > MAX_SINGLE_BYTES:
                    skipped.append(f"too large file skipped: {info.filename}")
                    continue
                total += info.file_size
                if total > MAX_TOTAL_BYTES:
                    skipped.append("archive total size limit reached")
                    break
                data = zf.read(info)[:MAX_SINGLE_BYTES]
                entry, text = self._describe_bytes(info.filename, data)
                entries.append(entry)
                if text:
                    texts.append(text)
        return entries, skipped, texts

    def _read_tar(self, path: Path) -> Tuple[List[Dict[str, Any]], List[str], List[str]]:
        entries: List[Dict[str, Any]] = []
        skipped: List[str] = []
        texts: List[str] = []
        total = 0
        guard = get_active_solve_guard()
        with tarfile.open(path) as tf:
            for member in tf.getmembers()[:MAX_FILES]:
                if not member.isfile():
                    continue
                if not self._safe_member(member.name):
                    skipped.append(f"unsafe tar path skipped: {member.name}")
                    continue
                if guard:
                    try:
                        guard.validate_archive_member(path, member.name, tool_name=self.name)
                    except SolveAccessDenied as exc:
                        skipped.append(f"SolveAccessGuard blocked tar member: {member.name} ({exc})")
                        continue
                if member.size > MAX_SINGLE_BYTES:
                    skipped.append(f"too large file skipped: {member.name}")
                    continue
                total += member.size
                if total > MAX_TOTAL_BYTES:
                    skipped.append("archive total size limit reached")
                    break
                extracted = tf.extractfile(member)
                data = extracted.read(MAX_SINGLE_BYTES) if extracted else b""
                entry, text = self._describe_bytes(member.name, data)
                entries.append(entry)
                if text:
                    texts.append(text)
        return entries, skipped, texts

    def _read_gz(self, path: Path) -> Tuple[List[Dict[str, Any]], List[str], List[str]]:
        skipped: List[str] = []
        guard = get_active_solve_guard()
        if guard:
            compressed = guard.read_bytes(path, tool_name=self.name)
            data = gzip.decompress(compressed)[:MAX_SINGLE_BYTES + 1]
        else:
            with gzip.open(path, "rb") as gf:
                data = gf.read(MAX_SINGLE_BYTES + 1)
        if len(data) > MAX_SINGLE_BYTES:
            skipped.append("gz member too large; truncated")
            data = data[:MAX_SINGLE_BYTES]
        entry, text = self._describe_bytes(path.with_suffix("").name, data)
        return [entry], skipped, [text]

    def _describe_bytes(self, name: str, data: bytes) -> Tuple[Dict[str, Any], str]:
        suffix = Path(name).suffix.lower()
        formats = self._formats(name, data)
        sha256 = hashlib.sha256(data).hexdigest()
        text = ""
        if self._is_text_like(suffix, data):
            text = data.decode("utf-8", errors="ignore")[:20000]
        strings = []
        if not text:
            strings = self._strings(data)[:50]
            text = "\n".join(strings)
        entry = {
            "path": name,
            "size": len(data),
            "sha256": sha256,
            "formats": formats,
            "entropy": round(self._entropy(data), 3) if data else 0,
            "strings": strings[:20],
        }
        return entry, text

    def _formats(self, name: str, data: bytes) -> List[str]:
        suffix = Path(name).suffix.lower()
        formats = set()
        if suffix in TEXT_EXTS:
            formats.add("text")
        if suffix in CODE_EXTS:
            formats.add("code")
        if suffix in WEB_EXTS:
            formats.add("web")
        if suffix in REVERSE_EXTS:
            formats.add("reverse")
        if suffix in {".pcap", ".pcapng"}:
            formats.add("pcap")
        head = data[:16]
        if head.startswith(b"\x7fELF"):
            formats.update(["reverse", "elf"])
        if head.startswith(b"MZ"):
            formats.update(["reverse", "pe"])
        if head.startswith(b"\xca\xfe\xba\xbe"):
            formats.update(["reverse", "class"])
        if head.startswith(b"\xd4\xc3\xb2\xa1") or head.startswith(b"\xa1\xb2\xc3\xd4") or head.startswith(b"\x0a\x0d\x0d\x0a"):
            formats.add("pcap")
        if b"swagger" in data[:4096].lower() or b"openapi" in data[:4096].lower():
            formats.add("openapi")
        if b"HTTP/" in data[:4096] or b"GET /" in data[:4096] or b"POST /" in data[:4096]:
            formats.add("http-message")
        return sorted(formats) or ["binary" if not self._is_text_like(suffix, data) else "text"]

    def _is_text_like(self, suffix: str, data: bytes) -> bool:
        if suffix in TEXT_EXTS or suffix in CODE_EXTS or suffix in WEB_EXTS:
            return True
        if not data:
            return True
        sample = data[:4096]
        if b"\x00" in sample:
            return False
        printable = sum(1 for b in sample if b in (9, 10, 13) or 32 <= b < 127)
        return printable / max(len(sample), 1) > 0.85

    def _strings(self, data: bytes) -> List[str]:
        return [m.group(0).decode("utf-8", errors="ignore") for m in re.finditer(rb"[\x20-\x7e]{4,}", data[:MAX_SINGLE_BYTES])]

    def _entropy(self, data: bytes) -> float:
        if not data:
            return 0.0
        counts = Counter(data)
        length = len(data)
        return -sum((count / length) * math.log2(count / length) for count in counts.values())

    def _indicators(self, text: str) -> Dict[str, Any]:
        return {
            "urls": sorted(set(re.findall(r"https?://[^\s'\"<>]+", text)))[:30],
            "ips": sorted(set(re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", text)))[:30],
            "api_paths": sorted(set(re.findall(r"['\"]((?:/api|/v\d+|/graphql|/admin|/auth|/user)[/\w\-\.{}:?=&%]*)['\"]", text, re.I)))[:50],
            "jwt_like": sorted(set(re.findall(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b", text)))[:10],
            "tshark_available": bool(shutil.which("tshark")),
            "tshark_hint": "" if shutil.which("tshark") else "tshark 未安装，pcap 仅做文件头与字符串轻量识别",
        }

    def _interesting(self, entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        keywords = ("flag", "answer", "secret", "token", "auth", "login", "admin", "swagger", "openapi", "pcap", "controller")
        selected = []
        for entry in entries:
            lower = entry.get("path", "").lower()
            formats = entry.get("formats", [])
            if any(k in lower for k in keywords) or any(f in formats for f in ["openapi", "pcap", "reverse", "web", "code", "http-message"]):
                selected.append(entry)
        return selected

    def _recommend(self, challenge_type: str, formats: Iterable[str], entries: List[Dict[str, Any]]) -> List[str]:
        ctype = (challenge_type or "").lower()
        fmt = set(formats)
        tools = ["ArtifactTriageTool"]
        if ctype == "web" or fmt.intersection({"web", "openapi", "http-message"}):
            tools.extend(["JSInterfaceExtractorTool", "HttpFingerprintTool", "APIRunnerTool"])
        if ctype == "code" or any(Path(e.get("path", "")).suffix.lower() == ".java" for e in entries):
            tools.extend(["FileParserTool", "JavaCodeAuditTool"])
        if ctype == "log" or any(Path(e.get("path", "")).suffix.lower() == ".log" for e in entries):
            tools.extend(["LogAnalyzerTool"])
        if ctype in {"pcap", "reverse", "crypto", "misc"} or fmt.intersection({"pcap", "reverse", "elf", "pe", "class"}):
            tools.append("FileParserTool")
        seen = []
        for tool in tools:
            if tool not in seen:
                seen.append(tool)
        return seen

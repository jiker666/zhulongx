"""
Answer candidate extraction for CTF/competition outputs.
"""
from __future__ import annotations

import base64
import binascii
import gzip
import re
import urllib.parse
import zlib
from typing import Dict, Iterable, List, Optional


DEFAULT_PATTERNS = [
    r"\bflag\{[^{}\r\n]{1,160}\}",
    r"\bFLAG\{[^{}\r\n]{1,160}\}",
    r"\bctf\{[^{}\r\n]{1,160}\}",
    r"\bCTF\{[^{}\r\n]{1,160}\}",
    r"\b(?:answer|flag|key|result)\s*[:=]\s*([A-Za-z0-9_{}\-./+=:@]{3,180})",
]

SECRET_KEYWORDS = {"api_key", "apikey", "secret", "password", "passwd", "token", "authorization", "bearer"}


class AnswerCandidateExtractor:
    def __init__(self, patterns: Optional[List[str]] = None) -> None:
        self.patterns = patterns or DEFAULT_PATTERNS

    def extract(self, text: str, source: str = "", custom_patterns: Optional[Iterable[str]] = None) -> List[Dict]:
        if not text:
            return []
        candidates: Dict[str, Dict] = {}
        patterns = list(self.patterns)
        if custom_patterns:
            patterns.extend(custom_patterns)
        search_texts = [(text, "raw")]
        for decoded, label in self._decode_variants(text[:20000]):
            search_texts.append((decoded, label))

        for body, label in search_texts:
            for pattern in patterns:
                try:
                    regex = re.compile(pattern, re.IGNORECASE)
                except re.error:
                    continue
                for match in regex.finditer(body):
                    value = match.group(1) if match.groups() else match.group(0)
                    value = value.strip().strip("'\"`")
                    if not value or self._looks_like_secret_assignment(body, match.start(), value):
                        continue
                    confidence = 0.9 if "flag{" in value.lower() or "ctf{" in value.lower() else 0.62
                    if label != "raw":
                        confidence = min(confidence + 0.06, 0.95)
                    candidates[value] = {
                        "candidate": value,
                        "source": source or label,
                        "source_type": self._source_type(source or label),
                        "evidence": self._excerpt(body, match.start(), match.end()),
                        "evidence_ids": [],
                        "confidence": confidence,
                        "why_selected": f"匹配通用答案模式 ({label})",
                        "validation_status": "unverified",
                        "reasoning_basis": "current challenge text or tool output pattern match",
                        "disallowed_sources_checked": True,
                        "memory_guess_detected": False,
                        "confidence_cap_reason": "",
                    }
        return sorted(candidates.values(), key=lambda item: item["confidence"], reverse=True)

    def _source_type(self, source: str) -> str:
        value = (source or "").lower()
        if "llm_memory" in value:
            return "llm_memory"
        if "web" in value or "http" in value:
            return "http_response"
        if "misc" in value or "decoded" in value or "decode" in value:
            return "decoded_chain"
        if "static" in value or "strings" in value:
            return "static_strings"
        if "manual" in value:
            return "manual_result"
        if "artifact" in value or "attachment" in value:
            return "attachment"
        return "tool_output"

    def _looks_like_secret_assignment(self, text: str, start: int, value: str) -> bool:
        window = text[max(0, start - 80): start + 80].lower()
        if any(keyword in window for keyword in SECRET_KEYWORDS):
            if not re.search(r"\b(flag|answer|ctf|result)\b", window):
                return True
        if value.startswith(("sk-", "AKIA")):
            return True
        return False

    def _excerpt(self, text: str, start: int, end: int) -> str:
        return text[max(0, start - 80): min(len(text), end + 80)].replace("\x00", "").strip()[:400]

    def _decode_variants(self, text: str) -> List[tuple[str, str]]:
        variants: List[tuple[str, str]] = []
        tokens = re.findall(r"[A-Za-z0-9+/=_%-]{12,}", text)
        expanded: List[str] = []
        for token in tokens[:80]:
            expanded.append(token)
            for sep in ("=", ":", "%3D"):
                if sep in token:
                    tail = token.split(sep, 1)[-1]
                    if len(tail) >= 8:
                        expanded.append(tail)
        for token in expanded[:120]:
            raw = token.strip()
            url_decoded = urllib.parse.unquote(raw)
            if url_decoded != raw and self._mostly_printable(url_decoded):
                variants.append((url_decoded, "urlencode"))

            b64 = raw + "=" * ((4 - len(raw) % 4) % 4)
            try:
                decoded = base64.b64decode(b64, validate=False)
                if decoded:
                    try:
                        as_text = decoded.decode("utf-8", errors="ignore")
                    except Exception:
                        as_text = ""
                    if self._mostly_printable(as_text):
                        variants.append((as_text, "base64"))
                    for opener, label in ((gzip.decompress, "gzip+base64"), (zlib.decompress, "zlib+base64")):
                        try:
                            inflated = opener(decoded).decode("utf-8", errors="ignore")
                            if self._mostly_printable(inflated):
                                variants.append((inflated, label))
                        except Exception:
                            pass
            except (binascii.Error, ValueError):
                pass

            if re.fullmatch(r"[0-9a-fA-F]{16,}", raw) and len(raw) % 2 == 0:
                try:
                    hex_text = bytes.fromhex(raw).decode("utf-8", errors="ignore")
                    if self._mostly_printable(hex_text):
                        variants.append((hex_text, "hex"))
                except Exception:
                    pass
        return variants

    def _mostly_printable(self, value: str) -> bool:
        if not value or len(value) < 3:
            return False
        printable = sum(1 for ch in value if ch == "\n" or ch == "\r" or ch == "\t" or 32 <= ord(ch) < 127)
        return printable / max(len(value), 1) > 0.8

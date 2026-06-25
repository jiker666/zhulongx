"""
Low-risk recursive decoder for misc/crypto CTF attachments.

The solver is intentionally offline-only. It records each decode attempt and
only promotes flag-like values or explicit answer-like strings after filtering
obvious API keys and secrets.
"""
from __future__ import annotations

import base64
import binascii
import codecs
import gzip
import hashlib
import json
import re
import string
import urllib.parse
import zlib
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Tuple

from app.core.answer_extractor import AnswerCandidateExtractor


MAX_NODE_BYTES = 512 * 1024
MAX_TEXT_CHARS = 120_000
MAX_CHILDREN_PER_NODE = 80
PRINTABLE = set(bytes(string.printable, "ascii"))
SECRET_RE = re.compile(r"(?i)\b(api[_-]?key|secret|password|passwd|token|authorization|bearer)\b")


@dataclass
class DecodeStep:
    method: str
    input_hash: str
    output_excerpt: str
    confidence: float
    why_continue: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method,
            "input_hash": self.input_hash,
            "output_excerpt": self.output_excerpt,
            "confidence": round(self.confidence, 3),
            "why_continue": self.why_continue,
        }


@dataclass
class DecodeNode:
    data: bytes
    source: str
    depth: int = 0
    chain: List[DecodeStep] = field(default_factory=list)

    @property
    def text(self) -> str:
        return self.data.decode("utf-8", errors="ignore")


class CTFMiscSolver:
    def __init__(self, max_depth: int = 6, flag_format: str = "flag{...}") -> None:
        self.max_depth = max_depth
        self.flag_format = flag_format or "flag{...}"
        self.extractor = AnswerCandidateExtractor()
        self.flag_regex = self._flag_regex(self.flag_format)

    def solve(self, inputs: Iterable[Tuple[str, bytes | str]]) -> Dict[str, Any]:
        queue: deque[DecodeNode] = deque()
        for source, value in inputs:
            data = value.encode("utf-8", errors="ignore") if isinstance(value, str) else bytes(value)
            if data:
                queue.append(DecodeNode(data=data[:MAX_NODE_BYTES], source=source))

        seen: set[Tuple[str, int]] = set()
        candidates: Dict[str, Dict[str, Any]] = {}
        trace: List[Dict[str, Any]] = []
        visited = 0

        while queue and visited < 1000:
            node = queue.popleft()
            visited += 1
            digest = self._hash(node.data)
            key = (digest, node.depth)
            if key in seen:
                continue
            seen.add(key)
            text = node.text[:MAX_TEXT_CHARS]
            self._collect_candidates(candidates, text, node)
            if node.depth >= self.max_depth:
                continue
            children = self._decode_children(node)[:MAX_CHILDREN_PER_NODE]
            for child in children:
                trace.append(child.chain[-1].to_dict())
                queue.append(child)

        ranked = sorted(candidates.values(), key=lambda item: item["confidence"], reverse=True)
        return {
            "success": True,
            "summary": f"recursive misc solver visited {visited} nodes and found {len(ranked)} candidates",
            "candidates": ranked[:30],
            "decode_trace": trace[:300],
            "visited_nodes": visited,
            "max_depth": self.max_depth,
        }

    def _collect_candidates(self, out: Dict[str, Dict[str, Any]], text: str, node: DecodeNode) -> None:
        if not text:
            return
        matches: List[Tuple[str, str, int, int]] = []
        for match in self.flag_regex.finditer(text):
            matches.append((match.group(0), "flag_format", match.start(), match.end()))
        for raw in self.extractor.extract(text, node.source):
            value = str(raw.get("candidate") or "")
            if value:
                start = text.find(value)
                if start >= 0:
                    matches.append((value, "answer_extractor", start, start + len(value)))

        for value, source, start, end in matches:
            value = value.strip().strip("'\"`")
            if not value or self._looks_like_secret(text, start, value):
                continue
            chain = [step.to_dict() for step in node.chain]
            chain_bonus = min(len(chain) * 0.09, 0.28)
            format_bonus = 0.18 if self.flag_regex.fullmatch(value) else 0.0
            context_bonus = 0.04 if source == "flag_format" else 0.0
            confidence = min(0.98, 0.68 + chain_bonus + format_bonus + context_bonus)
            previous = out.get(value)
            if previous and previous["confidence"] >= confidence:
                continue
            out[value] = {
                "candidate": value,
                "source": f"CTFMiscSolver:{node.source}",
                "source_type": "decoded_chain" if chain else "attachment",
                "evidence": self._excerpt(text, start, end),
                "confidence": round(confidence, 3),
                "why_selected": "matches flag format and is reproducible through decode chain" if chain else "matches flag format in readable content",
                "validation_status": "unverified",
                "decode_chain": chain,
                "rank_features": {
                    "matches_flag_format": bool(self.flag_regex.fullmatch(value)),
                    "chain_length": len(chain),
                    "has_context": bool(self._excerpt(text, start, end)),
                    "reproducible": True,
                },
            }

    def _decode_children(self, node: DecodeNode) -> List[DecodeNode]:
        children: List[DecodeNode] = []
        text = node.text
        priority_tokens = self._priority_tokens(text)
        tokens = self._tokens(text, priority_tokens)
        whole_text_inputs = [] if priority_tokens else ([text] if 0 < len(text) <= 80_000 else [])

        for raw_text in tokens + whole_text_inputs:
            value = raw_text.strip()
            if not value:
                continue
            for label, decoder in (
                ("base64", self._b64decode),
                ("base32", self._b32decode),
                ("base16", self._b16decode),
                ("hex", self._hexdecode),
            ):
                decoded = decoder(value)
                if decoded:
                    self._append_bytes_child(children, node, label, decoded, f"{label} token decoded")
            jwt_text = self._decode_jwt(value)
            if jwt_text:
                self._append_text_child(children, node, "jwt_decode", jwt_text, "JWT header/payload decoded without verification")
            url_decoded = urllib.parse.unquote(value)
            if url_decoded != value:
                self._append_text_child(children, node, "url_decode", url_decoded, "URL percent-decoding reveals new printable text")
            if len(value) <= 500:
                rot13 = codecs.decode(value, "rot_13")
                if self._interesting_text(rot13) or self._encoded_score(rot13):
                    self._append_text_child(children, node, "rot13", rot13, "ROT13 produced flag-like, answer-like, or encoded text")
            if len(value) <= 220 and re.search(r"[A-Za-z]", value):
                for shift in range(1, 26):
                    shifted = self._caesar(value, shift)
                    if self._interesting_text(shifted):
                        self._append_text_child(children, node, f"caesar_{shift}", shifted, "Caesar shift produced flag-like or answer-like text")

        for label, opener in (("gzip", gzip.decompress), ("zlib", zlib.decompress)):
            try:
                inflated = opener(node.data)
            except Exception:
                continue
            self._append_bytes_child(children, node, label, inflated, f"{label} decompression succeeded")

        if self._printable_ratio(node.data) < 0.85 or "xor" in text.lower() or (node.chain and not self._interesting_text(text)):
            for key, decoded in self._xor_single_byte(node.data):
                self._append_bytes_child(children, node, f"xor_single_byte_0x{key:02x}", decoded, "single-byte XOR produced printable output")

        strings_text = "\n".join(self._strings(node.data))
        if strings_text and self._printable_ratio(node.data) < 0.65 and self._interesting_text(strings_text):
            self._append_text_child(children, node, "printable_strings", strings_text, "printable strings extracted from binary data")
        return children

    def _append_text_child(self, children: List[DecodeNode], node: DecodeNode, method: str, text: str, why: str) -> None:
        if not text or text == node.text:
            return
        if not self._mostly_printable(text) and not self._interesting_text(text):
            return
        self._append_bytes_child(children, node, method, text.encode("utf-8", errors="ignore"), why)

    def _append_bytes_child(self, children: List[DecodeNode], node: DecodeNode, method: str, data: bytes, why: str) -> None:
        if not data or data == node.data:
            return
        data = data[:MAX_NODE_BYTES]
        confidence = 0.82 if self._interesting_text(data.decode("utf-8", errors="ignore")) else 0.58
        step = DecodeStep(
            method=method,
            input_hash=self._hash(node.data),
            output_excerpt=self._excerpt(data.decode("utf-8", errors="ignore"), 0, 240),
            confidence=confidence,
            why_continue=why,
        )
        children.append(DecodeNode(data=data, source=node.source, depth=node.depth + 1, chain=node.chain + [step]))

    def _priority_tokens(self, text: str) -> List[str]:
        return re.findall(r"(?i)\b(?:payload|cipher|encoded|blob|data|secret)\s*[:=]\s*([A-Za-z0-9+/=_%.:-]{8,})", text or "")

    def _tokens(self, text: str, priority: List[str] | None = None) -> List[str]:
        priority = priority or []
        tokens = priority + re.findall(r"[A-Za-z0-9+/=_%.:-]{8,}", text or "")
        dedup: List[str] = []
        seen: set[str] = set()
        for token in tokens[:200]:
            for part in [token, token.split("=", 1)[-1] if "=" in token else ""]:
                part = part.strip()
                if len(part) >= 8 and part not in seen:
                    seen.add(part)
                    dedup.append(part)
        return dedup

    def _b64decode(self, value: str) -> bytes:
        raw = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9+/=_-]{8,}", raw):
            return b""
        raw = raw.replace("-", "+").replace("_", "/")
        raw += "=" * ((4 - len(raw) % 4) % 4)
        try:
            return base64.b64decode(raw, validate=False)
        except (binascii.Error, ValueError):
            return b""

    def _b32decode(self, value: str) -> bytes:
        raw = value.strip().upper()
        if not re.fullmatch(r"[A-Z2-7=]{8,}", raw):
            return b""
        raw += "=" * ((8 - len(raw) % 8) % 8)
        try:
            return base64.b32decode(raw, casefold=True)
        except (binascii.Error, ValueError):
            return b""

    def _b16decode(self, value: str) -> bytes:
        raw = value.strip().upper()
        if not re.fullmatch(r"[0-9A-F]{8,}", raw) or len(raw) % 2:
            return b""
        try:
            return base64.b16decode(raw)
        except (binascii.Error, ValueError):
            return b""

    def _hexdecode(self, value: str) -> bytes:
        raw = value.strip()
        if not re.fullmatch(r"(?:0x)?[0-9a-fA-F]{8,}", raw):
            return b""
        raw = raw[2:] if raw.lower().startswith("0x") else raw
        if len(raw) % 2:
            return b""
        try:
            return bytes.fromhex(raw)
        except ValueError:
            return b""

    def _decode_jwt(self, value: str) -> str:
        parts = value.split(".")
        if len(parts) < 2:
            return ""
        decoded: List[str] = []
        for part in parts[:2]:
            raw = part + "=" * ((4 - len(part) % 4) % 4)
            try:
                data = base64.urlsafe_b64decode(raw)
                decoded.append(data.decode("utf-8", errors="ignore"))
            except Exception:
                return ""
        return "\n".join(decoded)

    def _xor_single_byte(self, data: bytes) -> List[Tuple[int, bytes]]:
        if not data or len(data) > 64_000:
            return []
        interesting: List[Tuple[int, bytes]] = []
        encoded_like: List[Tuple[int, int, bytes]] = []
        printable: List[Tuple[int, bytes]] = []
        for key in range(256):
            decoded = bytes(b ^ key for b in data)
            text = decoded.decode("utf-8", errors="ignore")
            if self._interesting_text(text):
                interesting.append((key, decoded))
            elif self._printable_ratio(decoded) > 0.92:
                score = self._encoded_score(text)
                if score:
                    encoded_like.append((score, key, decoded))
                else:
                    printable.append((key, decoded))
        if interesting:
            return interesting[:12]
        if encoded_like:
            ranked = sorted(encoded_like, key=lambda item: item[0], reverse=True)
            return [(key, decoded) for _, key, decoded in ranked[:8]]
        return printable[:4]

    def _encoded_score(self, text: str) -> int:
        value = (text or "").strip()
        if len(value) < 12:
            return 0
        if re.fullmatch(r"[A-Za-z0-9+/=_-]{16,}", value) and len(value) % 4 in {0, 2, 3}:
            return 4
        if re.fullmatch(r"(?:0x)?[0-9a-fA-F]{16,}", value) and len(value.replace("0x", "")) % 2 == 0:
            return 3
        if "%" in value and re.search(r"%[0-9A-Fa-f]{2}", value):
            return 2
        return 0

    def _strings(self, data: bytes, min_len: int = 4) -> List[str]:
        found = re.findall(rb"[\x20-\x7e]{%d,}" % min_len, data)
        utf16 = re.findall((rb"(?:[\x20-\x7e]\x00){%d,}" % min_len), data)
        strings = [item.decode("ascii", errors="ignore") for item in found[:200]]
        strings.extend(item.decode("utf-16le", errors="ignore") for item in utf16[:80])
        return [s for s in strings if s.strip()]

    def _caesar(self, value: str, shift: int) -> str:
        out = []
        for ch in value:
            if "a" <= ch <= "z":
                out.append(chr((ord(ch) - 97 + shift) % 26 + 97))
            elif "A" <= ch <= "Z":
                out.append(chr((ord(ch) - 65 + shift) % 26 + 65))
            else:
                out.append(ch)
        return "".join(out)

    def _flag_regex(self, flag_format: str) -> re.Pattern[str]:
        if "{...}" in flag_format:
            prefix = re.escape(flag_format.split("{", 1)[0])
            return re.compile(prefix + r"\{[^{}\r\n]{1,160}\}", re.IGNORECASE)
        if "{" in flag_format and "}" in flag_format:
            prefix = re.escape(flag_format.split("{", 1)[0])
            return re.compile(prefix + r"\{[^{}\r\n]{1,160}\}", re.IGNORECASE)
        return re.compile(r"\b(?:flag|ctf)\{[^{}\r\n]{1,160}\}", re.IGNORECASE)

    def _mostly_printable(self, value: str) -> bool:
        if not value or len(value) < 3:
            return False
        printable = sum(1 for ch in value if ch in string.printable)
        return printable / max(len(value), 1) > 0.82

    def _printable_ratio(self, data: bytes) -> float:
        if not data:
            return 0.0
        return sum(1 for b in data if b in PRINTABLE) / len(data)

    def _interesting_text(self, text: str) -> bool:
        if not text:
            return False
        return bool(self.flag_regex.search(text) or re.search(r"(?i)\b(answer|flag|ctf|result)\b", text))

    def _looks_like_secret(self, text: str, start: int, value: str) -> bool:
        window = text[max(0, start - 100): start + 120].lower()
        if value.startswith(("sk-", "AKIA")):
            return True
        if SECRET_RE.search(window) and not re.search(r"(?i)\b(flag|answer|ctf|result)\b", window):
            return True
        return False

    def _excerpt(self, text: str, start: int, end: int) -> str:
        if not text:
            return ""
        return text[max(0, start - 100): min(len(text), end + 180)].replace("\x00", "").strip()[:500]

    def _hash(self, data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()


def candidates_to_json(candidates: List[Dict[str, Any]]) -> str:
    return json.dumps(candidates, ensure_ascii=False, indent=2)

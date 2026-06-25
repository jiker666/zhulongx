"""
Static CTF file triage for reverse/forensics lanes.

No binaries are executed. The analyzer records magic, hashes, strings, simple
container hints, and flag-like candidates found in readable content.
"""
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path
from typing import Any, Dict, List

from app.core.answer_extractor import AnswerCandidateExtractor
from app.core.solve_access_guard import SolveAccessDenied, get_active_solve_guard


MAX_READ = 5 * 1024 * 1024


class CTFStaticSolver:
    def __init__(self, min_string_len: int = 4) -> None:
        self.min_string_len = min_string_len
        self.extractor = AnswerCandidateExtractor()

    def analyze_file(self, path: str | Path) -> Dict[str, Any]:
        p = Path(path)
        guard = get_active_solve_guard()
        data = guard.read_bytes(p, tool_name="CTFStaticSolver", max_bytes=MAX_READ) if guard else p.read_bytes()[:MAX_READ]
        text = self._strings(data)
        format_info = self._format(p, data)
        hints = self._hints(p, data)
        candidates = self.extractor.extract("\n".join(text), f"static:{p.name}")
        return {
            "path": str(p),
            "name": p.name,
            "size": p.stat().st_size,
            "sha256": hashlib.sha256(data).hexdigest(),
            "md5": hashlib.md5(data).hexdigest(),  # nosec - only file identity in CTF triage
            "format": format_info,
            "strings_ascii": text[:200],
            "strings_utf16le": self._utf16_strings(data)[:120],
            "flag_like": candidates[:20],
            "hints": hints,
            "executed_binary": False,
        }

    def analyze_many(self, paths: List[str | Path]) -> Dict[str, Any]:
        files = [self.analyze_file(path) for path in paths if Path(path).exists() and Path(path).is_file()]
        candidates = []
        for item in files:
            candidates.extend(item.get("flag_like", []))
        return {
            "success": True,
            "summary": f"static solver analyzed {len(files)} file(s), found {len(candidates)} flag-like candidates",
            "files": files,
            "candidates": candidates,
        }

    def _format(self, path: Path, data: bytes) -> Dict[str, str]:
        head = data[:16]
        suffix = path.suffix.lower()
        magic = "unknown"
        if head.startswith(b"\x7fELF"):
            magic = "ELF"
        elif head.startswith(b"MZ"):
            magic = "PE"
        elif head[:4] in {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe"}:
            magic = "Mach-O"
        elif head.startswith(b"\xca\xfe\xba\xbe"):
            magic = "class"
        elif head.startswith(b"PK\x03\x04"):
            magic = "ZIP/JAR/APK"
        elif head.startswith(b"\x89PNG\r\n\x1a\n"):
            magic = "PNG"
        elif head.startswith(b"\xff\xd8\xff"):
            magic = "JPEG"
        elif head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
            magic = "GIF"
        elif head.startswith(b"%PDF"):
            magic = "PDF"
        elif head.startswith(b"\xd4\xc3\xb2\xa1") or head.startswith(b"\xa1\xb2\xc3\xd4") or head.startswith(b"\x0a\x0d\x0d\x0a"):
            magic = "PCAP/PCAPNG"
        elif suffix in {".jar", ".apk"}:
            magic = suffix.lstrip(".").upper()
        return {"magic": magic, "suffix": suffix or "(none)"}

    def _hints(self, path: Path, data: bytes) -> List[Dict[str, Any]]:
        hints: List[Dict[str, Any]] = []
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            chunks = re.findall(rb"(.{4})([A-Za-z]{4})", data[:4096])
            hints.append({"type": "png_chunks", "chunks": [c[1].decode("ascii", errors="ignore") for c in chunks[:20]]})
            if b"IEND" in data and data.rfind(b"IEND") + 8 < len(data):
                hints.append({"type": "png_trailing_data", "offset": data.rfind(b"IEND") + 8})
        if data.startswith(b"%PDF"):
            metadata = {}
            for key in [b"Title", b"Author", b"Creator", b"Producer"]:
                m = re.search(rb"/" + key + rb"\s*\(([^)]{1,200})\)", data[:MAX_READ])
                if m:
                    metadata[key.decode()] = m.group(1).decode("utf-8", errors="ignore")
            hints.append({"type": "pdf_metadata", "metadata": metadata})
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as zf:
                guard = get_active_solve_guard()
                entries = []
                for info in zf.infolist()[:50]:
                    if guard:
                        try:
                            guard.validate_archive_member(path, info.filename, tool_name="CTFStaticSolver")
                        except SolveAccessDenied:
                            continue
                    entries.append(info.filename)
                hints.append({"type": "zip_entries", "entries": entries})
        if path.suffix.lower() in {".pcap", ".pcapng"}:
            hints.append({"type": "pcap_static", "note": "tshark not invoked by static solver; inspect HTTP/DNS manually if needed"})
        return hints

    def _strings(self, data: bytes) -> List[str]:
        pattern = rb"[\x20-\x7e]{%d,}" % self.min_string_len
        return [item.decode("ascii", errors="ignore") for item in re.findall(pattern, data)]

    def _utf16_strings(self, data: bytes) -> List[str]:
        pattern = rb"(?:[\x20-\x7e]\x00){%d,}" % self.min_string_len
        return [item.decode("utf-16le", errors="ignore") for item in re.findall(pattern, data)]


def static_result_json(result: Dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False, indent=2)

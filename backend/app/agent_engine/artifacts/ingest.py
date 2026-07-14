from __future__ import annotations

import csv
import hashlib
import json
import mimetypes
import os
import shutil
import struct
import tarfile
import zipfile
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Callable
from xml.etree import ElementTree

from app.agent_engine.artifacts.model import Artifact, ExtractionResult


Extractor = Callable[[Path, str], ExtractionResult]


def _bounded_text(path: Path, limit: int = 100_000) -> str:
    return path.read_bytes()[:limit].decode("utf-8", errors="replace")


def _text_extractor(path: Path, media_type: str) -> ExtractionResult:
    text = _bounded_text(path)
    lines = text.splitlines()
    return ExtractionResult(
        "text",
        f"{len(lines)} text lines; {len(text)} indexed characters",
        {"line_count": len(lines), "truncated": path.stat().st_size > len(text.encode('utf-8'))},
        tuple("\n".join(lines[index:index + 100]) for index in range(0, min(len(lines), 1000), 100)),
    )


def _structured_extractor(path: Path, media_type: str) -> ExtractionResult:
    suffix = path.suffix.lower()
    text = _bounded_text(path)
    metadata: dict[str, object] = {"format": suffix.lstrip(".")}
    summary = "structured document indexed"
    if suffix == ".json":
        value = json.loads(text)
        metadata["root_type"] = type(value).__name__
        metadata["top_level_keys"] = list(value)[:100] if isinstance(value, dict) else []
    elif suffix == ".csv":
        rows = list(csv.reader(text.splitlines()[:1001]))
        metadata["columns"] = rows[0] if rows else []
        metadata["sample_rows"] = max(0, len(rows) - 1)
    elif suffix == ".xml":
        root = ElementTree.fromstring(text)
        metadata["root_tag"] = root.tag
    else:
        metadata["line_count"] = len(text.splitlines())
    return ExtractionResult("structured", summary, metadata, (text[:50_000],))


def _safe_member(name: str) -> bool:
    normalized = PurePosixPath(name.replace("\\", "/"))
    return bool(name) and not normalized.is_absolute() and ".." not in normalized.parts


def _archive_extractor(path: Path, media_type: str) -> ExtractionResult:
    members: list[dict[str, object]] = []
    risks: set[str] = set()
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for item in archive.infolist()[:5000]:
                safe = _safe_member(item.filename)
                if not safe:
                    risks.add("path_traversal_member")
                members.append({"name": item.filename, "size": item.file_size, "safe": safe})
    elif tarfile.is_tarfile(path):
        with tarfile.open(path, "r:*") as archive:
            for item in archive.getmembers()[:5000]:
                safe = _safe_member(item.name) and not item.issym() and not item.islnk()
                if not safe:
                    risks.add("unsafe_tar_member")
                members.append({"name": item.name, "size": item.size, "safe": safe, "type": item.type.decode(errors="ignore")})
    return ExtractionResult(
        "archive_inventory",
        f"archive inventory contains {len(members)} members",
        {"members": members, "member_count": len(members)},
        risk_tags=tuple(sorted(risks)),
    )


def _office_extractor(path: Path, media_type: str) -> ExtractionResult:
    texts: list[str] = []
    metadata: dict[str, object] = {"container": "ooxml"}
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        metadata["parts"] = names[:500]
        for name in names:
            if not name.endswith(".xml") or not _safe_member(name):
                continue
            if not any(prefix in name for prefix in ("word/", "ppt/slides/", "xl/sharedStrings", "docProps/")):
                continue
            try:
                root = ElementTree.fromstring(archive.read(name))
            except ElementTree.ParseError:
                continue
            content = " ".join(item.strip() for item in root.itertext() if item.strip())
            if content:
                texts.append(f"[{name}] {content}")
    joined = "\n".join(texts)
    return ExtractionResult("ooxml", f"indexed {len(texts)} Office XML parts", metadata, (joined[:100_000],))


def _pdf_extractor(path: Path, media_type: str) -> ExtractionResult:
    data = path.read_bytes()[:2_000_000]
    pages = data.count(b"/Type /Page")
    encrypted = b"/Encrypt" in data
    return ExtractionResult(
        "pdf_metadata",
        f"PDF metadata indexed; approximately {pages} pages",
        {"page_markers": pages, "encrypted": encrypted, "header": data[:8].decode("ascii", errors="replace")},
        risk_tags=("encrypted",) if encrypted else (),
    )


def _image_extractor(path: Path, media_type: str) -> ExtractionResult:
    data = path.read_bytes()[:32]
    width = height = 0
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
    return ExtractionResult("image_metadata", f"image metadata {width}x{height}" if width else "image metadata indexed", {
        "width": width, "height": height, "format": path.suffix.lower().lstrip("."),
    })


def _pcap_extractor(path: Path, media_type: str) -> ExtractionResult:
    header = path.read_bytes()[:24]
    magic = header[:4].hex()
    return ExtractionResult("pcap_metadata", "packet capture metadata indexed", {
        "magic": magic, "captured_bytes": path.stat().st_size, "format": "pcapng" if magic == "0a0d0d0a" else "pcap",
    })


def _binary_extractor(path: Path, media_type: str) -> ExtractionResult:
    data = path.read_bytes()[:4096]
    if data.startswith(b"\x7fELF"):
        kind = "ELF"
        architecture = int.from_bytes(data[18:20], "little") if len(data) >= 20 else 0
    elif data.startswith(b"MZ"):
        kind = "PE"
        architecture = 0
    elif path.suffix.lower() == ".apk" and zipfile.is_zipfile(path):
        kind = "APK"
        architecture = 0
    else:
        kind = "binary"
        architecture = 0
    printable = sum(1 for byte in data if byte in (9, 10, 13) or 32 <= byte < 127)
    return ExtractionResult("binary_metadata", f"{kind} metadata indexed", {
        "kind": kind, "architecture_id": architecture, "sample_entropy_signal": round(1 - printable / max(1, len(data)), 4),
    }, risk_tags=("executable",) if kind in {"ELF", "PE", "APK"} else ())


class ExtractorRegistry:
    def __init__(self) -> None:
        self._extractors: list[tuple[set[str], set[str], Extractor]] = []

    @classmethod
    def defaults(cls) -> "ExtractorRegistry":
        registry = cls()
        registry.register({".json", ".yaml", ".yml", ".csv", ".xml"}, set(), _structured_extractor)
        registry.register({".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz"}, set(), _archive_extractor)
        registry.register({".docx", ".pptx", ".xlsx"}, set(), _office_extractor)
        registry.register({".pdf"}, {"application/pdf"}, _pdf_extractor)
        registry.register({".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}, set(), _image_extractor)
        registry.register({".pcap", ".pcapng"}, set(), _pcap_extractor)
        registry.register({".elf", ".exe", ".dll", ".so", ".apk", ".bin"}, set(), _binary_extractor)
        registry.register({".txt", ".md", ".log", ".py", ".js", ".c", ".java"}, {"text/plain"}, _text_extractor)
        return registry

    def register(self, extensions: set[str], media_types: set[str], extractor: Extractor) -> None:
        self._extractors.append(({item.lower() for item in extensions}, set(media_types), extractor))

    def extract(self, path: Path, media_type: str) -> ExtractionResult:
        suffix = path.suffix.lower()
        for extensions, media_types, extractor in self._extractors:
            if suffix in extensions or media_type in media_types:
                try:
                    return extractor(path, media_type)
                except (OSError, ValueError, KeyError, zipfile.BadZipFile, tarfile.TarError, ElementTree.ParseError) as exc:
                    return ExtractionResult(
                        "metadata_only",
                        f"extractor could not parse {path.name}",
                        {"error_type": type(exc).__name__},
                        risk_tags=("parse_error",),
                    )
        return _binary_extractor(path, media_type)


class ArtifactIngestor:
    """Copy immutable inputs into content-addressed storage and build a bounded inventory."""

    def __init__(self, workspace: str | Path, registry: ExtractorRegistry | None = None) -> None:
        self.workspace = Path(workspace).expanduser().resolve()
        self.root = self.workspace / ".agent_artifacts"
        self.registry = registry or ExtractorRegistry.defaults()

    def ingest(self, source: str | Path, *, visibility: str = "run") -> Artifact:
        original = Path(source).expanduser().resolve(strict=True)
        if not original.is_file():
            raise ValueError("artifact source is not a file")
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        media_type = mimetypes.guess_type(original.name)[0] or "application/octet-stream"
        destination = self.root / "inputs" / f"{digest}{original.suffix.lower()}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            temporary = destination.with_suffix(destination.suffix + ".tmp")
            shutil.copyfile(original, temporary)
            os.chmod(temporary, 0o400)
            temporary.replace(destination)
        extraction = self.registry.extract(destination, media_type)
        artifact = Artifact(
            artifact_id=f"artifact_{digest[:24]}",
            original_name=original.name,
            media_type=media_type,
            size=original.stat().st_size,
            sha256=digest,
            source=str(original),
            storage_path=str(destination.relative_to(self.workspace)),
            extraction=extraction,
            risk_tags=extraction.risk_tags,
            visibility=visibility,
        )
        return artifact

    def bind_evidence(self, artifact: Artifact, evidence_ids: tuple[str, ...]) -> Artifact:
        return replace(artifact, evidence_ids=evidence_ids)

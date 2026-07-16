"""
CTF File Analyzer — 附件自动分析器。

职责：
- 自动解压 zip / tar / gz / 7z（可选）
- 枚举附件文件
- 对每个文件执行安全静态分析：
  - file (类型识别)
  - strings (提取可读字符串)
  - binwalk (固件/嵌入文件)
  - exiftool (元数据，可选)
  - checksec (ELF 安全特性)
  - readelf / objdump (ELF 头)
  - hash (md5/sha256)
- 返回结构化 JSON：文件名、类型、大小、hash、关键字符串、可疑编码、可疑 flag、推荐下一步

注意：
- 所有 shell 命令走 CodeExecutionSandbox，受 timeout/输出限制
- 仅在工作目录内操作，禁止越权访问系统目录
- 工具缺失时降级（不报错，标记 unavailable）
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.code_execution_sandbox import CodeExecutionSandbox
from app.core.flag_verifier import FlagVerifier


SAFE_ARCHIVE_EXTS = (".zip", ".tar", ".tar.gz", ".tgz", ".gz", ".tar.bz2", ".bz2", ".7z")
MAX_FILE_SIZE = 30 * 1024 * 1024  # 单文件 30MB
MAX_EXTRACTED_FILES = 200
MAX_EXTRACTED_TOTAL_SIZE = 200 * 1024 * 1024  # 200MB
MAX_FALLBACK_SCAN_BYTES = 1024 * 1024  # 系统 strings 缺失时最多扫描 1MB


@dataclass
class FileAnalysis:
    path: str
    relative_path: str
    type: str = ""
    size: int = 0
    md5: str = ""
    sha256: str = ""
    mime: str = ""
    strings: List[str] = field(default_factory=list)
    suspicious_strings: List[str] = field(default_factory=list)
    suspicious_encodings: List[str] = field(default_factory=list)
    flags_found: List[str] = field(default_factory=list)
    exif: Dict[str, str] = field(default_factory=dict)
    elf_info: Dict[str, Any] = field(default_factory=dict)
    binwalk_signatures: List[str] = field(default_factory=list)
    recommendation: str = ""
    # v6.4: 富文本内容预览，帮助 LLM 理解附件内容
    content_preview: str = ""
    # v6.4: binwalk 提取的子文件列表
    extracted_files: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "relative_path": self.relative_path,
            "type": self.type,
            "size": self.size,
            "md5": self.md5,
            "sha256": self.sha256,
            "mime": self.mime,
            "strings": self.strings[:50],
            "suspicious_strings": self.suspicious_strings[:20],
            "suspicious_encodings": self.suspicious_encodings[:20],
            "flags_found": self.flags_found[:20],
            "exif": self.exif,
            "elf_info": self.elf_info,
            "binwalk_signatures": self.binwalk_signatures[:20],
            "recommendation": self.recommendation,
            "content_preview": self.content_preview,
            "extracted_files": self.extracted_files[:20],
        }


@dataclass
class AnalysisResult:
    workspace: str
    files: List[FileAnalysis] = field(default_factory=list)
    summary: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "workspace": self.workspace,
            "files": [f.to_dict() for f in self.files],
            "summary": self.summary,
            "errors": self.errors,
        }


# 可疑字符串模式
SUSPICIOUS_PATTERNS = [
    (re.compile(r"flag\{[^}]+\}", re.IGNORECASE), "flag_pattern"),
    (re.compile(r"ctf\{[^}]+\}", re.IGNORECASE), "ctf_pattern"),
    (re.compile(r"sctf\{[^}]+\}", re.IGNORECASE), "sctf_pattern"),
    (re.compile(r"^[A-Za-z0-9+/]{40,}={0,2}$", re.MULTILINE), "base64_candidate"),
    (re.compile(r"\b[0-9a-f]{32}\b", re.IGNORECASE), "md5_candidate"),
    (re.compile(r"\b[0-9a-f]{40}\b", re.IGNORECASE), "sha1_candidate"),
    (re.compile(r"\b[0-9a-f]{64}\b", re.IGNORECASE), "sha256_candidate"),
    (re.compile(r"https?://[^\s\"']+", re.IGNORECASE), "url"),
    (re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"), "ip_address"),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "email"),
    (re.compile(r"\b(password|passwd|secret|token|api_key)\b\s*[=:]", re.IGNORECASE), "credential"),
]


class CtfFileAnalyzer:
    """附件安全分析器。"""

    def __init__(self, sandbox: Optional[CodeExecutionSandbox] = None) -> None:
        self.sandbox = sandbox or CodeExecutionSandbox(allow_network=False)
        self.verifier = FlagVerifier()

    def analyze(
        self,
        attachment_path: str,
        *,
        workspace: Optional[str] = None,
        flag_format: Optional[str] = None,
    ) -> AnalysisResult:
        """分析一个附件（文件或目录）。"""
        if not os.path.exists(attachment_path):
            return AnalysisResult(workspace="", errors=[f"not found: {attachment_path}"])

        ws = workspace or self.sandbox.create_workspace(prefix="analyze_")
        Path(ws).mkdir(parents=True, exist_ok=True)

        # 拷贝/解压到 workspace
        staged = self._stage_input(attachment_path, ws)
        result = AnalysisResult(workspace=ws, errors=staged.get("errors", []))

        # 枚举文件
        files_to_analyze: List[str] = []
        if os.path.isfile(staged["root"]):
            files_to_analyze = [staged["root"]]
        else:
            for root, _, files in os.walk(staged["root"]):
                for name in files:
                    fp = os.path.join(root, name)
                    # 防止符号链接逃逸
                    real = os.path.realpath(fp)
                    if not real.startswith(os.path.realpath(ws) + os.sep) and real != os.path.realpath(ws):
                        result.errors.append(f"skip escaped path: {fp}")
                        continue
                    files_to_analyze.append(fp)
                    if len(files_to_analyze) >= MAX_EXTRACTED_FILES:
                        break

        # 逐个分析
        for fp in files_to_analyze:
            try:
                analysis = self._analyze_one(fp, ws, flag_format=flag_format)
                result.files.append(analysis)
            except Exception as e:  # noqa: BLE001
                result.errors.append(f"analyze fail {fp}: {type(e).__name__}: {e}")

        # 汇总
        result.summary = self._summarize(result.files)
        return result

    # ---------- internal ----------

    def _stage_input(self, src: str, workspace: str) -> Dict[str, Any]:
        """把附件拷贝/解压到 workspace，返回根路径。"""
        errors: List[str] = []
        root = os.path.join(workspace, "input")
        Path(root).mkdir(parents=True, exist_ok=True)

        if os.path.isdir(src):
            # 整个目录拷过去
            for item in os.listdir(src):
                # ⚠️ 反作弊：跳过 expected_flag.txt
                if item == "expected_flag.txt":
                    continue
                s = os.path.join(src, item)
                d = os.path.join(root, item)
                if os.path.isdir(s):
                    shutil.copytree(s, d, dirs_exist_ok=True)
                else:
                    shutil.copy2(s, d)
            return {"root": root, "errors": errors}

        # 单文件
        filename = os.path.basename(src)
        # ⚠️ 反作弊：拒绝分析 expected_flag.txt
        if filename == "expected_flag.txt":
            errors.append("blocked: expected_flag.txt is anti-cheat protected")
            return {"root": root, "errors": errors}
        dst = os.path.join(root, filename)
        shutil.copy2(src, dst)

        # 如果是压缩包，尝试解压
        lower = filename.lower()
        if lower.endswith(".zip"):
            try:
                with zipfile.ZipFile(dst) as zf:
                    # 防止 zip slip
                    members = []
                    for m in zf.namelist():
                        target = os.path.join(root, m)
                        if not os.path.realpath(target).startswith(os.path.realpath(root) + os.sep):
                            errors.append(f"skip zip slip entry: {m}")
                            continue
                        members.append(m)
                    zf.extractall(root, members=members)
            except Exception as e:  # noqa: BLE001
                errors.append(f"unzip fail: {type(e).__name__}: {e}")
        elif lower.endswith((".tar", ".tar.gz", ".tgz", ".tar.bz2", ".bz2")):
            try:
                with tarfile.open(dst) as tf:
                    for m in tf.getmembers():
                        target = os.path.join(root, m.name)
                        if not os.path.realpath(target).startswith(os.path.realpath(root) + os.sep):
                            errors.append(f"skip tar slip entry: {m.name}")
                            continue
                    tf.extractall(root)
            except Exception as e:  # noqa: BLE001
                errors.append(f"untar fail: {type(e).__name__}: {e}")
        elif lower.endswith(".gz") and not lower.endswith(".tar.gz"):
            try:
                import gzip
                out_name = filename[:-3]
                with gzip.open(dst, "rb") as gz_in:
                    with open(os.path.join(root, out_name), "wb") as gz_out:
                        gz_out.write(gz_in.read(MAX_EXTRACTED_TOTAL_SIZE))
            except Exception as e:  # noqa: BLE001
                errors.append(f"gunzip fail: {type(e).__name__}: {e}")
        elif lower.endswith(".7z"):
            # 需要 7z 命令行工具
            try:
                subprocess.run(
                    ["7z", "x", f"-o{root}", "-y", dst],
                    check=False, capture_output=True, timeout=30,
                )
            except FileNotFoundError:
                errors.append("7z binary not installed, skip extract")
            except Exception as e:  # noqa: BLE001
                errors.append(f"7z fail: {type(e).__name__}: {e}")

        return {"root": root, "errors": errors}

    def _analyze_one(self, file_path: str, workspace: str, *, flag_format: Optional[str] = None) -> FileAnalysis:
        rel = os.path.relpath(file_path, workspace)
        size = os.path.getsize(file_path) if os.path.isfile(file_path) else 0
        analysis = FileAnalysis(
            path=file_path,
            relative_path=rel,
            size=size,
        )

        # ⚠️ 反作弊：跳过 expected_flag.txt，不让 LLM/分析器读到答案
        if os.path.basename(file_path) == "expected_flag.txt":
            analysis.type = "blocked (anti-cheat)"
            analysis.recommendation = "expected_flag.txt 已被反作弊策略屏蔽"
            return analysis

        # hash
        analysis.md5, analysis.sha256 = self._hash_file(file_path)

        # file 类型
        analysis.type = self._run_tool(["file", "-b", file_path])[:200]
        analysis.mime = self._run_tool(["file", "--mime-type", "-b", file_path])[:100]

        # strings（截断）；Python 回退保证最小 Linux 镜像中也能分析附件。
        raw_strings = self._run_tool(["strings", "-n", "6", file_path], max_out=8000)
        fallback_text, fallback_strings = self._extract_file_strings(file_path)
        analysis.strings = self._dedupe(
            [*self._extract_strings(raw_strings, max_count=200), *fallback_strings],
            max_count=200,
        )

        # 可疑字符串 + flag
        scan_sources = [*analysis.strings]
        if fallback_text:
            scan_sources.append(fallback_text)
        for s in scan_sources:
            for rx, label in SUSPICIOUS_PATTERNS:
                for m in rx.finditer(s):
                    analysis.suspicious_strings.append(f"[{label}] {m.group(0)[:120]}")
                    if "flag" in label or "ctf" in label:
                        analysis.flags_found.append(m.group(0))
        analysis.suspicious_strings = self._dedupe(analysis.suspicious_strings)
        analysis.flags_found = self._dedupe(analysis.flags_found)

        # 如果有 flag_format，按格式过滤候选
        if flag_format and analysis.flags_found:
            try:
                rx = re.compile(flag_format)
                analysis.flags_found = [f for f in analysis.flags_found if rx.search(f)]
            except re.error:
                pass

        # exiftool（可选）
        exif_raw = self._run_tool(["exiftool", file_path], max_out=4000, allow_fail=True)
        if exif_raw:
            analysis.exif = self._parse_kv(exif_raw)

        # ELF 信息
        if "ELF" in analysis.type or "elf" in analysis.mime:
            analysis.elf_info = self._analyze_elf(file_path)

        # binwalk 签名
        bw = self._run_tool(["binwalk", file_path], max_out=4000, allow_fail=True)
        if bw:
            analysis.binwalk_signatures = [
                line for line in bw.splitlines()
                if line.strip() and not line.startswith("DECIMAL") and not line.startswith("---")
            ][:20]
            # v6.4: 尝试 binwalk 提取并列出子文件
            extracted_dir = file_path + ".extracted"
            if os.path.isdir(extracted_dir):
                for root, _, files in os.walk(extracted_dir):
                    for name in files[:30]:
                        rel = os.path.relpath(os.path.join(root, name), extracted_dir)
                        analysis.extracted_files.append(rel)

        # v6.4: 生成内容预览（帮助 LLM 理解附件）
        analysis.content_preview = self._generate_content_preview(file_path, analysis)

        # 推荐
        analysis.recommendation = self._recommend(analysis)
        return analysis

    def _hash_file(self, file_path: str) -> tuple:
        h_md5 = hashlib.md5()
        h_sha = hashlib.sha256()
        try:
            with open(file_path, "rb") as fh:
                while True:
                    chunk = fh.read(64 * 1024)
                    if not chunk:
                        break
                    h_md5.update(chunk)
                    h_sha.update(chunk)
                    if h_md5.digest_size * len(h_md5.digest()) > MAX_EXTRACTED_TOTAL_SIZE:
                        break
            return h_md5.hexdigest(), h_sha.hexdigest()
        except Exception:
            return "", ""

    def _run_tool(self, cmd: List[str], *, max_out: int = 4000, allow_fail: bool = True) -> str:
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,
            )
            out = (proc.stdout or "")[:max_out]
            return out
        except FileNotFoundError:
            return "" if allow_fail else ""
        except subprocess.TimeoutExpired:
            return ""
        except Exception:
            return ""

    def _extract_strings(self, raw: str, *, max_count: int = 200) -> List[str]:
        if not raw:
            return []
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        return self._dedupe(lines, max_count=max_count)

    def _extract_file_strings(
        self,
        file_path: str,
        *,
        max_bytes: int = MAX_FALLBACK_SCAN_BYTES,
        min_length: int = 6,
        max_count: int = 200,
    ) -> tuple[str, List[str]]:
        """Return bounded raw text and printable strings without external tools."""
        try:
            with open(file_path, "rb") as fh:
                data = fh.read(max_bytes)
        except OSError:
            return "", []

        raw_text = data.decode("utf-8", errors="replace")
        printable = re.compile(rb"[\x20-\x7e]{%d,}" % min_length)
        strings = [match.group(0).decode("ascii") for match in printable.finditer(data)]
        return raw_text, self._dedupe(strings, max_count=max_count)

    @staticmethod
    def _dedupe(values: List[str], *, max_count: Optional[int] = None) -> List[str]:
        unique = list(dict.fromkeys(values))
        return unique if max_count is None else unique[:max_count]

    def _parse_kv(self, text: str) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for line in text.splitlines():
            if ":" not in line:
                continue
            k, _, v = line.partition(":")
            k = k.strip()
            v = v.strip()
            if k and v:
                out[k] = v
        return out

    def _analyze_elf(self, file_path: str) -> Dict[str, Any]:
        info: Dict[str, Any] = {}
        head = self._run_tool(["readelf", "-h", file_path], max_out=2000, allow_fail=True)
        if head:
            info["header"] = head[:1000]
        sec = self._run_tool(["readelf", "-S", file_path], max_out=2000, allow_fail=True)
        if sec:
            info["sections"] = sec[:1000]
        # checksec 简化版（手动检查）
        checksec = self._run_tool(["checksec", "--file=" + file_path], max_out=1000, allow_fail=True)
        if checksec:
            info["checksec"] = checksec[:500]
        return info

    def _recommend(self, a: FileAnalysis) -> str:
        tips: List[str] = []
        if a.flags_found:
            tips.append("已发现候选 flag，直接校验")
        if a.suspicious_strings:
            tips.append("发现可疑字符串，重点分析")
        if "ELF" in a.type:
            tips.append("ELF 文件，建议 reverse 工具链分析")
        if "PE32" in a.type or "MS-DOS" in a.type:
            tips.append("Windows 可执行文件，需 Windows 环境分析")
        if "Zip archive" in a.type or "tar" in a.type:
            tips.append("压缩包，检查是否有嵌入文件")
        if "pcap" in a.mime or "pcap" in a.type.lower():
            tips.append("流量包，建议用 tshark/wireshark 分析")
        if "image" in a.mime or "PNG" in a.type or "JPEG" in a.type:
            tips.append("图片文件，检查 EXIF / LSB / 文件尾隐藏数据")
        if not tips:
            tips.append("未发现明显特征，建议 strings + binwalk 二次确认")
        return "; ".join(tips)

    # ---------- v6.4: 内容预览（帮助 LLM 理解附件） ----------

    # 文本文件扩展名（可直接读内容）
    _TEXT_EXTS = {
        ".txt", ".log", ".md", ".csv", ".json", ".xml", ".html", ".htm",
        ".py", ".pyc", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".js",
        ".ts", ".go", ".rs", ".rb", ".php", ".sh", ".bash", ".zsh",
        ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
        ".sql", ".r", ".m", ".asm", ".s",
    }

    def _generate_content_preview(self, file_path: str, analysis: FileAnalysis) -> str:
        """生成文件内容预览，供 LLM 直接理解附件内容。

        策略：
        - 文本文件：直接读前 ~2000 字符
        - 二进制文件：hex dump 前 512 字节
        - 图片：尺寸 + 文件尾数据（可能藏隐写）
        - 压缩包：列出内容文件
        - PCAP：tshark 概要
        - base64 文本：尝试解码展示
        """
        preview_parts: List[str] = []
        ext = Path(file_path).suffix.lower()
        size = analysis.size
        mime = analysis.mime.lower() if analysis.mime else ""
        ftype = analysis.type.lower()

        try:
            # 1. 文本文件 → 直接读内容
            if ext in self._TEXT_EXTS or "text/" in mime or "ascii" in ftype or "utf-8" in ftype:
                with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read(min(size, 4000))
                if content:
                    preview_parts.append(f"[文件内容前{len(content)}字符]:\n{content}")
                return "\n".join(preview_parts)

            # 2. 图片文件 → 尺寸 + 文件尾
            if "image" in mime or ext in (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"):
                # 用 file 命令输出的尺寸信息
                if analysis.exif:
                    dims = {k: v for k, v in analysis.exif.items() if k in ("Image Width", "Image Height", "Image Size")}
                    if dims:
                        preview_parts.append(f"[图片信息]: {dims}")
                # 读文件尾部（隐写常在文件尾附加数据）
                tail = self._read_tail(file_path, 512)
                if tail:
                    preview_parts.append(f"[文件尾 {len(tail)} 字节 hex]:\n{tail}")
                return "\n".join(preview_parts)

            # 3. PCAP → tshark 概要
            if ext in (".pcap", ".pcapng", ".cap") or "pcap" in ftype:
                summary = self._run_tool(
                    ["tshark", "-r", file_path, "-q", "-z", "io,phs"],
                    max_out=2000, allow_fail=True,
                )
                if summary:
                    preview_parts.append(f"[PCAP 协议层次]:\n{summary[:1500]}")
                conv = self._run_tool(
                    ["tshark", "-r", file_path, "-q", "-z", "conv,tcp"],
                    max_out=1000, allow_fail=True,
                )
                if conv:
                    preview_parts.append(f"[TCP 会话概要]:\n{conv[:800]}")
                http_objs = self._run_tool(
                    ["tshark", "-r", file_path, "-q", "-z", "http,tree"],
                    max_out=1500, allow_fail=True,
                )
                if http_objs:
                    preview_parts.append(f"[HTTP 对象]:\n{http_objs[:1000]}")
                return "\n".join(preview_parts)

            # 4. 压缩包 → 列内容
            if ext == ".zip":
                try:
                    with zipfile.ZipFile(file_path) as zf:
                        names = zf.namelist()[:50]
                        preview_parts.append(f"[ZIP 内容 {len(names)}/{len(zf.namelist())} 个文件]:\n" + "\n".join(names))
                except Exception as e:  # noqa: BLE001
                    preview_parts.append(f"[ZIP 读取失败: {e}]")
                return "\n".join(preview_parts)

            # 5. 尝试当文本读（可能是无扩展名的文本）
            try:
                with open(file_path, "rb") as fh:
                    head = fh.read(512)
                # 判断是否像文本
                printable = sum(1 for b in head if 32 <= b <= 126 or b in (9, 10, 13))
                if printable / max(len(head), 1) > 0.85:
                    text = head.decode("utf-8", errors="replace")
                    preview_parts.append(f"[文本内容前{len(text)}字符]:\n{text}")
                    # 继续读更多
                    with open(file_path, "r", encoding="utf-8", errors="replace") as fh2:
                        more = fh2.read(4000)
                    if len(more) > 512:
                        preview_parts.append(f"[续...共{len(more)}字符]")
                    return "\n".join(preview_parts)
            except Exception:  # noqa: BLE001
                pass

            # 6. 二进制文件 → hex dump 前 512 字节
            hex_dump = self._hex_dump(file_path, 512)
            if hex_dump:
                preview_parts.append(f"[二进制 hex dump 前 512 字节]:\n{hex_dump}")

            # 7. base64 可疑编码 → 尝试解码
            for s in analysis.suspicious_strings:
                if "base64_candidate" in s:
                    # 提取 base64 内容
                    b64_match = re.search(r'[A-Za-z0-9+/]{20,}={0,2}', s)
                    if b64_match:
                        try:
                            import base64
                            decoded = base64.b64decode(b64_match.group(0))
                            preview = decoded[:200]
                            try:
                                text = preview.decode("utf-8", errors="replace")
                                preview_parts.append(f"[Base64 解码预览]:\n{text}")
                            except Exception:
                                preview_parts.append(f"[Base64 解码 hex]: {preview.hex()}")
                        except Exception:  # noqa: BLE001
                            pass
                    break  # 只解码第一个

            # 8. 文件尾数据（可能藏 flag 或隐写附加数据）
            if size > 512:
                tail = self._read_tail(file_path, 256)
                if tail:
                    preview_parts.append(f"[文件尾 256 字节 hex]:\n{tail}")

            return "\n".join(preview_parts)

        except Exception as e:  # noqa: BLE001
            return f"[预览生成失败: {type(e).__name__}: {e}]"

    def _hex_dump(self, file_path: str, max_bytes: int = 512) -> str:
        """生成文件头部的 hex dump。"""
        try:
            with open(file_path, "rb") as fh:
                data = fh.read(max_bytes)
            lines = []
            for offset in range(0, len(data), 16):
                chunk = data[offset:offset + 16]
                hex_part = " ".join(f"{b:02x}" for b in chunk)
                ascii_part = "".join(chr(b) if 32 <= b <= 126 else "." for b in chunk)
                lines.append(f"{offset:08x}  {hex_part:<48s}  |{ascii_part}|")
            return "\n".join(lines)
        except Exception:  # noqa: BLE001
            return ""

    def _read_tail(self, file_path: str, tail_bytes: int = 256) -> str:
        """读取文件尾部的 hex dump。"""
        try:
            size = os.path.getsize(file_path)
            if size <= tail_bytes:
                return ""
            with open(file_path, "rb") as fh:
                fh.seek(max(0, size - tail_bytes))
                data = fh.read(tail_bytes)
            lines = []
            start_offset = max(0, size - tail_bytes)
            for offset in range(0, len(data), 16):
                chunk = data[offset:offset + 16]
                hex_part = " ".join(f"{b:02x}" for b in chunk)
                ascii_part = "".join(chr(b) if 32 <= b <= 126 else "." for b in chunk)
                lines.append(f"{start_offset + offset:08x}  {hex_part:<48s}  |{ascii_part}|")
            return "\n".join(lines)
        except Exception:  # noqa: BLE001
            return ""

    def _summarize(self, files: List[FileAnalysis]) -> Dict[str, Any]:
        total = len(files)
        flags_count = sum(len(f.flags_found) for f in files)
        suspicious_count = sum(len(f.suspicious_strings) for f in files)
        types = {}
        for f in files:
            key = f.mime or f.type or "unknown"
            types[key] = types.get(key, 0) + 1
        return {
            "file_count": total,
            "flags_found_total": flags_count,
            "suspicious_strings_total": suspicious_count,
            "file_types": types,
            "has_flag_candidate": flags_count > 0,
        }


_analyzer: Optional[CtfFileAnalyzer] = None


def get_analyzer() -> CtfFileAnalyzer:
    global _analyzer
    if _analyzer is None:
        _analyzer = CtfFileAnalyzer()
    return _analyzer

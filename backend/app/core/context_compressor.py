"""
Context Compressor — 上下文压缩器（v6 成本控制核心组件）。

职责：
- 对工具输出、文件分析、脚本错误、历史 evidence 做结构化压缩
- 保留 flag-like 字符串、异常堆栈尾部、命令/路径/magic/hash
- 删除重复日志、HTML 正文、二进制 dump
- 输出固定结构，方便下游 LLM prompt 拼装

设计原则：
- 纯函数，无外部依赖，无 I/O
- 可独立单测
- 不会泄露 API key（调用 mask_sensitive_in_text）
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.core.llm_adapter import mask_sensitive_in_text


# 常见 flag 格式
_FLAG_PATTERNS = [
    r"flag\{[^}]+\}",
    r"FLAG\{[^}]+\}",
    r"ctf\{[^}]+\}",
    r"CTF\{[^}]+\}",
    r"sctf\{[^}]+\}",
    r"SCTF\{[^}]+\}",
    r"key\{[^}]+\}",
    r"flag\[[^\]]+\]",
]
_FLAG_RE = re.compile("|".join(_FLAG_PATTERNS))

# 常见日志噪音（重复行）
_LOG_NOISE_RE = re.compile(
    r"^(DEBUG|INFO|TRACE)\s+\d{4}-\d{2}-\d{2}|^\s*$|^\s*-{20,}|^\s*=+|^\s*\*{20,}",
    re.MULTILINE,
)

# 二进制 dump 行（hexdump 风格）
_HEXDUMP_RE = re.compile(r"^[0-9a-fA-F]{8,}\s+([0-9a-fA-F]{2}\s?){1,16}", re.MULTILINE)


@dataclass
class CompressedContext:
    """压缩结果的结构化容器。"""
    facts: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    candidates: List[str] = field(default_factory=list)
    next_relevant_context: List[str] = field(default_factory=list)
    omitted_reason: str = ""
    original_chars: int = 0
    compressed_chars: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "facts": self.facts,
            "errors": self.errors,
            "candidates": self.candidates,
            "next_relevant_context": self.next_relevant_context,
            "omitted_reason": self.omitted_reason,
            "original_chars": self.original_chars,
            "compressed_chars": self.compressed_chars,
        }


def _extract_flags(text: str) -> List[str]:
    """提取 flag-like 字符串，去重保序。"""
    seen: set[str] = set()
    out: List[str] = []
    for m in _FLAG_RE.findall(text):
        if m not in seen:
            seen.add(m)
            out.append(m)
    return out


def _keep_tail(lines: List[str], n: int) -> List[str]:
    """保留最后 n 行（异常堆栈尾部最关键）。"""
    return lines[-n:] if len(lines) > n else lines


def _dedupe_adjacent(lines: List[str]) -> List[str]:
    """去重相邻重复行（日志重复输出常见）。"""
    out: List[str] = []
    prev: Optional[str] = None
    for ln in lines:
        if ln == prev:
            continue
        out.append(ln)
        prev = ln
    return out


def _strip_noise(text: str) -> str:
    """移除日志噪音行和 hexdump 行。"""
    text = _HEXDUMP_RE.sub("", text)
    text = _LOG_NOISE_RE.sub("", text)
    return text


def compress_tool_output(text: str, max_chars: int = 2000) -> CompressedContext:
    """压缩工具输出（stdout/stderr/HTTP 响应）。

    保留：
    - flag-like 字符串
    - 最后 60 行（异常尾部）
    - 命令、路径、文件名（含 / 或反斜杠的行优先保留）

    删除：
    - 重复日志行
    - hexdump / 二进制 dump
    - 空行与装饰线
    """
    if not text:
        return CompressedContext()
    text = mask_sensitive_in_text(text)
    original_chars = len(text)

    candidates = _extract_flags(text)

    cleaned = _strip_noise(text)
    raw_lines = cleaned.splitlines()
    raw_lines = _dedupe_adjacent(raw_lines)
    # 过滤掉纯空行
    raw_lines = [ln for ln in raw_lines if ln.strip()]

    # 优先保留含路径/命令线索的行
    high_signal = [
        ln for ln in raw_lines
        if "/" in ln or "\\" in ln or ln.startswith((">>>", "$", "#", "Traceback", "Error", "Exception"))
    ]
    # 兜底保留尾部
    tail = _keep_tail(raw_lines, 60)

    merged: List[str] = []
    seen: set[str] = set()
    for ln in high_signal + tail:
        if ln in seen:
            continue
        seen.add(ln)
        merged.append(ln)

    # 截断到 max_chars
    out_lines: List[str] = []
    total = 0
    for ln in merged:
        if total + len(ln) + 1 > max_chars:
            break
        out_lines.append(ln)
        total += len(ln) + 1

    compressed_chars = sum(len(ln) for ln in out_lines)
    omitted = ""
    if original_chars > max_chars and compressed_chars < original_chars:
        omitted = f"压缩 {original_chars - compressed_chars} 字符（日志噪音/二进制 dump/重复行）"

    return CompressedContext(
        facts=out_lines,
        errors=[ln for ln in out_lines if ln.startswith(("Traceback", "Error", "Exception"))],
        candidates=candidates,
        next_relevant_context=out_lines[-5:],
        omitted_reason=omitted,
        original_chars=original_chars,
        compressed_chars=compressed_chars,
    )


def compress_evidence_chain(
    evidence: List[Dict[str, Any]],
    max_items: int = 8,
) -> CompressedContext:
    """压缩 evidence chain，保留最近 N 条 + 失败项。"""
    if not evidence:
        return CompressedContext()

    original_chars = sum(len(str(e.get("output_summary", "")) + str(e.get("input_summary", ""))) for e in evidence)

    # 失败的 evidence 永远保留
    failed = [e for e in evidence if not e.get("success", True)]
    # 最近 N 条
    recent = evidence[-max_items:]

    merged: List[Dict[str, Any]] = []
    seen_step: set[str] = set()
    for e in failed + recent:
        step = e.get("step", "")
        key = f"{step}:{e.get('timestamp', 0)}"
        if key in seen_step:
            continue
        seen_step.add(key)
        merged.append(e)

    facts: List[str] = []
    errors: List[str] = []
    for e in merged[-max_items:]:
        step = e.get("step", "?")
        summary = (e.get("output_summary") or e.get("input_summary") or "")[:120]
        line = f"[{step}] {summary}"
        facts.append(line)
        if not e.get("success", True):
            errors.append(line)

    compressed_chars = sum(len(f) for f in facts)
    return CompressedContext(
        facts=facts,
        errors=errors,
        candidates=_extract_flags(" ".join(facts)),
        next_relevant_context=facts[-3:],
        omitted_reason=f"evidence {len(evidence)} -> {len(facts)} 条" if len(evidence) > max_items else "",
        original_chars=original_chars,
        compressed_chars=compressed_chars,
    )


def compress_file_analysis(
    analysis: Dict[str, Any],
    max_files: int = 8,
    max_strings_per_file: int = 15,
) -> CompressedContext:
    """压缩 CtfFileAnalyzer 输出。

    保留：
    - 每个文件 type / size / magic / 前几条可疑 strings / flags_found
    - 总体 summary
    """
    if not analysis:
        return CompressedContext()

    files = analysis.get("files", []) or []
    original_chars = len(str(analysis))

    facts: List[str] = []
    candidates: List[str] = []

    # 顶层 summary
    summary = analysis.get("summary", {})
    if summary:
        for k, v in summary.items():
            if v:
                facts.append(f"summary.{k} = {v}")

    for f in files[:max_files]:
        path = f.get("relative_path") or f.get("path") or "?"
        ftype = f.get("type", "?")
        size = f.get("size", 0)
        magic = f.get("magic", "")
        line = f"file: {path} | type={ftype} | size={size}"
        if magic:
            line += f" | magic={magic[:60]}"
        facts.append(line)

        # 可疑 strings
        sus = f.get("suspicious_strings") or []
        for s in sus[:max_strings_per_file]:
            facts.append(f"  sus: {s}")
        # flags found
        flags = f.get("flags_found") or []
        for fl in flags[:5]:
            candidates.append(fl)

    compressed_chars = sum(len(f) for f in facts)
    omitted = ""
    if len(files) > max_files:
        omitted = f"files {len(files)} -> {max_files}（仅保留前 {max_files} 个）"

    return CompressedContext(
        facts=facts,
        candidates=candidates,
        next_relevant_context=facts[-3:],
        omitted_reason=omitted,
        original_chars=original_chars,
        compressed_chars=compressed_chars,
    )


def build_llm_context_snippet(compressed: CompressedContext, max_chars: int = 4000) -> str:
    """把 CompressedContext 拼成 LLM prompt 用的纯文本 snippet。"""
    parts: List[str] = []
    if compressed.candidates:
        parts.append("候选 flag:\n" + "\n".join(f"  - {c}" for c in compressed.candidates[:10]))
    if compressed.errors:
        parts.append("近期错误:\n" + "\n".join(f"  - {e}" for e in compressed.errors[:15]))
    if compressed.facts:
        parts.append("事实:\n" + "\n".join(f"  - {f}" for f in compressed.facts[:30]))
    if compressed.next_relevant_context:
        parts.append("最近上下文:\n" + "\n".join(f"  - {c}" for c in compressed.next_relevant_context[:5]))
    if compressed.omitted_reason:
        parts.append(f"(已省略: {compressed.omitted_reason})")
    text = "\n\n".join(parts)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n...(截断)"
    return text

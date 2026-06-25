"""
Flag Verifier — 提取并校验 CTF 候选 flag。

职责：
- 从任意文本（stdout / stderr / 文件 / 日志）中按正则提取候选 flag
- 支持常见格式：flag{} / FLAG{} / ctf{} / CTF{} / sctf{} / SCTF{} / 自定义
- 对候选给出置信度（出现次数 / 上下文 / 是否符合格式）
- 保留证据来源（文件、行号、原始片段）
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional


DEFAULT_FLAG_PATTERNS: List[str] = [
    r"flag\{[^}\s]{1,200}\}",
    r"FLAG\{[^}\s]{1,200}\}",
    r"ctf\{[^}\s]{1,200}\}",
    r"CTF\{[^}\s]{1,200}\}",
    r"sctf\{[^}\s]{1,200}\}",
    r"SCTF\{[^}\s]{1,200}\}",
    r"key\{[^}\s]{1,200}\}",
    r"KEY\{[^}\s]{1,200}\}",
]


@dataclass
class FlagCandidate:
    flag: str
    source: str  # 'stdout' / 'stderr' / filename / 'inline'
    line: Optional[int] = None
    snippet: str = ""
    confidence: float = 0.5
    matched_pattern: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "flag": self.flag,
            "source": self.source,
            "line": self.line,
            "snippet": self.snippet[:200],
            "confidence": round(self.confidence, 3),
            "matched_pattern": self.matched_pattern,
        }


@dataclass
class FlagVerifyResult:
    candidates: List[FlagCandidate] = field(default_factory=list)
    best: Optional[FlagCandidate] = None
    expected_match: Optional[bool] = None
    expected_flag: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "candidates": [c.to_dict() for c in self.candidates],
            "best": self.best.to_dict() if self.best else None,
            "candidate_count": len(self.candidates),
            "expected_match": self.expected_match,
            "expected_flag": self.expected_flag,
        }


class FlagVerifier:
    """提取 + 评估候选 flag。所有方法都是无副作用的纯函数。"""

    def __init__(self, custom_patterns: Optional[Iterable[str]] = None) -> None:
        patterns: List[str] = list(DEFAULT_FLAG_PATTERNS)
        if custom_patterns:
            patterns.extend(list(custom_patterns))
        # 去重，保留顺序
        seen, dedup = set(), []
        for p in patterns:
            if p in seen:
                continue
            seen.add(p)
            dedup.append(p)
        self.patterns = dedup
        # 预编译正则
        self._compiled: List[tuple] = []
        for p in self.patterns:
            try:
                self._compiled.append((p, re.compile(p)))
            except re.error:
                continue

    def extract_from_text(
        self,
        text: str,
        source: str = "inline",
        line_offset: int = 0,
    ) -> List[FlagCandidate]:
        """从单段文本中提取候选 flag。"""
        if not text:
            return []
        candidates: List[FlagCandidate] = []
        lines = text.splitlines()
        for idx, raw_line in enumerate(lines):
            for pat, rx in self._compiled:
                for m in rx.finditer(raw_line):
                    flag_str = m.group(0)
                    snippet = raw_line[max(0, m.start() - 30): m.end() + 30]
                    # 置信度评分：长度合理+ / 出现次数+
                    conf = 0.5
                    if 8 <= len(flag_str) <= 100:
                        conf += 0.15
                    if any(ch.isdigit() for ch in flag_str):
                        conf += 0.1
                    if any(ch in "_-" for ch in flag_str):
                        conf += 0.05
                    candidates.append(
                        FlagCandidate(
                            flag=flag_str,
                            source=source,
                            line=line_offset + idx + 1 if raw_line.strip() else None,
                            snippet=snippet,
                            confidence=min(conf, 0.99),
                            matched_pattern=pat,
                        )
                    )
        # 去重并按置信度排序
        return self._dedupe_and_rank(candidates)

    def extract_from_file(self, file_path: str, max_bytes: int = 5 * 1024 * 1024) -> List[FlagCandidate]:
        """从文件读取内容并提取。"""
        if not os.path.isfile(file_path):
            return []
        try:
            size = os.path.getsize(file_path)
            with open(file_path, "rb") as fh:
                raw = fh.read(max_bytes if size > max_bytes else size)
            try:
                text = raw.decode("utf-8", errors="ignore")
            except Exception:
                text = raw.decode("latin-1", errors="ignore")
            return self.extract_from_text(text, source=file_path)
        except Exception:
            return []

    def verify(
        self,
        *,
        stdout: str = "",
        stderr: str = "",
        files: Optional[List[str]] = None,
        expected_flag: Optional[str] = None,
        flag_format_regex: Optional[str] = None,
    ) -> FlagVerifyResult:
        """汇总提取并评估最佳候选。"""
        all_candidates: List[FlagCandidate] = []
        if stdout:
            all_candidates.extend(self.extract_from_text(stdout, source="stdout"))
        if stderr:
            all_candidates.extend(self.extract_from_text(stderr, source="stderr"))
        if files:
            for fp in files:
                all_candidates.extend(self.extract_from_file(fp))

        # 如果给了 flag_format_regex，过滤候选
        if flag_format_regex:
            try:
                rx = re.compile(flag_format_regex)
                all_candidates = [c for c in all_candidates if rx.search(c.flag)]
            except re.error:
                pass

        # 去重 + 排序
        ranked = self._dedupe_and_rank(all_candidates)
        best = ranked[0] if ranked else None

        result = FlagVerifyResult(candidates=ranked, best=best)
        if expected_flag:
            result.expected_flag = expected_flag
            result.expected_match = any(c.flag == expected_flag for c in ranked)
        return result

    @staticmethod
    def compute_hash(flag: str) -> str:
        return hashlib.sha256(flag.encode("utf-8")).hexdigest()

    @staticmethod
    def _dedupe_and_rank(candidates: List[FlagCandidate]) -> List[FlagCandidate]:
        """去重：相同 flag + 来源 聚合，置信度叠加。"""
        merged: Dict[str, FlagCandidate] = {}
        for c in candidates:
            key = c.flag
            if key in merged:
                merged[key].confidence = min(0.99, merged[key].confidence + 0.1)
            else:
                merged[key] = c
        # 按置信度倒序
        return sorted(merged.values(), key=lambda x: (-x.confidence, x.flag))


_default_verifier: Optional[FlagVerifier] = None


def get_verifier(custom_patterns: Optional[Iterable[str]] = None) -> FlagVerifier:
    global _default_verifier
    if _default_verifier is None or custom_patterns:
        _default_verifier = FlagVerifier(custom_patterns=custom_patterns)
    return _default_verifier

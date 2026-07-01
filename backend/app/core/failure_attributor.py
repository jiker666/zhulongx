"""
Failure Attributor — 失败归因器（v6 借鉴 LuaN1ao）。

输出 L1-L4 失败等级：
- L1：环境/依赖错误（缺包、路径不存在、权限不足）
- L2：脚本逻辑错误（变量名、解析错误、编码错误）
- L3：方向错误（题型判断错、算法路线错）
- L4：信息不足/需要人工（附件损坏、密码未知、远程服务不可达）

Orchestrator 的 REFLECT_ERROR 使用它，不要只把 stderr 丢给模型。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# L1 环境错误特征
_L1_PATTERNS = [
    r"ModuleNotFoundError",
    r"ImportError",
    r"No module named",
    r"FileNotFoundError",
    r"PermissionError",
    r"File exists",
    r"No such file or directory",
    r"command not found",
    r"NotADirectoryError",
    r"OSError.*\[Errno 2\]",
]

# L2 逻辑错误特征
_L2_PATTERNS = [
    r"SyntaxError",
    r"IndentationError",
    r"NameError",
    r"TypeError",
    r"ValueError",
    r"KeyError",
    r"IndexError",
    r"AttributeError",
    r"UnicodeDecodeError",
    r"UnicodeEncodeError",
    r"json\.decoder\.JSONDecodeError",
    r"StopIteration",
    r"ZeroDivisionError",
]

# L3 方向错误特征（算法/路线判断错）
_L3_PATTERNS = [
    r"AssertionError",
    r"Wrong result",
    r"incorrect flag",
    r"flag format mismatch",
    r"does not match expected",
]

# L4 信息不足特征
_L4_PATTERNS = [
    r"Connection refused",
    r"Connection timed out",
    r"Name or service not known",
    r"getaddrinfo failed",
    r"SSL.*wrong version",
    r"password.*required",
    r"decryption failed",
    r"BadZipFile",
    r"File is encrypted",
    r"unsupported.*format",
    r"cannot identify image file",
    r"captcha",
    r"require.*manual",
]


@dataclass
class FailureAttribution:
    """失败归因结果。"""
    level: str  # L1|L2|L3|L4
    root_cause: str = ""
    fix_strategy: str = ""
    need_replan: bool = False
    need_expert_model: bool = False
    minimal_patch_hint: str = ""
    matched_patterns: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "level": self.level,
            "root_cause": self.root_cause,
            "fix_strategy": self.fix_strategy,
            "need_replan": self.need_replan,
            "need_expert_model": self.need_expert_model,
            "minimal_patch_hint": self.minimal_patch_hint,
            "matched_patterns": self.matched_patterns,
        }


def _match_patterns(text: str, patterns: List[str]) -> List[str]:
    matched = []
    for p in patterns:
        if re.search(p, text, re.IGNORECASE):
            matched.append(p)
    return matched


def attribute_failure(
    *,
    script: str = "",
    stdout: str = "",
    stderr: str = "",
    facts: Optional[List[Dict[str, Any]]] = None,
    round_index: int = 0,
) -> FailureAttribution:
    """根据脚本、stdout、stderr、facts 判断失败原因。"""
    combined = f"{stderr}\n{stdout}\n{script}"
    facts = facts or []

    # L1 环境错误
    l1 = _match_patterns(combined, _L1_PATTERNS)
    if l1:
        return FailureAttribution(
            level="L1",
            root_cause=f"环境/依赖错误: {l1[0]}",
            fix_strategy="安装缺失依赖或修正文件路径",
            need_replan=False,
            need_expert_model=False,
            minimal_patch_hint=f"检查 {l1[0]} 涉及的包/路径是否可用",
            matched_patterns=l1,
        )

    # L4 信息不足（优先于 L2，因为可能两者都有但 L4 更需要人工）
    l4 = _match_patterns(combined, _L4_PATTERNS)
    if l4:
        return FailureAttribution(
            level="L4",
            root_cause=f"信息不足/需人工: {l4[0]}",
            fix_strategy="补充附件信息 / 提供密码 / 确认远程服务可达 / 人工介入",
            need_replan=False,
            need_expert_model=False,
            minimal_patch_hint="可能需要人工提供缺失信息",
            matched_patterns=l4,
        )

    # L2 逻辑错误
    l2 = _match_patterns(combined, _L2_PATTERNS)
    if l2:
        # 多次同类错误 → 需要专家模型
        same_error_count = sum(
            1 for f in facts
            if f.get("kind") == "error" and any(p in (f.get("content") or "") for p in l2)
        )
        return FailureAttribution(
            level="L2",
            root_cause=f"脚本逻辑错误: {l2[0]}",
            fix_strategy="修复语法/类型/索引/编码错误，输出最小修复点",
            need_replan=False,
            need_expert_model=same_error_count >= 2,
            minimal_patch_hint=f"定位 {l2[0]} 抛出位置，修正对应行",
            matched_patterns=l2,
        )

    # L3 方向错误
    l3 = _match_patterns(combined, _L3_PATTERNS)
    if l3:
        return FailureAttribution(
            level="L3",
            root_cause=f"解题方向错误: {l3[0]}",
            fix_strategy="重新分类题型 / 换算法路线",
            need_replan=True,
            need_expert_model=True,
            minimal_patch_hint="放弃当前路线，重新规划",
            matched_patterns=l3,
        )

    # 兜底：默认 L2
    return FailureAttribution(
        level="L2",
        root_cause="未知脚本错误（无明确异常类型）",
        fix_strategy="让 LLM 基于 stderr 末尾做最小修复",
        need_replan=False,
        need_expert_model=round_index >= 3,
        minimal_patch_hint="检查脚本逻辑与最近一次输出",
        matched_patterns=[],
    )

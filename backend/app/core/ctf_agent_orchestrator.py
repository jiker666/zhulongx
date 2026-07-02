"""
CTF Agent Orchestrator — 烛龙·玄枢 的 CTF 解题主控。

状态机：
  INIT → CLASSIFY → PLAN → ANALYZE_FILES → GENERATE_SCRIPT
       → RUN_SCRIPT → REFLECT_ERROR → VERIFY_FLAG → GENERATE_WRITEUP → DONE
                                                              ↘ FAILED

每一步：
- 调用 LLMAdapter（mock/真实自动切换）
- 调用 CtfFileAnalyzer / CodeExecutionSandbox / FlagVerifier
- 记录 EvidenceChain（步骤、输入、输出、耗时、token）
- 支持失败重试 + max_rounds 上限

安全约束：
- allow_network 默认 false；CTF 远程题必须 authorized=true 才允许联网
- 所有脚本经过 sandbox._scan_content 过滤危险模式
- 所有 LLM 输入做脱敏，避免泄露 API key
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.config import settings
from app.core.code_execution_sandbox import CodeExecutionSandbox, SandboxResult, get_sandbox
from app.core.ctf_file_analyzer import AnalysisResult, CtfFileAnalyzer, get_analyzer
from app.core.ctf_persistence import (
    append_artifact,
    append_event,
    save_task,
    save_writeup,
    upsert_flag,
)
from app.core.flag_verifier import FlagVerifier
from app.core.llm_adapter import LLMAdapter, get_adapter
from app.core.writeup_generator import WriteupGenerator
from app.core.blackboard import Blackboard, get_blackboard
from app.core.cost_accounting import CostAccounting, get_cost_accounting
from app.core.model_router import ModelRouter, get_model_router, RouteDecision
from app.core.observer import Observer, get_observer, ObserverAdvice
from app.core.failure_attributor import attribute_failure, FailureAttribution
from app.core.context_compressor import (
    compress_tool_output, compress_file_analysis, compress_evidence_chain,
    build_llm_context_snippet,
)

logger = logging.getLogger(__name__)


class CtfState(str, Enum):
    INIT = "INIT"
    CLASSIFY = "CLASSIFY"
    PLAN = "PLAN"
    ANALYZE_FILES = "ANALYZE_FILES"
    GENERATE_SCRIPT = "GENERATE_SCRIPT"
    RUN_SCRIPT = "RUN_SCRIPT"
    REFLECT_ERROR = "REFLECT_ERROR"
    VERIFY_FLAG = "VERIFY_FLAG"
    GENERATE_WRITEUP = "GENERATE_WRITEUP"
    DONE = "DONE"
    FAILED = "FAILED"
    HUMAN_REQUIRED = "HUMAN_REQUIRED"


@dataclass
class TaskPlan:
    initial_guess: str = ""
    category: str = "unknown"
    confidence: float = 0.0
    key_clues: List[str] = field(default_factory=list)
    tool_plan: List[str] = field(default_factory=list)
    script_plan: List[str] = field(default_factory=list)
    risks: List[str] = field(default_factory=list)
    fallback: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class EvidenceItem:
    step: str
    timestamp: float
    duration_ms: int = 0
    input_summary: str = ""
    output_summary: str = ""
    success: bool = True
    artifacts: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class CtfTask:
    task_id: str
    title: str
    description: str
    category_hint: str = "auto"
    flag_format: Optional[str] = None
    authorized: bool = False
    allow_network: bool = False
    max_rounds: int = 8
    attachments: List[str] = field(default_factory=list)
    state: CtfState = CtfState.INIT
    rounds_used: int = 0
    plan: Optional[TaskPlan] = None
    analysis: Optional[Dict[str, Any]] = None
    current_script: str = ""
    script_runs: List[Dict[str, Any]] = field(default_factory=list)
    evidence: List[EvidenceItem] = field(default_factory=list)
    candidate_flags: List[Dict[str, Any]] = field(default_factory=list)
    best_flag: Optional[str] = None
    writeup_md: str = ""
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    # 元数据 / 持久化辅助
    source: str = "api"  # api / demo / llm_smoke
    demo_id: Optional[str] = None
    expected_flag: Optional[str] = None  # ⚠️ benchmark only，orchestrator 永不读取
    is_running: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "title": self.title,
            "description": self.description,
            "category_hint": self.category_hint,
            "flag_format": self.flag_format,
            "authorized": self.authorized,
            "allow_network": self.allow_network,
            "max_rounds": self.max_rounds,
            "attachments": self.attachments,
            "state": self.state.value,
            "rounds_used": self.rounds_used,
            "plan": self.plan.to_dict() if self.plan else None,
            "analysis": self.analysis,
            "current_script": self.current_script,
            "script_runs": self.script_runs,
            "evidence": [e.to_dict() for e in self.evidence],
            "candidate_flags": self.candidate_flags,
            "best_flag": self.best_flag,
            "has_writeup": bool(self.writeup_md),
            "writeup_md": self.writeup_md,
            "error": self.error,
            "is_running": self.is_running,
            "source": self.source,
            "demo_id": self.demo_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


# 内存存储（演示用，生产可换 SQLite）
_TASKS: Dict[str, CtfTask] = {}


class CtfOrchestrator:
    """主控状态机。"""

    def __init__(
        self,
        *,
        llm: Optional[LLMAdapter] = None,
        analyzer: Optional[CtfFileAnalyzer] = None,
        sandbox: Optional[CodeExecutionSandbox] = None,
        verifier: Optional[FlagVerifier] = None,
        writeup: Optional[WriteupGenerator] = None,
        blackboard: Optional[Blackboard] = None,
        observer: Optional[Observer] = None,
        router: Optional[ModelRouter] = None,
        cost_accounting: Optional[CostAccounting] = None,
    ) -> None:
        self.llm = llm or get_adapter()
        self.analyzer = analyzer or get_analyzer()
        self.sandbox = sandbox or get_sandbox(allow_network=False)
        self.verifier = verifier or FlagVerifier()
        self.writeup = writeup or WriteupGenerator()
        # v6 旁路模块
        self.blackboard = blackboard or get_blackboard()
        self.observer = observer or get_observer()
        self.router = router or get_model_router()
        self.cost_accounting = cost_accounting or get_cost_accounting()
        self._last_observer_advice: Dict[str, ObserverAdvice] = {}
        self._repeated_error_counts: Dict[str, int] = {}

    # ---------- public API ----------

    def create_task(
        self,
        *,
        title: str,
        description: str,
        category_hint: str = "auto",
        flag_format: Optional[str] = None,
        authorized: bool = False,
        allow_network: bool = False,
        max_rounds: int = 8,
        source: str = "api",
        demo_id: Optional[str] = None,
        expected_flag: Optional[str] = None,
    ) -> CtfTask:
        tid = f"ctf_{uuid.uuid4().hex[:10]}"
        task = CtfTask(
            task_id=tid,
            title=title,
            description=description,
            category_hint=category_hint,
            flag_format=flag_format,
            authorized=authorized,
            allow_network=allow_network,
            max_rounds=max(min(max_rounds, 16), 1),
            source=source,
            demo_id=demo_id,
            expected_flag=expected_flag,
        )
        _TASKS[tid] = task
        # 持久化初始状态
        try:
            save_task(task.to_dict())
        except Exception as e:  # noqa: BLE001
            logger.warning("persist create_task failed: %s", e)
        return task

    def add_attachment(self, task_id: str, file_path: str) -> bool:
        task = _TASKS.get(task_id)
        if not task:
            return False
        if not os.path.isfile(file_path):
            return False
        task.attachments.append(file_path)
        task.updated_at = time.time()
        # 持久化
        try:
            save_task(task.to_dict())
        except Exception as e:  # noqa: BLE001
            logger.warning("persist add_attachment failed: %s", e)
        return True

    def get_task(self, task_id: str) -> Optional[CtfTask]:
        return _TASKS.get(task_id)

    def list_tasks(self) -> List[CtfTask]:
        return sorted(_TASKS.values(), key=lambda t: -t.created_at)

    def run(self, task_id: str, *, max_rounds: Optional[int] = None) -> CtfTask:
        """运行状态机直到 DONE / FAILED / HUMAN_REQUIRED。"""
        task = _TASKS.get(task_id)
        if not task:
            raise ValueError(f"task not found: {task_id}")

        # 安全检查：allow_network 必须配合 authorized
        if task.allow_network and not task.authorized:
            task.allow_network = False
            self._record_evidence(
                task, "scope_check",
                "allow_network=true 但 authorized=false，已强制关闭网络访问",
                success=False,
            )

        # ⚠️ 持久化 expected_flag（仅 benchmark 用），orchestrator 不读取此值
        # task.expected_flag 仅在 create_task 时由 demo 加载器写入

        rounds_cap = max_rounds or task.max_rounds
        task.is_running = True
        try:
            save_task(task.to_dict())
        except Exception as e:  # noqa: BLE001
            logger.warning("persist running=true failed: %s", e)

        try:
            while task.state not in (CtfState.DONE, CtfState.FAILED, CtfState.HUMAN_REQUIRED):
                if task.rounds_used >= rounds_cap:
                    task.state = CtfState.HUMAN_REQUIRED
                    task.error = f"达到最大轮次 {rounds_cap}，请人工接管"
                    break
                # v6: 预算检查
                if self.cost_accounting.is_budget_exceeded(task.task_id):
                    task.state = CtfState.HUMAN_REQUIRED
                    task.error = "LLM 预算超支，请人工接管"
                    self._record_evidence(task, "budget_stop", "预算超支，转入人工接管", success=False)
                    break
                # v6: Observer 旁路检查（每步前）
                self._run_observer_pre_check(task, rounds_cap)
                if task.state in (CtfState.DONE, CtfState.FAILED, CtfState.HUMAN_REQUIRED):
                    break
                task.rounds_used += 1
                self._step(task)
                task.updated_at = time.time()
                # v6: 每步后写黑板事实
                self._post_step_blackboard(task)
                # 每步同步 DB
                try:
                    save_task(task.to_dict())
                except Exception as e:  # noqa: BLE001
                    logger.warning("persist step failed: %s", e)
        except Exception as e:  # noqa: BLE001
            task.state = CtfState.FAILED
            task.error = f"orchestrator error: {type(e).__name__}: {e}"
            logger.exception("orchestrator failed for task %s", task_id)
        finally:
            task.is_running = False
            try:
                save_task(task.to_dict())
            except Exception as e:  # noqa: BLE001
                logger.warning("persist running=false failed: %s", e)
        return task

    # ---------- state machine ----------

    def _step(self, task: CtfTask) -> None:
        st = task.state
        if st == CtfState.INIT:
            self._init_task(task)
        elif st == CtfState.CLASSIFY:
            self._classify(task)
        elif st == CtfState.PLAN:
            self._plan(task)
        elif st == CtfState.ANALYZE_FILES:
            self._analyze_files(task)
        elif st == CtfState.GENERATE_SCRIPT:
            self._generate_script(task)
        elif st == CtfState.RUN_SCRIPT:
            self._run_script(task)
        elif st == CtfState.REFLECT_ERROR:
            self._reflect_error(task)
        elif st == CtfState.VERIFY_FLAG:
            self._verify_flag(task)
        elif st == CtfState.GENERATE_WRITEUP:
            self._generate_writeup(task)

    def _init_task(self, task: CtfTask) -> None:
        self._record_evidence(task, "init", f"任务初始化，授权={task.authorized}")
        task.state = CtfState.CLASSIFY

    def _classify(self, task: CtfTask) -> None:
        # 如果用户已显式指定题型，跳过分类
        if task.category_hint and task.category_hint != "auto":
            plan = TaskPlan(
                category=task.category_hint,
                confidence=0.9,
                initial_guess=f"用户指定题型: {task.category_hint}",
                tool_plan=self._default_tools_for(task.category_hint),
            )
            task.plan = plan
            self._record_evidence(
                task, "classify",
                f"跳过 LLM 分类，采用用户指定: {task.category_hint}",
                artifacts={"category": task.category_hint, "source": "user"},
            )
            task.state = CtfState.PLAN
            return

        # 调用 LLM 分类
        prompt = (
            f"题目: {task.title}\n"
            f"题面: {task.description[:500]}\n"
            f"附件数: {len(task.attachments)}\n"
            f"flag_format: {task.flag_format or '未指定'}\n"
            "请判断这道 CTF 题的题型（web/crypto/reverse/pwn/misc/forensics），"
            "并以 JSON 输出: {category, confidence, reason, suggested_tools}"
        )
        sys = (
            "你是 CTF 题型分类专家。只输出 JSON，包含字段："
            "category (web|crypto|reverse|pwn|misc|forensics), "
            "confidence (0-1), reason (简短中文), suggested_tools (数组)."
        )
        # mock/disabled 模式下，LLM 分类不可靠（mock 会因 prompt 含所有题型名而误判），
        # 直接用关键词识别，效果更好且 0 成本
        is_mock = bool(getattr(self.llm, "mock_mode", False)) or not getattr(self.llm, "enabled", True)
        if is_mock:
            cat = self._guess_category_from_description(task)
            plan = TaskPlan(
                category=cat,
                confidence=0.7,
                initial_guess=f"关键词识别题型: {cat}（mock 模式，未调 LLM）",
                tool_plan=self._default_tools_for(cat),
            )
            self._record_evidence(
                task, "classify",
                f"题型分类: {cat}（关键词识别，mock 模式）",
                artifacts=plan.to_dict(),
            )
            task.plan = plan
            task.state = CtfState.PLAN
            return
        ok, data, resp = self.llm.chat_json(
            [{"role": "user", "content": prompt}],
            system_prompt=sys,
            max_tokens=400,
        )
        # v6: 记录分类成本（mock 模式 0 成本）
        self._record_llm_cost_simple(task, "classify", prompt, resp)
        if not ok or not data:
            # 兜底 1: 有附件 → 按附件类型猜
            if task.attachments:
                cat = self._guess_category_from_attachments(task.attachments)
                source = "附件特征"
            else:
                # 兜底 2: 无附件 → 按题面关键词猜（让模型能自己识别题型）
                cat = self._guess_category_from_description(task)
                source = "题面关键词"
            plan = TaskPlan(
                category=cat,
                confidence=0.4,
                initial_guess=f"LLM 分类失败({resp.error or 'parse_error'})，按{source}猜测",
                tool_plan=self._default_tools_for(cat),
            )
        else:
            cat = str(data.get("category", "misc")).lower()
            if cat not in ("web", "crypto", "reverse", "pwn", "misc", "forensics"):
                cat = "misc"
            plan = TaskPlan(
                category=cat,
                confidence=float(data.get("confidence", 0.5)),
                initial_guess=str(data.get("reason", "")),
                tool_plan=list(data.get("suggested_tools", self._default_tools_for(cat))),
            )
        task.plan = plan
        self._record_evidence(
            task, "classify",
            f"题型分类: {plan.category} (置信度 {plan.confidence:.2f})",
            artifacts=plan.to_dict(),
            success=resp.success,
        )
        task.state = CtfState.PLAN

    def _plan(self, task: CtfTask) -> None:
        if not task.plan:
            task.plan = TaskPlan(category="misc")
        # 调 LLM 生成计划
        prompt = (
            f"题型: {task.plan.category}\n"
            f"题面: {task.description[:500]}\n"
            f"附件: {[os.path.basename(a) for a in task.attachments]}\n"
            "请生成解题计划，JSON 输出: {plan:[步骤], risks:[风险], fallback:'备用思路'}"
        )
        ok, data, resp = self.llm.chat_json(
            [{"role": "user", "content": prompt}],
            system_prompt="你是 CTF 解题策略师。只输出 JSON。",
            max_tokens=400,
        )
        # v6: 记录计划成本
        self._record_llm_cost_simple(task, "plan", prompt, resp)
        if ok and data:
            task.plan.script_plan = list(data.get("plan", []))
            task.plan.risks = list(data.get("risks", []))
            task.plan.fallback = str(data.get("fallback", ""))
        else:
            task.plan.script_plan = self._default_plan_for(task.plan.category)
            task.plan.risks = ["LLM 失败，采用默认计划"]
        self._record_evidence(
            task, "plan",
            f"生成计划 {len(task.plan.script_plan)} 步",
            artifacts={"script_plan": task.plan.script_plan, "risks": task.plan.risks},
            success=resp.success,
        )
        task.state = CtfState.ANALYZE_FILES

    def _analyze_files(self, task: CtfTask) -> None:
        if not task.attachments:
            self._record_evidence(task, "analyze_files", "无附件，跳过文件分析")
            task.analysis = {"summary": {"file_count": 0}}
            task.state = CtfState.GENERATE_SCRIPT
            return
        try:
            analyses: List[AnalysisResult] = []
            summary: Dict[str, Any] = {"files": [], "summary": {}}
            for fp in task.attachments:
                ar = self.analyzer.analyze(fp, flag_format=task.flag_format)
                analyses.append(ar)
                for f in ar.files:
                    summary["files"].append(f.to_dict())
                # 合并 flag 候选
                if ar.summary.get("has_flag_candidate"):
                    for f in ar.files:
                        for fl in f.flags_found:
                            task.candidate_flags.append({
                                "flag": fl,
                                "source": f.relative_path,
                                "confidence": 0.7,
                            })
            task.analysis = summary
            # v6: 写文件 fact 到黑板
            self._write_file_facts_to_blackboard(task, summary)
            self._record_evidence(
                task, "analyze_files",
                f"分析 {len(task.attachments)} 个附件，发现 {len(task.candidate_flags)} 个候选 flag",
                artifacts=summary,
            )
        except Exception as e:  # noqa: BLE001
            self._record_evidence(
                task, "analyze_files",
                f"文件分析失败: {type(e).__name__}: {e}",
                success=False,
            )
            task.analysis = {"error": str(e)}
        task.state = CtfState.GENERATE_SCRIPT

    def _write_file_facts_to_blackboard(self, task: CtfTask, summary: Dict[str, Any]) -> None:
        """把文件分析结果写入黑板 fact（失败容错）。"""
        try:
            for f in (summary.get("files") or [])[:10]:
                content = f"file={f.get('relative_path')} type={f.get('type')} size={f.get('size')}"
                self.blackboard.add_fact(
                    task_id=task.task_id, kind="file",
                    content=content, confidence=0.7,
                    source_step="analyze_files",
                )
                # 可疑 strings
                for s in (f.get("suspicious_strings") or [])[:5]:
                    self.blackboard.add_fact(
                        task_id=task.task_id, kind="clue",
                        content=f"suspicious: {s}", confidence=0.6,
                        source_step="analyze_files",
                    )
            # 候选 flag 写 candidate fact
            for c in task.candidate_flags:
                self.blackboard.add_fact(
                    task_id=task.task_id, kind="candidate",
                    content=c["flag"], confidence=c.get("confidence", 0.7),
                    source_step="analyze_files",
                    evidence_ref=c.get("source"),
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("write file facts to blackboard failed: %s", e)

    def _generate_script(self, task: CtfTask) -> None:
        # 构造 prompt — v6.4: 包含富文本内容预览
        file_clues = ""
        if task.analysis:
            files = task.analysis.get("files", [])[:8]
            for f in files:
                # v6.4: 用 basename 作为文件名，LLM 脚本直接 open(basename) 即可
                basename = os.path.basename(f.get('relative_path', ''))
                file_clues += (
                    f"\n=== {basename} ===\n"
                    f"类型: {f.get('type','')} | 大小: {f.get('size',0)}B | MIME: {f.get('mime','')}\n"
                )
                # 可疑字符串
                if f.get("suspicious_strings"):
                    file_clues += f"可疑字符串: {f['suspicious_strings'][:5]}\n"
                # 已发现 flag
                if f.get("flags_found"):
                    file_clues += f"已发现 flag 候选: {f['flags_found'][:5]}\n"
                # ELF 信息
                elf = f.get("elf_info") or {}
                if elf:
                    for k, v in elf.items():
                        file_clues += f"[{k}] {str(v)[:200]}\n"
                # binwalk 签名
                if f.get("binwalk_signatures"):
                    file_clues += f"binwalk: {f['binwalk_signatures'][:5]}\n"
                # binwalk 提取的子文件
                if f.get("extracted_files"):
                    file_clues += f"binwalk 提取: {f['extracted_files'][:10]}\n"
                # v6.4: 内容预览（关键！LLM 据此理解文件内容）
                preview = f.get("content_preview", "")
                if preview:
                    # 截断到合理长度（避免超长 prompt）
                    max_preview = 2000
                    if len(preview) > max_preview:
                        file_clues += f"\n--- 内容预览 (截断到 {max_preview} 字符) ---\n{preview[:max_preview]}\n--- 预览结束 ---\n"
                    else:
                        file_clues += f"\n--- 内容预览 ---\n{preview}\n--- 预览结束 ---\n"
                else:
                    file_clues += "（无内容预览）\n"
                # exif 信息
                if f.get("exif"):
                    important_keys = ["Comment", "Artist", "Copyright", "Image Width", "Image Height",
                                      "X Resolution", "Y Resolution", "Bit Depth", "Color Type",
                                      "Modify Date", "Create Date", "File Size"]
                    exif_strs = []
                    for k, v in f["exif"].items():
                        if k in important_keys or "flag" in v.lower() or "ctf" in v.lower():
                            exif_strs.append(f"{k}: {v}")
                    if exif_strs:
                        file_clues += f"EXIF: {exif_strs[:10]}\n"

        # v6: 静态命中 → 不调 LLM
        if task.candidate_flags and any(c.get("confidence", 0) >= 0.7 for c in task.candidate_flags):
            self.cost_accounting.record_static_only(
                task_id=task.task_id, step="generate_script",
                reason="static_candidate_high_confidence",
            )
            # 用兜底脚本提取
            task.current_script = self._fallback_script(task)
            self._record_evidence(
                task, "generate_script",
                f"静态分析已发现高置信候选 flag {len(task.candidate_flags)} 个，跳过 LLM",
                artifacts={"static_only": True},
            )
            task.state = CtfState.RUN_SCRIPT
            return

        # v6: 查 ModelRouter 决定 max_tokens
        route = self._route_decision(task, "generate_script")
        if route.lane == "stop":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = "预算耗尽，转入人工接管"
            return

        prompt = (
            f"题型: {task.plan.category if task.plan else 'unknown'}\n"
            f"题面: {task.description[:800]}\n"
            f"附件分析:\n{file_clues}\n"
            "请生成一个 Python 解题脚本 solve.py，要求：\n"
            "1. 自包含，优先读取同目录下的附件文件来分析\n"
            "2. 附件文件就在当前工作目录（与 solve.py 同级），直接用 open('文件名','rb') 读取即可\n"
            "3. 用 print() 输出最终结果\n"
            "4. 如果找到 flag，print 单独一行 flag{...} 或对应格式\n"
            "5. 只输出脚本代码，不要 markdown 围栏\n"
            "6. 根据附件内容预览中的线索，选择正确的分析方法\n"
        )
        sys = (
            "你是 CTF 解题脚本专家。输出纯 Python 代码，不要解释，不要 markdown 围栏。"
            "脚本必须能直接 python3 solve.py 运行。"
            "重要：附件文件在当前工作目录中（与 solve.py 同级），直接用 open('filename','rb') 读取即可，"
            "不要用 input/ 前缀或子目录路径。"
            "根据附件分析信息，选择最有可能的方法："
            "如果是加密题，根据密文特征选择解密算法；"
            "如果是隐写题，检查图片 LSB/EXIF/文件尾；"
            "如果是流量包，用 scapy 或手动解析提取关键数据；"
            "如果是二进制逆向，根据 ELF 信息分析关键函数。"
        )
        messages = [{"role": "user", "content": prompt}]
        resp = self.llm.chat(
            messages,
            system_prompt=sys,
            max_tokens=route.max_tokens,
            temperature=route.temperature,
        )
        self._record_llm_cost(task, "generate_script", resp, route, messages)
        if not resp.success or not resp.content:
            # 兜底脚本
            script = self._fallback_script(task)
            task.current_script = script
            self._record_evidence(
                task, "generate_script",
                f"LLM 失败({resp.error})，使用兜底脚本",
                success=False,
            )
        else:
            # 清洗：去掉 markdown 围栏
            content = resp.content.strip()
            if content.startswith("```"):
                lines = content.splitlines()
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                content = "\n".join(lines)
            task.current_script = content
            self._record_evidence(
                task, "generate_script",
                f"LLM 生成脚本 {len(content)} 字符 (lane={route.lane}, model={route.model})",
                artifacts={"script_lines": len(content.splitlines()), "route": route.to_dict()},
                success=resp.success,
            )
        task.state = CtfState.RUN_SCRIPT

    def _run_script(self, task: CtfTask) -> None:
        if not task.current_script:
            task.state = CtfState.GENERATE_SCRIPT
            return
        try:
            ws = self.sandbox.create_workspace(prefix=f"{task.task_id}_")
            # 把附件也拷到 ws（方便脚本读取）
            # ⚠️ 反作弊：禁止拷贝 expected_flag.txt
            for a in task.attachments:
                base = os.path.basename(a)
                if base == "expected_flag.txt":
                    continue
                try:
                    import shutil
                    dst = os.path.join(ws, base)
                    shutil.copy2(a, dst)
                except Exception:
                    pass
            script_path = self.sandbox.write_script(ws, "solve.py", task.current_script)
            res: SandboxResult = self.sandbox.run_python(script_path, workdir=ws, timeout=settings.CTF_SANDBOX_TIMEOUT)
            run_record = res.to_dict()
            run_index = len(task.script_runs)
            run_record["run_index"] = run_index
            task.script_runs.append(run_record)
            # 持久化 artifact
            try:
                append_artifact(task.task_id, run_index, run_record)
            except Exception as e:  # noqa: BLE001
                logger.warning("persist artifact failed: %s", e)
            self._record_evidence(
                task, "run_script",
                f"exit_code={res.exit_code} stdout={len(res.stdout)}B stderr={len(res.stderr)}B",
                artifacts=run_record,
                success=res.success,
            )
            if res.success:
                task.state = CtfState.VERIFY_FLAG
            else:
                task.state = CtfState.REFLECT_ERROR
        except ValueError as e:
            # 危险脚本
            self._record_evidence(
                task, "run_script",
                f"脚本被沙箱拒绝: {e}",
                success=False,
            )
            task.error = str(e)
            task.state = CtfState.FAILED
        except Exception as e:  # noqa: BLE001
            self._record_evidence(
                task, "run_script",
                f"执行失败: {type(e).__name__}: {e}",
                success=False,
            )
            task.state = CtfState.REFLECT_ERROR

    def _reflect_error(self, task: CtfTask) -> None:
        if not task.script_runs:
            task.state = CtfState.GENERATE_SCRIPT
            return
        last = task.script_runs[-1]
        stderr = (last.get("stderr") or "")[:800]
        stdout = (last.get("stdout") or "")[:400]

        # v6: 先用 failure_attributor 做失败归因
        error_facts = [
            {"kind": "error", "content": f.content}
            for f in self.blackboard.list_facts(task.task_id, kind="error", limit=20)
        ]
        attribution = attribute_failure(
            script=task.current_script,
            stdout=stdout, stderr=stderr,
            facts=error_facts,
            round_index=task.rounds_used,
        )
        # 累计同类错误次数
        sig_key = attribution.root_cause[:50]
        if "ValueError" in stderr or "Error" in stderr:
            self._repeated_error_counts[task.task_id] = self._repeated_error_counts.get(task.task_id, 0) + 1
        # 写归因 fact 到黑板
        try:
            self.blackboard.add_fact(
                task_id=task.task_id, kind="error",
                content=f"[{attribution.level}] {attribution.root_cause}",
                confidence=0.7, source_step="reflect_error",
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("write attribution fact failed: %s", e)

        # v6: L4 → 直接人工接管，不浪费 token
        if attribution.level == "L4":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = f"失败归因 L4: {attribution.root_cause}，需人工介入"
            self._record_evidence(
                task, "reflect_error",
                f"L4 归因: {attribution.root_cause}，停止重试",
                artifacts=attribution.to_dict(),
                success=False,
            )
            return

        # v6: 查路由，归因建议升级 expert 时传入 force_expert
        route = self._route_decision(task, "reflect_error")
        if attribution.need_expert_model:
            route = self.router.decide(
                task_id=task.task_id, step="reflect_error",
                force_expert=True,
            )
        if route.lane == "stop":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = "预算耗尽，转入人工接管"
            return

        # v6: 压缩 stderr 给 LLM（只传尾部 + 关键异常）
        compressed_stderr = compress_tool_output(stderr, max_chars=1000)
        stderr_snippet = "\n".join(compressed_stderr.facts[:20]) or stderr[:500]

        prompt = (
            f"上次执行失败（归因 {attribution.level}）：\n"
            f"失败原因: {attribution.root_cause}\n"
            f"修复策略: {attribution.fix_strategy}\n"
            f"最小修复点: {attribution.minimal_patch_hint}\n"
            f"stderr:\n{stderr_snippet}\n"
            f"stdout:\n{stdout[:200]}\n"
            f"当前脚本:\n{task.current_script[:1200]}\n"
            "请修复脚本中的错误，输出修正后的完整脚本（纯 Python，不要 markdown 围栏）。"
        )
        messages = [{"role": "user", "content": prompt}]
        resp = self.llm.chat(
            messages,
            system_prompt="你是 Python 调试专家。修复错误，只输出完整修复后的代码。",
            max_tokens=route.max_tokens,
            temperature=route.temperature,
        )
        self._record_llm_cost(task, "reflect_error", resp, route, messages)
        if resp.success and resp.content:
            content = resp.content.strip()
            if content.startswith("```"):
                lines = content.splitlines()
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                content = "\n".join(lines)
            task.current_script = content
            self._record_evidence(
                task, "reflect_error",
                f"LLM 修复脚本 (lane={route.lane}, level={attribution.level})",
                artifacts={"attribution": attribution.to_dict(), "route": route.to_dict()},
                success=True,
            )
            task.state = CtfState.RUN_SCRIPT
        else:
            self._record_evidence(
                task, "reflect_error",
                f"LLM 修复失败: {resp.error}",
                artifacts={"attribution": attribution.to_dict()},
                success=False,
            )
            task.state = CtfState.VERIFY_FLAG  # 还是尝试验证已有候选

    def _verify_flag(self, task: CtfTask) -> None:
        # 从最近的 script_runs stdout 里提 flag
        files_to_check: List[str] = []
        stdout_text = ""
        stderr_text = ""
        for r in reversed(task.script_runs):
            stdout_text = (r.get("stdout") or "")
            stderr_text = (r.get("stderr") or "")
            if stdout_text:
                break
        # 从附件里也再过一遍（但排除 expected_flag.txt 反作弊）
        safe_attachments = [a for a in task.attachments if os.path.basename(a) != "expected_flag.txt"]
        verify = self.verifier.verify(
            stdout=stdout_text,
            stderr=stderr_text,
            files=safe_attachments,
            expected_flag=None,  # 永远不传 expected_flag，避免影响 best_flag 选择
            flag_format_regex=task.flag_format,
        )
        # 合并到 task.candidate_flags
        existing = {c["flag"] for c in task.candidate_flags}
        for c in verify.candidates:
            if c.flag not in existing:
                cd = c.to_dict()
                task.candidate_flags.append(cd)
                existing.add(c.flag)
                # 持久化 flag
                try:
                    upsert_flag(task.task_id, cd)
                except Exception as e:  # noqa: BLE001
                    logger.warning("persist flag failed: %s", e)
                # v6: 写 candidate fact 到黑板
                try:
                    self.blackboard.add_fact(
                        task_id=task.task_id, kind="candidate",
                        content=c.flag, confidence=c.confidence,
                        source_step="verify_flag",
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("write candidate fact failed: %s", e)
        # 排序选 best
        task.candidate_flags.sort(key=lambda c: -c.get("confidence", 0.5))
        task.best_flag = task.candidate_flags[0]["flag"] if task.candidate_flags else None
        self._record_evidence(
            task, "verify_flag",
            f"提取到 {len(task.candidate_flags)} 个候选 flag，best={task.best_flag}",
            artifacts={"best_flag": task.best_flag, "candidates": task.candidate_flags[:5]},
            success=bool(task.best_flag),
        )
        if task.best_flag:
            task.state = CtfState.GENERATE_WRITEUP
        else:
            # 没找到 flag，看是否还有重试机会
            if task.rounds_used < task.max_rounds and task.plan and task.plan.fallback:
                task.state = CtfState.GENERATE_SCRIPT
            else:
                task.state = CtfState.GENERATE_WRITEUP

    def _generate_writeup(self, task: CtfTask) -> None:
        try:
            md = self.writeup.generate(task)
            task.writeup_md = md
            # 持久化 writeup
            try:
                save_writeup(task.task_id, md)
            except Exception as e:  # noqa: BLE001
                logger.warning("persist writeup failed: %s", e)
            self._record_evidence(
                task, "generate_writeup",
                f"生成 WP {len(md)} 字符",
                artifacts={"length": len(md)},
            )
        except Exception as e:  # noqa: BLE001
            self._record_evidence(
                task, "generate_writeup",
                f"WP 生成失败: {e}",
                success=False,
            )
        if task.best_flag:
            task.state = CtfState.DONE
        else:
            task.state = CtfState.HUMAN_REQUIRED
            task.error = "未能自动确定 flag，请人工接管"

    # ---------- v6 helpers ----------

    def _run_observer_pre_check(self, task: CtfTask, rounds_cap: int) -> None:
        """每步前让 Observer 旁路检查，决定是否提前停止/重规划。"""
        try:
            advice = self.observer.observe(
                task_id=task.task_id,
                rounds_used=task.rounds_used,
                max_rounds=rounds_cap,
                script_runs=task.script_runs,
                current_script=task.current_script,
                candidate_flags=task.candidate_flags,
                state=task.state.value,
            )
            self._last_observer_advice[task.task_id] = advice
            # 写 Observer 建议到黑板 hint
            if advice.advice and advice.advice != "状态正常，继续推进":
                self.blackboard.add_hint(
                    task_id=task.task_id,
                    content=advice.advice,
                    source="observer",
                )
            # should_stop → HUMAN_REQUIRED
            if advice.should_stop and not task.candidate_flags:
                task.state = CtfState.HUMAN_REQUIRED
                task.error = f"Observer 建议停止: {advice.advice}"
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("observer pre-check failed: %s", e)

    def _post_step_blackboard(self, task: CtfTask) -> None:
        """每步后把关键产出写入黑板事实。失败容错，不影响主流程。"""
        try:
            # 已经在 _analyze_files / _verify_flag / _run_script 中写了，
            # 这里只做兜底：记录最近 evidence 摘要
            if task.evidence:
                last = task.evidence[-1]
                # 仅记录失败的 evidence 作为 error fact（去重）
                if not last.success and last.step not in ("init", "scope_check"):
                    existing = {f.content for f in self.blackboard.list_facts(task.task_id, kind="error", limit=50)}
                    sig = (last.output_summary or last.input_summary or "")[:200]
                    if sig and sig not in existing:
                        self.blackboard.add_fact(
                            task_id=task.task_id,
                            kind="error",
                            content=sig,
                            confidence=0.6,
                            source_step=last.step,
                        )
        except Exception as e:  # noqa: BLE001
            logger.warning("post_step_blackboard failed: %s", e)

    def _route_decision(self, task: CtfTask, step: str) -> RouteDecision:
        """查询 ModelRouter 决定本轮 step 的 lane。"""
        repeated = self._repeated_error_counts.get(task.task_id, 0)
        analysis_chars = len(str(task.analysis or "")) if task.analysis else 0
        return self.router.decide(
            task_id=task.task_id,
            step=step,
            rounds_used=task.rounds_used,
            max_rounds=task.max_rounds,
            candidate_flags=task.candidate_flags,
            repeated_error_count=repeated,
            analysis_summary_chars=analysis_chars,
            observer_loop_detected=self._last_observer_advice.get(task.task_id) is not None
                and self._last_observer_advice[task.task_id].loop_detected,
        )

    def _record_llm_cost(
        self,
        task: CtfTask,
        step: str,
        resp,
        route: RouteDecision,
        messages: List[Dict[str, str]],
    ) -> None:
        """记录一次 LLM 调用的成本（mock 模式下成本为 0）。"""
        try:
            # mock 模式：用 model="mock" 记录（0 成本）
            model = route.model
            provider = route.provider
            if getattr(self.llm, "mock_mode", False):
                model = "mock"
                provider = "mock"
            self.cost_accounting.record(
                task_id=task.task_id,
                step=step,
                provider=provider,
                model=model,
                input_text=" ".join(m.get("content", "") for m in messages),
                output_text=getattr(resp, "content", "") or "",
                success=getattr(resp, "success", True),
                route_reason=route.reason,
                messages=messages,
                use_cache=True,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("record llm cost failed: %s", e)

    def _record_llm_cost_simple(
        self,
        task: CtfTask,
        step: str,
        prompt: str,
        resp,
    ) -> None:
        """简化的成本记录（用于 classify / plan 等直接调用）。mock 模式 0 成本。"""
        try:
            model = self.llm.model
            provider = self.llm.provider
            if getattr(self.llm, "mock_mode", False):
                model = "mock"
                provider = "mock"
            self.cost_accounting.record(
                task_id=task.task_id, step=step,
                provider=provider, model=model,
                input_text=prompt,
                output_text=str(getattr(resp, "content", "") or "")[:200],
                success=getattr(resp, "success", True),
                route_reason="cheap_default",
                messages=[{"role": "user", "content": prompt}],
                use_cache=True,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("record llm cost simple failed: %s", e)

    def get_last_observer_advice(self, task_id: str) -> Optional[ObserverAdvice]:
        """供 API / 前端查询最近一次 Observer 建议。"""
        return self._last_observer_advice.get(task_id)

    # ---------- helpers ----------

    def _record_evidence(
        self,
        task: CtfTask,
        step: str,
        summary: str,
        *,
        artifacts: Optional[Dict[str, Any]] = None,
        success: bool = True,
    ) -> None:
        item = EvidenceItem(
            step=step,
            timestamp=time.time(),
            duration_ms=0,
            input_summary=summary[:200],
            output_summary=summary[:200],
            success=success,
            artifacts=artifacts or {},
        )
        task.evidence.append(item)
        # 持久化事件
        try:
            append_event(task.task_id, item.to_dict())
        except Exception as e:  # noqa: BLE001
            logger.warning("persist event failed: %s", e)

    def _default_tools_for(self, category: str) -> List[str]:
        m = {
            "web": ["http_fingerprint", "directory_probe", "js_interface_extractor"],
            "crypto": ["strings", "python_solver", "sage"],
            "reverse": ["file", "strings", "readelf", "objdump", "ghidra_headless"],
            "pwn": ["checksec", "readelf", "objdump", "pwntools"],
            "misc": ["file", "strings", "binwalk", "exiftool"],
            "forensics": ["tshark", "volatility", "strings", "binwalk"],
        }
        return m.get(category, ["file", "strings", "binwalk"])

    def _default_plan_for(self, category: str) -> List[str]:
        m = {
            "web": ["1. 指纹识别", "2. 目录扫描", "3. JS 接口提取", "4. 漏洞利用"],
            "crypto": ["1. 分析密文特征", "2. 尝试常见算法", "3. 编写解题脚本"],
            "reverse": ["1. file + checksec", "2. strings 提取", "3. 反汇编关键函数", "4. 还原算法"],
            "pwn": ["1. checksec", "2. 找溢出点", "3. 构造 payload", "4. getshell"],
            "misc": ["1. file/strings", "2. binwalk 嵌入检查", "3. exiftool 元数据", "4. 编码识别"],
            "forensics": ["1. 文件类型识别", "2. 关键字提取", "3. 流量还原"],
        }
        return m.get(category, ["1. 静态分析", "2. 提取线索", "3. 编写脚本"])

    def _guess_category_from_attachments(self, attachments: List[str]) -> str:
        for a in attachments:
            lower = a.lower()
            if lower.endswith((".pcap", ".pcapng", ".cap")):
                return "forensics"
            if lower.endswith((".png", ".jpg", ".jpeg", ".gif", ".bmp")):
                return "misc"
            if lower.endswith(".py"):
                return "reverse"
            if lower.endswith((".elf", ".bin")) or ".so" in lower:
                return "reverse"
            if lower.endswith((".zip", ".tar", ".gz", ".7z")):
                return "misc"
        return "misc"

    # 题面关键词 → 题型映射（无 LLM / 无附件时的兜底识别）
    _CATEGORY_KEYWORDS: Dict[str, List[str]] = {
        "web": [
            "web", "网站", "网页", "url", "http", "https", "登录", "注入", "sql",
            "xss", "csrf", "ssrf", "session", "cookie", "token", "jwt", "api",
            "后台", "admin", "上传", "越权", "idoc", "目录扫描", "爆破",
        ],
        "crypto": [
            "crypto", "加密", "解密", "密码学", "cipher", "rsa", "aes", "des",
            "异或", "xor", "base64", "base32", "hex", "哈希", "hash", "md5",
            "sha", "椭圆曲线", "ecc", "离散对数", "lfsr", "分组密码", "流密码",
        ],
        "reverse": [
            "reverse", "逆向", "反汇编", "反编译", "elf", "pe", "可执行",
            "二进制", "ghidra", "ida", "汇编", "asm", "objdump", "upx",
            "脱壳", "加壳", "混淆", "ollvm", "算法还原",
        ],
        "pwn": [
            "pwn", "溢出", "栈溢出", "堆溢出", "格式化字符串", "format string",
            "shellcode", "rop", "ret2", "canary", "nx", "aslr", "pie",
            "checksec", "getshell", "one_gadget", "uaf", "use-after-free",
        ],
        "forensics": [
            "forensic", "取证", "流量", "pcap", "wireshark", "tshark",
            "内存", "memdump", "volatility", "磁盘", "镜像", "恢复",
            "还原", "抓包", "网络包", "stego", "隐写",
        ],
        "misc": [
            "misc", "杂项", "steg", "隐写", "图片", "png", "jpg", "jpeg",
            "exif", "元数据", "二维码", "qrcode", "barcode", "编码",
            "brainfuck", "esolang", "二维码", " LSB", "频域", "音频",
        ],
    }

    def _guess_category_from_description(self, task: "CtfTask") -> str:
        """无 LLM 且无附件时，按题面关键词识别题型。"""
        # 合并标题 + 描述 + flag_format 作为关键词源
        text = (
            (task.title or "") + " " + (task.description or "") + " " + (task.flag_format or "")
        ).lower()
        if not text.strip():
            return "misc"
        scores: Dict[str, int] = {}
        for cat, keywords in self._CATEGORY_KEYWORDS.items():
            score = 0
            for kw in keywords:
                if kw.lower() in text:
                    score += 1
            if score > 0:
                scores[cat] = score
        if not scores:
            return "misc"
        # 取命中关键词最多的题型
        best = max(scores.items(), key=lambda x: x[1])
        return best[0]

    def _fallback_script(self, task: CtfTask) -> str:
        """LLM 失败时的兜底脚本：尝试从附件 strings 里搜 flag。"""
        return (
            "# auto-generated fallback solver\n"
            "import os, re, sys\n"
            "patterns = [\n"
            "    r'flag\\{[^}]+\\}', r'FLAG\\{[^}]+\\}', r'ctf\\{[^}]+\\}',\n"
            "    r'sctf\\{[^}]+\\}', r'SCTF\\{[^}]+\\}', r'key\\{[^}]+\\}',\n"
            "]\n"
            "found = set()\n"
            "for fname in os.listdir('.'):\n"
            "    if not os.path.isfile(fname):\n"
            "        continue\n"
            "    try:\n"
            "        with open(fname, 'rb') as f:\n"
            "            raw = f.read(2*1024*1024)\n"
            "        text = raw.decode('latin-1', errors='ignore')\n"
            "        for p in patterns:\n"
            "            for m in re.finditer(p, text):\n"
            "                found.add(m.group(0))\n"
            "    except Exception:\n"
            "        pass\n"
            "if found:\n"
            "    print('found:')\n"
            "    for f in sorted(found):\n"
            "        print(f)\n"
            "else:\n"
            "    print('no flag found in current directory')\n"
        )


_orchestrator: Optional[CtfOrchestrator] = None


def get_orchestrator() -> CtfOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = CtfOrchestrator()
    return _orchestrator

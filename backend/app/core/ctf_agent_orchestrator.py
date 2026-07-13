"""
CTF Agent Orchestrator — 烛龙·玄枢 的 CTF 解题主控。

v7 状态机：
  INIT → CLASSIFY → PLAN → ANALYZE_FILES → AGENT_THINK ↔ (RUN_SHELL | RUN_SCRIPT)
       → VERIFY_FLAG → GENERATE_WRITEUP → DONE
                              ↘ FAILED / HUMAN_REQUIRED

v7 核心改进：
- Agent Think 循环：LLM 自主决定执行 shell 命令或 Python 脚本
- 无限轮数：max_rounds=0，仅受 max_time_sec 限制
- Shell 工具：agent 可调用 file/strings/binwalk/pyinstxtractor 等
- 迭代反馈：每步输出反馈给 LLM 继续思考

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
import shutil
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
from app.core.llm_adapter import LLMAdapter, get_adapter, get_route_adapter
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
from app.core.ws_manager import emit_agent_live
from app.core.agent_runtime import AgentRuntime
from app.core.cc_bridge_runtime import CcBridgeRuntime
from app.core.tool_protocol import ToolSpec

logger = logging.getLogger(__name__)


class CtfState(str, Enum):
    INIT = "INIT"
    CLASSIFY = "CLASSIFY"
    PLAN = "PLAN"
    ANALYZE_FILES = "ANALYZE_FILES"
    AGENT_THINK = "AGENT_THINK"       # v7: LLM 思考下一步
    RUN_SHELL = "RUN_SHELL"           # v7: 执行 shell 命令
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
    max_rounds: int = 0          # v7: 0=无限(仅受 max_time_sec 限制)
    max_time_sec: int = 600      # v7: 最大运行时间(秒), 默认10分钟
    attachments: List[str] = field(default_factory=list)
    state: CtfState = CtfState.INIT
    rounds_used: int = 0
    plan: Optional[TaskPlan] = None
    analysis: Optional[Dict[str, Any]] = None
    current_script: str = ""
    script_runs: List[Dict[str, Any]] = field(default_factory=list)
    shell_history: List[Dict[str, Any]] = field(default_factory=list)  # v7
    evidence: List[EvidenceItem] = field(default_factory=list)
    candidate_flags: List[Dict[str, Any]] = field(default_factory=list)
    best_flag: Optional[str] = None
    writeup_md: str = ""
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None  # v7
    source: str = "api"
    demo_id: Optional[str] = None
    expected_flag: Optional[str] = None
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
            "max_time_sec": self.max_time_sec,
            "attachments": self.attachments,
            "state": self.state.value,
            "rounds_used": self.rounds_used,
            "plan": self.plan.to_dict() if self.plan else None,
            "analysis": self.analysis,
            "current_script": self.current_script,
            "script_runs": self.script_runs,
            "shell_history": self.shell_history,
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
            "started_at": self.started_at,
        }


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
        self.blackboard = blackboard or get_blackboard()
        self.observer = observer or get_observer()
        self.router = router or get_model_router()
        self.cost_accounting = cost_accounting or get_cost_accounting()
        self._last_observer_advice: Dict[str, ObserverAdvice] = {}
        self._repeated_error_counts: Dict[str, int] = {}
        self._hypotheses: Dict[str, List[Dict[str, Any]]] = {}  # v8: hypothesis ledger
        self._no_flag_continue_streak: Dict[str, int] = {}  # v8: track no-flag continue
        self._last_route_models: Dict[str, str] = {}  # v8: track last used model per task

    # ---------- v8 helpers: hypothesis, expand_context, replan ----------

    # Tool capability cache (per-process)
    _tool_capabilities_cache: Dict[str, List[str]] = {}
    _tool_capabilities_checked: bool = False

    @classmethod
    def _get_tool_capabilities_cached(cls) -> Dict[str, List[str]]:
        """检查可用工具（只跑一次）。"""
        if cls._tool_capabilities_checked:
            return cls._tool_capabilities_cache
        cls._tool_capabilities_cache = cls._check_tool_capabilities()
        cls._tool_capabilities_checked = True
        return cls._tool_capabilities_cache

    @staticmethod
    def _check_tool_capabilities() -> Dict[str, List[str]]:
        """检测当前环境可用的 CTF 工具。"""
        import shutil
        caps: Dict[str, List[str]] = {}
        checks = {
            "basic": ["file", "strings", "xxd", "hexdump", "grep", "find", "unzip", "tar", "awk", "sed"],
            "reverse": ["readelf", "objdump", "nm", "ldd", "checksec", "pyinstxtractor", "pycdc", "uncompyle6"],
            "crypto": [],  # Python packages checked separately
            "pwn": ["checksec", "one_gadget", "ROPgadget"],
            "forensics": ["tshark", "binwalk", "foremost", "exiftool", "volatility"],
            "stego": ["zsteg", "steghide", "pngcheck", "identify", "ffmpeg"],
        }
        for category, tools in checks.items():
            available = []
            for t in tools:
                if shutil.which(t):
                    available.append(t)
            caps[category] = available
        # Python package checks
        py_pkgs = {
            "z3": "z3-solver",
            "angr": "angr",
            "pwntools": "pwntools",
            "unicorn": "unicorn",
            "sympy": "sympy",
            "Crypto": "pycryptodome",
            "gmpy2": "gmpy2",
            "sage": "sagemath",
        }
        available_py = []
        for mod, pkg in py_pkgs.items():
            try:
                __import__(mod)
                available_py.append(pkg)
            except ImportError:
                pass
        caps["python_packages"] = available_py
        return caps

    def _update_hypotheses(self, task: CtfTask, hypotheses: List[Dict[str, Any]]) -> None:
        """更新假设账本。"""
        hlist = self._hypotheses.setdefault(task.task_id, [])
        # 更新现有假设或添加新假设
        existing_names = {h.get("name", "") for h in hlist}
        for h in hypotheses:
            name = h.get("name", "unnamed")
            if name in existing_names:
                # 更新现有
                for i, existing in enumerate(hlist):
                    if existing.get("name") == name:
                        hlist[i].update(h)
                        break
            else:
                hlist.append(h)
                existing_names.add(name)
        # 写入 blackboard
        try:
            for h in hypotheses:
                self.blackboard.add_fact(
                    task_id=task.task_id, kind="hypothesis",
                    content=f"{h.get('name', '?')}: conf={h.get('confidence', 0.5)} next={h.get('next_test', '')}",
                    confidence=h.get("confidence", 0.5),
                    source_step="agent_think",
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("write hypothesis fact failed: %s", e)

    def _get_failed_commands(self, task: CtfTask) -> set:
        """返回失败的命令/脚本摘要集合。"""
        failed = set()
        for h in task.shell_history:
            if h.get("exit_code", 0) != 0:
                failed.add(h.get("command", "").strip())
        for r in task.script_runs:
            if r.get("exit_code", 0) != 0:
                # 脚本太长，用前 100 字符做签名
                sig = task.current_script[:100].strip() if task.current_script else ""
                if sig:
                    failed.add(sig)
        return failed

    def _expand_context(self, task: CtfTask, content_json: str) -> str:
        """根据 expand_context 请求读取文件更多内容。"""
        try:
            req = json.loads(content_json) if isinstance(content_json, str) else content_json
        except (json.JSONDecodeError, TypeError):
            req = {"file": content_json.strip(), "mode": "text"}

        file_path = req.get("file", "")
        mode = req.get("mode", "text")
        offset = int(req.get("offset", 0))
        limit = int(req.get("limit", 20000))

        ws = self._get_or_create_workspace(task)
        full_path = os.path.join(ws, os.path.basename(file_path)) if not os.path.isabs(file_path) else file_path
        if not os.path.isfile(full_path):
            # 尝试在 attachments 中查找
            for a in task.attachments:
                if os.path.basename(a) == os.path.basename(file_path):
                    full_path = a
                    break
        if not os.path.isfile(full_path):
            return f"文件不存在: {file_path}"

        try:
            file_size = os.path.getsize(full_path)
            from types import SimpleNamespace
            from app.core.agent_tool_gateway import AgentToolGateway
            gateway = AgentToolGateway(task_id=task.task_id, workspace=ws, category=task.category_hint, authorized=task.authorized, allow_network=task.allow_network)
            def run_controlled(command: str, timeout: int):
                out, err, ok = gateway.execute("run_shell", {"command": command, "timeout": timeout})
                return SimpleNamespace(stdout=out, stderr=err, success=ok)
            if mode == "hex":
                # 二进制 hexdump
                with open(full_path, "rb") as f:
                    f.seek(offset)
                    raw = f.read(min(limit, 200000))
                lines = []
                for i in range(0, len(raw), 16):
                    chunk = raw[i:i+16]
                    hex_part = " ".join(f"{b:02x}" for b in chunk)
                    ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
                    lines.append(f"{offset+i:08x}  {hex_part:<48s}  {ascii_part}")
                return "\n".join(lines[:500])  # 最多 500 行
            elif mode == "strings":
                result = run_controlled(
                    f"strings -n 6 -t x \"{full_path}\" | head -200",
                    workdir=ws, timeout=15,
                )
                return result.stdout[:limit] if result.success else f"strings failed: {result.stderr[:200]}"
            elif mode == "disasm":
                result = run_controlled(
                    f"objdump -d \"{full_path}\" | head -500",
                    workdir=ws, timeout=15,
                )
                return result.stdout[:limit] if result.success else f"objdump failed: {result.stderr[:200]}"
            elif mode == "pcap":
                # tshark 摘要
                result = run_controlled(
                    f"tshark -r \"{full_path}\" -T fields -e frame.number -e ip.src -e ip.dst -e _ws.col.Protocol -e frame.len 2>/dev/null | head -200",
                    workdir=ws, timeout=30,
                )
                return result.stdout[:limit] if result.success else f"tshark failed: {result.stderr[:200]}"
            elif mode == "image_meta":
                result = run_controlled(
                    f"identify verbose \"{full_path}\" 2>/dev/null || exiftool \"{full_path}\" 2>/dev/null || pngcheck \"{full_path}\" 2>/dev/null",
                    workdir=ws, timeout=15,
                )
                return result.stdout[:limit] if result.success else f"image tools failed"
            else:
                # 默认文本模式
                with open(full_path, "rb") as f:
                    f.seek(offset)
                    raw = f.read(min(limit, 200000))
                try:
                    text = raw.decode("utf-8", errors="replace")
                except Exception:
                    text = raw.decode("latin-1", errors="replace")
                return text
        except Exception as e:  # noqa: BLE001
            return f"扩展上下文失败: {type(e).__name__}: {str(e)[:200]}"

    def _replan_with_expert(self, task: CtfTask) -> None:
        """用 expert 模型重新规划方向。"""
        route = self.router.decide(
            task_id=task.task_id, step="replan",
            force_expert=True,
        )
        if route.lane == "stop":
            return  # 预算不够，不 replan
        adapter = get_route_adapter(route)
        self._last_route_models[task.task_id] = f"expert_replan:{route.model}"

        # 收集当前假设和失败历史
        hyp_summary = json.dumps(self._hypotheses.get(task.task_id, [])[:3], ensure_ascii=False)
        failed = list(self._get_failed_commands(task))[:10]
        context = self._build_agent_context(task)

        prompt = (
            f"当前任务: {task.title}\n"
            f"题面: {task.description[:2000]}\n"
            f"题型: {task.plan.category if task.plan else 'unknown'}\n"
            f"\n当前假设: {hyp_summary}\n"
            f"\n已失败方向: {failed}\n"
            f"\n上下文摘要:\n{context[:3000]}\n"
            f"\n请你作为 expert 重新规划解题方向。"
            f"输出 JSON 格式:"
            f'{{"new_hypotheses": [{{"name": "", "confidence": 0.7, "next_test": ""}}], '
            f'"abandoned_directions": [""], "strategy": ""}}'
        )
        resp = adapter.chat(
            [{"role": "user", "content": prompt}],
            system_prompt="你是 CTF 解题专家。重新规划解题方向，避免已失败路径。输出 JSON。",
            max_tokens=route.max_tokens,
            temperature=0.3,
        )
        self._record_llm_cost(task, "replan", resp, route, [{"role": "user", "content": prompt}])
        if resp.success and resp.content:
            try:
                data = json.loads(resp.content.strip())
                if data.get("new_hypotheses"):
                    self._update_hypotheses(task, data["new_hypotheses"])
            except json.JSONDecodeError:
                pass  # 非致命

    # ---------- v8 helpers: route-aware LLM ----------

    def _get_route_llm(self, task: CtfTask, step: str, force_expert: bool = False) -> Tuple[LLMAdapter, RouteDecision]:
        """根据路由决策获取对应 lane 的 LLM 客户端。

        核心修复：之前所有 LLM 调用都用 self.llm，
        现在 route=expert 时真实使用 GLM5.2 客户端。
        """
        route = self._route_decision(task, step, force_expert=force_expert)
        if route.lane == "stop":
            return self.llm, route  # stop 不调 LLM，用默认即可
        adapter = get_route_adapter(route)
        self._last_route_models[task.task_id] = f"{route.lane}:{route.model}"
        return adapter, route

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
        max_rounds: int = 0,
        max_time_sec: int = 600,
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
            max_rounds=max_rounds,  # v7: 0=无限
            max_time_sec=max(min(max_time_sec, 3600), 30),
            source=source,
            demo_id=demo_id,
            expected_flag=expected_flag,
        )
        _TASKS[tid] = task
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
        try:
            save_task(task.to_dict())
        except Exception as e:  # noqa: BLE001
            logger.warning("persist add_attachment failed: %s", e)
        return True

    def get_task(self, task_id: str) -> Optional[CtfTask]:
        return _TASKS.get(task_id)

    def list_tasks(self) -> List[CtfTask]:
        return sorted(_TASKS.values(), key=lambda t: -t.created_at)

    def run(
        self,
        task_id: str,
        *,
        max_rounds: Optional[int] = None,
        max_time_sec: Optional[int] = None,
    ) -> CtfTask:
        """运行状态机直到 DONE / FAILED / HUMAN_REQUIRED。v7: 时间限制替代硬轮数。"""
        task = _TASKS.get(task_id)
        if not task:
            raise ValueError(f"task not found: {task_id}")

        if task.allow_network and not task.authorized:
            task.allow_network = False
            self._record_evidence(
                task, "scope_check",
                "allow_network=true 但 authorized=false，已强制关闭网络访问",
                success=False,
            )

        rounds_cap = max_rounds if max_rounds is not None else task.max_rounds
        time_cap = max_time_sec if max_time_sec is not None else task.max_time_sec
        task.started_at = time.time()
        task.is_running = True
        try:
            save_task(task.to_dict())
        except Exception as e:  # noqa: BLE001
            logger.warning("persist running=true failed: %s", e)

        try:
            while task.state not in (CtfState.DONE, CtfState.FAILED, CtfState.HUMAN_REQUIRED):
                from app.api.ctf import _cancel_events
                cancel_evt = _cancel_events.get(task_id)
                if cancel_evt and cancel_evt.is_set():
                    task.state = CtfState.HUMAN_REQUIRED
                    task.error = "用户手动停止"
                    emit_agent_live(task.task_id, event_type="error", phase="CANCEL",
                                    title="用户手动停止", detail="任务已被用户停止")
                    break
                # v7: 0=无限轮数
                if rounds_cap > 0 and task.rounds_used >= rounds_cap:
                    task.state = CtfState.HUMAN_REQUIRED
                    task.error = f"达到最大轮次 {rounds_cap}，请人工接管"
                    emit_agent_live(task.task_id, event_type="error", phase=task.state.value,
                                    title="⚠️ 达到最大轮次",
                                    detail=task.error)
                    break
                # v7: 时间限制
                if task.started_at and (time.time() - task.started_at) > time_cap:
                    task.state = CtfState.HUMAN_REQUIRED
                    task.error = f"运行超时 {time_cap}s，请人工接管"
                    self._record_evidence(task, "time_stop", f"超时 {time_cap}s", success=False)
                    emit_agent_live(task.task_id, event_type="error", phase=task.state.value,
                                    title="⚠️ 运行超时",
                                    detail=f"已运行超过 {time_cap}s，请人工接管")
                    break
                if self.cost_accounting.is_budget_exceeded(task.task_id):
                    task.state = CtfState.HUMAN_REQUIRED
                    task.error = "LLM 预算超支，请人工接管"
                    self._record_evidence(task, "budget_stop", "预算超支", success=False)
                    emit_agent_live(task.task_id, event_type="error", phase=task.state.value,
                                    title="⚠️ LLM 预算超支",
                                    detail="LLM 调用预算已耗尽，请人工接管")
                    break
                self._run_observer_pre_check(task, rounds_cap)
                if task.state in (CtfState.DONE, CtfState.FAILED, CtfState.HUMAN_REQUIRED):
                    break
                task.rounds_used += 1
                self._step(task)
                task.updated_at = time.time()
                self._post_step_blackboard(task)
                try:
                    save_task(task.to_dict())
                except Exception as e:  # noqa: BLE001
                    logger.warning("persist step failed: %s", e)
        except Exception as e:  # noqa: BLE001
            task.state = CtfState.FAILED
            task.error = f"orchestrator error: {type(e).__name__}: {e}"
            logger.exception("orchestrator failed for task %s", task_id)
            emit_agent_live(task.task_id, event_type="error", phase="FAILED",
                            title="❌ Orchestrator 异常",
                            detail=f"{type(e).__name__}: {e}")
        finally:
            task.is_running = False
            # Emit final state
            if task.state == CtfState.DONE:
                emit_agent_live(task.task_id, event_type="flag", phase="DONE",
                                title="✅ 解题完成!",
                                detail=f"Flag: {task.best_flag or '(无)'}")
            elif task.state in (CtfState.FAILED, CtfState.HUMAN_REQUIRED):
                emit_agent_live(task.task_id, event_type="error", phase=task.state.value,
                                title="🛑 解题终止",
                                detail=task.error)
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
        elif st == CtfState.AGENT_THINK:
            self._agent_think(task)
        elif st == CtfState.RUN_SHELL:
            self._run_shell(task)
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
        emit_agent_live(task.task_id, event_type="info", phase="INIT",
                        title="🚀 任务初始化",
                        detail=f"任务启动 | 授权={task.authorized} | 联网={task.allow_network}")
        task.state = CtfState.CLASSIFY

    def _classify(self, task: CtfTask) -> None:
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
            emit_agent_live(task.task_id, event_type="info", phase="CLASSIFY",
                            title="🏷️ 题型识别",
                            detail=f"用户指定题型: {task.category_hint}，跳过 LLM 分类")
            self._auto_search_writeup(task)
            task.state = CtfState.PLAN
            return

        emit_agent_live(task.task_id, event_type="thinking", phase="CLASSIFY",
                        title="🏷️ 正在识别题型...",
                        detail="调用 LLM 分析题面和附件，判断题型分类")

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
            emit_agent_live(task.task_id, event_type="result", phase="CLASSIFY",
                            title=f"🏷️ 题型识别: {cat}",
                            detail=f"Mock 模式关键词识别，分类: {cat}，置信度: 70%")
            task.plan = plan
            task.state = CtfState.PLAN
            return
        # v8: route-aware LLM for classify
        adapter, route = self._get_route_llm(task, "classify")
        ok, data, resp = adapter.chat_json(
            [{"role": "user", "content": prompt}],
            system_prompt=sys,
            max_tokens=route.max_tokens,
        )
        self._record_llm_cost(task, "classify", resp, route, [{"role": "user", "content": prompt}])
        if not ok or not data:
            if task.attachments:
                cat = self._guess_category_from_attachments(task.attachments)
                source = "附件特征"
            else:
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
        emit_agent_live(task.task_id, event_type="result", phase="CLASSIFY",
                        title=f"🏷️ 题型识别结果: {plan.category}",
                        detail=f"分类: {plan.category} | 置信度: {plan.confidence:.0%} | 理由: {plan.initial_guess}",
                        success=resp.success)
        self._auto_search_writeup(task)
        task.state = CtfState.PLAN

    def _plan(self, task: CtfTask) -> None:
        if not task.plan:
            task.plan = TaskPlan(category="misc")
        emit_agent_live(task.task_id, event_type="thinking", phase="PLAN",
                        title="📋 正在生成解题计划...",
                        detail=f"基于题型 {task.plan.category} 生成解题步骤和风险分析")
        prompt = (
            f"题型: {task.plan.category}\n"
            f"题面: {task.description[:500]}\n"
            f"附件: {[os.path.basename(a) for a in task.attachments]}\n"
            "请生成解题计划，JSON 输出: {plan:[步骤], risks:[风险], fallback:'备用思路'}"
        )
        # v8: route-aware LLM for plan
        adapter, route = self._get_route_llm(task, "plan")
        if route.lane == "stop":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = "预算耗尽，转入人工接管"
            return
        ok, data, resp = adapter.chat_json(
            [{"role": "user", "content": prompt}],
            system_prompt="你是 CTF 解题策略师。只输出 JSON。",
            max_tokens=route.max_tokens,
        )
        self._record_llm_cost(task, "plan", resp, route, [{"role": "user", "content": prompt}])
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
        plan_summary = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(task.plan.script_plan[:8]))
        emit_agent_live(task.task_id, event_type="result", phase="PLAN",
                        title=f"📋 解题计划 ({len(task.plan.script_plan)} 步)",
                        detail=plan_summary,
                        success=resp.success)
        task.state = CtfState.ANALYZE_FILES

    def _analyze_files(self, task: CtfTask) -> None:
        if not task.attachments:
            self._record_evidence(task, "analyze_files", "无附件，跳过文件分析")
            emit_agent_live(task.task_id, event_type="info", phase="ANALYZE_FILES",
                            title="📁 附件分析",
                            detail="无附件，跳过文件分析")
            task.analysis = {"summary": {"file_count": 0}}
            # v9: Web 类别或真实 LLM 模式走 AGENT_THINK
            is_mock = bool(getattr(self.llm, "mock_mode", False)) or not getattr(self.llm, "enabled", True)
            category = (task.plan.category if task.plan else "") or task.category_hint or ""
            if not is_mock or category == "web":
                task.state = CtfState.AGENT_THINK
            else:
                task.state = CtfState.GENERATE_SCRIPT
            return
        emit_agent_live(task.task_id, event_type="thinking", phase="ANALYZE_FILES",
                        title="📁 正在分析附件...",
                        detail=f"共 {len(task.attachments)} 个附件，执行静态分析（file/strings/binwalk/exiftool 等）")
        try:
            summary: Dict[str, Any] = {"files": [], "summary": {}}
            for fp in task.attachments:
                ar = self.analyzer.analyze(fp, flag_format=task.flag_format)
                for f in ar.files:
                    summary["files"].append(f.to_dict())
                if ar.summary.get("has_flag_candidate"):
                    for f in ar.files:
                        for fl in f.flags_found:
                            task.candidate_flags.append({
                                "flag": fl,
                                "source": f.relative_path,
                                "confidence": 0.7,
                            })
            task.analysis = summary
            self._write_file_facts_to_blackboard(task, summary)
            file_names = [os.path.basename(a) for a in task.attachments]
            emit_agent_live(task.task_id, event_type="result", phase="ANALYZE_FILES",
                            title=f"📁 文件分析完成 ({len(task.attachments)} 文件)",
                            detail=f"分析: {', '.join(file_names)} | 发现 {len(task.candidate_flags)} 个候选 flag",
                            success=True)
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
        # v7: mock 模式走 GENERATE_SCRIPT 经典路径，真实 LLM 走 AGENT_THINK
        # v9: Web 类别无附件时直接走 AGENT_THINK（Web 题需要 agent 与远程交互）
        is_mock = bool(getattr(self.llm, "mock_mode", False)) or not getattr(self.llm, "enabled", True)
        category = (task.plan.category if task.plan else "") or task.category_hint or ""
        if not is_mock or category == "web":
            task.state = CtfState.AGENT_THINK
        else:
            task.state = CtfState.GENERATE_SCRIPT

    def _auto_search_writeup(self, task: CtfTask) -> None:
        """自动搜索 writeup，将结果注入 task 上下文，不依赖 LLM 选择 web_search。"""
        if not task.authorized or not task.allow_network:
            return
        title = task.title or ""
        if not title.strip():
            return
        queries = [
            f"{title} CTF writeup",
            f"{title} CTF 解题",
        ]
        category = (task.plan.category if task.plan else "") or ""
        if category and category != "misc":
            queries.append(f"{title} {category} writeup")
        all_results = []
        fetched_content = ""
        for q in queries[:2]:
            try:
                from app.tools.web_search import WebSearchTool
                tool = WebSearchTool()
                result = tool.run({"query": q, "max_results": 5, "allow_network": True})
                if result.get("success"):
                    for r in result.get("details", {}).get("results", []):
                        url = r.get("url", "")
                        title_r = r.get("title", "")
                        snippet = r.get("snippet", "")
                        all_results.append({"query": q, "title": title_r, "url": url, "snippet": snippet})
            except Exception as e:
                logger.warning("auto_search query=%s tool failed: %s, trying ddg direct", q, e)
                try:
                    all_results.extend(self._ddg_search_direct(q, 5))
                except Exception as e2:
                    logger.warning("auto_search ddg direct query=%s failed: %s", q, e2)
        seen_urls = set()
        unique_results = []
        for r in all_results:
            if r["url"] not in seen_urls:
                seen_urls.add(r["url"])
                unique_results.append(r)
        for r in unique_results[:5]:
            url = r["url"]
            skip_domains = ["google.com", "youtube.com", "facebook.com", "twitter.com", "baidu.com", "wikipedia.org"]
            if any(d in url for d in skip_domains):
                continue
            try:
                from app.tools.web_fetch import WebFetchTool
                fetch_tool = WebFetchTool()
                fetch_result = fetch_tool.run({"url": url, "max_chars": 8000, "allow_network": True})
                if fetch_result.get("success"):
                    content = fetch_result.get("details", {}).get("content", "")
                    if content and len(content) > 200:
                        fetched_content += f"\n### Writeup: {r['title']}\n来源: {url}\n{content}\n---\n"
            except Exception as e:
                logger.warning("auto_fetch url=%s failed: %s", url, e)
        search_summary = ""
        if unique_results:
            search_summary = "## 自动搜索到的 Writeup/资料（系统已帮你搜索，请参考）\n"
            for i, r in enumerate(unique_results[:8]):
                search_summary += f"{i+1}. **{r['title']}**\n   URL: {r['url']}\n"
                if r.get("snippet"):
                    search_summary += f"   摘要: {r['snippet'][:300]}\n"
            if fetched_content:
                search_summary += f"\n## 部分 Writeup 全文（系统已帮你获取）\n{fetched_content[:12000]}\n"
            search_summary += "\n**请参考以上 writeup 中的攻击思路和 payload 来解题，不要闭门造车！**\n"
        if not search_summary:
            search_summary = "## 自动搜索未找到相关 writeup，需要自主分析\n"
        if fetched_content and len(fetched_content) > 300:
            extracted_steps = self._extract_attack_steps(task, fetched_content[:8000])
            if extracted_steps:
                search_summary += f"\n## 提取的可执行攻击步骤（请按此执行）\n{extracted_steps}\n"
        if not hasattr(task, '_auto_search_results'):
            task._auto_search_results = ""
        task._auto_search_results = search_summary
        self._record_evidence(
            task, "auto_search_writeup",
            f"自动搜索到 {len(unique_results)} 条结果，获取了 {len(fetched_content)} 字符 writeup",
            artifacts={"results_count": len(unique_results), "fetched_chars": len(fetched_content)},
            success=bool(unique_results),
        )
        emit_agent_live(task.task_id, event_type="info", phase="CLASSIFY",
                        title="🔍 自动搜索 Writeup",
                        detail=f"搜索到 {len(unique_results)} 条相关结果，获取了 {len(fetched_content)} 字符 writeup 内容")

    @staticmethod
    def _ddg_search_direct(query: str, max_results: int = 5) -> List[Dict[str, str]]:
        """DuckDuckGo HTML 直接搜索兜底。"""
        import httpx
        url = "https://html.duckduckgo.com/html/"
        data = {"q": query, "b": ""}
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
        with httpx.Client(timeout=15, follow_redirects=True, verify=False) as client:
            resp = client.post(url, data=data, headers=headers)
            resp.raise_for_status()
            html = resp.text
        results = []
        for m in re.finditer(r'class="result__a"[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', html):
            u = m.group(1)
            t = re.sub(r'<[^>]+>', '', m.group(2)).strip()
            snippet = ""
            after = html[m.end():m.end() + 500]
            sm = re.search(r'class="result__snippet"[^>]*>(.*?)</[at]', after)
            if sm:
                snippet = re.sub(r'<[^>]+>', '', sm.group(1)).strip()[:300]
            if t:
                results.append({"query": query, "title": t, "url": u, "snippet": snippet})
            if len(results) >= max_results:
                break
        return results

    def _extract_attack_steps(self, task: CtfTask, writeup_content: str) -> str:
        """用 LLM 从 writeup 中提取可执行的攻击步骤。"""
        try:
            prompt = (
                f"以下是 CTF 题目 '{task.title}' 的 writeup 内容：\n"
                f"---\n{writeup_content}\n---\n\n"
                f"请提取其中的**可执行攻击步骤**，输出格式：\n"
                f"1. 每步一条，包含具体命令或 payload\n"
                f"2. 如果有 curl 命令，直接给出完整命令\n"
                f"3. 如果有 Python 脚本，给出关键逻辑\n"
                f"4. 如果需要多步组合攻击（如先写文件再访问），明确写出先后顺序\n"
                f"5. 输出纯文本步骤，不要 JSON\n\n"
                f"示例格式：\n"
                f"Step 1: 访问首页获取源码\ncurl -s 'http://TARGET/' | grep -i 'shell\\|exec\\|open'\n\n"
                f"Step 2: 用 SSRF 读取 /etc/passwd\ncurl 'http://TARGET/?url=file:///etc/passwd&filename=test.txt'\n\n"
                f"Step 3: ...\n"
            )
            adapter = self.llm
            resp = adapter.chat(
                [{"role": "user", "content": prompt}],
                system_prompt="你是 CTF 专家。从 writeup 中提取具体可执行的攻击步骤和命令。输出纯文本步骤。",
                max_tokens=1500,
                temperature=0.2,
            )
            if resp.success and resp.content:
                return resp.content.strip()
        except Exception as e:
            logger.warning("extract_attack_steps failed: %s", e)
        return ""
        url = "https://html.duckduckgo.com/html/"
        data = {"q": query, "b": ""}
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
        with httpx.Client(timeout=15, follow_redirects=True, verify=False) as client:
            resp = client.post(url, data=data, headers=headers)
            resp.raise_for_status()
            html = resp.text
        results = []
        for m in re.finditer(r'class="result__a"[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', html):
            u = m.group(1)
            t = re.sub(r'<[^>]+>', '', m.group(2)).strip()
            snippet = ""
            after = html[m.end():m.end() + 500]
            sm = re.search(r'class="result__snippet"[^>]*>(.*?)</[at]', after)
            if sm:
                snippet = re.sub(r'<[^>]+>', '', sm.group(1)).strip()[:300]
            if t:
                results.append({"query": query, "title": t, "url": u, "snippet": snippet})
            if len(results) >= max_results:
                break
        return results

    # ---------- v7: Agent Think 循环 ----------

    def _agent_think(self, task: CtfTask) -> None:
        """v9: 优先使用 AgentRuntime（Codex/Claude Code 风格 tool-using loop）。
        如果 AgentRuntime 不可用，回退到旧 _agent_think_legacy 流程。"""
        if not self._use_agent_runtime(task):
            self._agent_think_legacy(task)
            return
        ws = self._get_or_create_workspace(task)
        runtime = self._build_agent_runtime(task, ws)
        runtime_name = "Claude Code Bridge Runtime" if isinstance(runtime, CcBridgeRuntime) else "Agent Runtime"
        emit_agent_live(task.task_id, event_type="info", phase="AGENT_THINK",
                        title=f"🧠 启动 {runtime_name}",
                        detail="进入 Claude Code / tool-using agent loop")

        runtime._orch_task = task
        runtime._orch_self = self

        final_state = self._run_runtime_with_sync(runtime, task)
        self._sync_runtime_to_task(task, runtime)
        if final_state == "done":
            task.state = CtfState.VERIFY_FLAG
        elif final_state == "human_required":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = runtime.error or "Agent Runtime 请求人工接管"
        else:
            task.state = CtfState.AGENT_THINK

    def _run_runtime_with_sync(self, runtime: AgentRuntime, task: CtfTask) -> str:
        """在后台线程运行 runtime.run()，主线程每 2 秒同步状态到 orchestrator task。"""
        import threading
        result_holder = {"state": "running", "error": ""}

        def _run_in_thread():
            try:
                final = runtime.run()
                result_holder["state"] = final
            except Exception as e:
                result_holder["state"] = "human_required"
                result_holder["error"] = str(e)[:500]

        t = threading.Thread(target=_run_in_thread, daemon=True)
        t.start()

        while t.is_alive():
            t.join(timeout=2)
            if not t.is_alive():
                break
            self._sync_runtime_to_task(task, runtime)
            task.rounds_used = len(runtime.turns)
            task.updated_at = time.time()
            try:
                save_task(task.to_dict())
            except Exception:
                pass
            from app.api.ctf import _cancel_events
            cancel_evt = _cancel_events.get(runtime.task_id)
            if cancel_evt and cancel_evt.is_set():
                runtime.state = "human_required"
                runtime.error = "用户手动停止"
                break

        self._sync_runtime_to_task(task, runtime)
        task.rounds_used = len(runtime.turns)
        if result_holder.get("error"):
            runtime.error = result_holder["error"]
        return result_holder["state"] or runtime.state

    def _use_agent_runtime(self, task: CtfTask) -> bool:
        """判断是否使用主 Agent Runtime。

        CC_RUNTIME_ENABLED=False 时强制使用内部 AgentRuntime，
        不走 CcBridgeRuntime（避免调用外部 claude CLI）。
        """
        cc_enabled = getattr(settings, "CC_RUNTIME_ENABLED", False)
        is_mock = bool(getattr(self.llm, "mock_mode", False)) or not getattr(self.llm, "enabled", True)
        if not cc_enabled:
            return True
        return not is_mock

    def _build_agent_runtime(self, task: CtfTask, workspace: str) -> AgentRuntime:
        import shutil as _shutil
        route = self._route_decision(task, "agent_think")
        adapter = get_route_adapter(route) if route.lane != "stop" else self.llm
        need_network = task.authorized and task.allow_network
        sandbox = get_sandbox(allow_network=need_network) if need_network else self.sandbox
        skills_text = self._load_relevant_skill(task)
        python_runtime = AgentRuntime(
            task_id=task.task_id,
            workspace=workspace,
            title=task.title,
            description=task.description,
            category=task.plan.category if task.plan else "unknown",
            flag_format=task.flag_format,
            attachments=task.attachments,
            allow_network=task.allow_network,
            authorized=task.authorized,
            max_turns=task.max_rounds if task.max_rounds > 0 else 50,
            max_time_sec=task.max_time_sec,
            llm=adapter,
            sandbox=sandbox,
            blackboard=self.blackboard,
            router=self.router,
            cost_accounting=self.cost_accounting,
            verifier=self.verifier,
        )
        cc_available = False
        if getattr(settings, "CC_RUNTIME_ENABLED", False):
            cc_bin = getattr(settings, "CC_RUNTIME_BIN", "") or _shutil.which("claude")
            vendor_dir = Path(__file__).resolve().parents[1] / "vendor" / "claude-code"
            dist_cli = vendor_dir / "dist" / "cli.js"
            if cc_bin or dist_cli.is_file():
                cc_available = True
        if cc_available:
            runtime = CcBridgeRuntime(
                task_id=task.task_id,
                workspace=workspace,
                title=task.title,
                description=task.description,
                category=task.plan.category if task.plan else "unknown",
                flag_format=task.flag_format,
                attachments=task.attachments,
                allow_network=task.allow_network,
                authorized=task.authorized,
                max_turns=task.max_rounds if task.max_rounds > 0 else 50,
                max_time_sec=task.max_time_sec,
                verifier=self.verifier,
                fallback_runtime=python_runtime,
            )
        else:
            runtime = python_runtime
        for spec in self._get_tool_specs():
            runtime.register_tool(spec)
        runtime.load_skills(skills_text)
        if hasattr(task, '_auto_search_results') and task._auto_search_results:
            runtime._auto_search_results = task._auto_search_results
        return runtime

    def _sync_runtime_to_task(self, task: CtfTask, runtime: AgentRuntime) -> None:
        for turn in runtime.turns:
            for obs in turn.observations:
                if obs.tool_name in ("run_shell", "http_request") and obs.success:
                    cmd = ""
                    for tc in turn.tool_calls:
                        if tc.id == obs.tool_call_id:
                            if obs.tool_name == "run_shell":
                                cmd = tc.arguments.get("command", "")
                            elif obs.tool_name == "http_request":
                                url = tc.arguments.get("url", "")
                                method = tc.arguments.get("method", "GET")
                                params = tc.arguments.get("params", {})
                                cmd = f"http_request {method} {url}"
                                if params:
                                    cmd += f" params={json.dumps(params, ensure_ascii=False)[:200]}"
                            break
                    task.shell_history.append({
                        "command": cmd, "exit_code": 0,
                        "stdout": obs.output[:2000], "stderr": "",
                        "duration_ms": obs.duration_ms,
                    })
                elif obs.tool_name == "run_python" and obs.success:
                    code = ""
                    for tc in turn.tool_calls:
                        if tc.id == obs.tool_call_id:
                            code = tc.arguments.get("code", "")
                            break
                    task.script_runs.append({
                        "exit_code": 0, "stdout": obs.output[:2000],
                        "stderr": "", "duration_ms": obs.duration_ms,
                        "run_index": len(task.script_runs),
                    })
        for c in runtime.candidate_flags:
            existing = {cf["flag"] for cf in task.candidate_flags}
            if c["flag"] not in existing:
                task.candidate_flags.append(c)
        task.candidate_flags.sort(key=lambda c: -c.get("confidence", 0.5))
        if runtime.best_flag:
            task.best_flag = runtime.best_flag
        for record in runtime.ledger:
            self._record_evidence(
                task, f"tool:{record.tool_name}",
                f"{record.tool_name} success={record.success} duration={record.duration_ms}ms",
                success=record.success,
            )

    def _get_tool_specs(self) -> list:
        from app.tools.filesystem import ListDirTool, ReadFileTool, WriteFileTool, GrepTool
        from app.tools.shell import RunShellTool
        from app.tools.python_runner import RunPythonTool
        from app.tools.archive import ExtractArchiveTool
        from app.tools.flag_submit import SubmitFlagTool
        from app.tools.web_search import WebSearchTool
        from app.tools.web_fetch import WebFetchTool
        return [
            ListDirTool.as_spec(), ReadFileTool.as_spec(),
            WriteFileTool.as_spec(), GrepTool.as_spec(),
            RunShellTool.as_spec(), RunPythonTool.as_spec(),
            ExtractArchiveTool.as_spec(), SubmitFlagTool.as_spec(),
            WebSearchTool.as_spec(), WebFetchTool.as_spec(),
            ToolSpec(name="http_request",
                     description="发送 HTTP 请求。支持 GET/POST/PUT 等方法。需 authorized=true 才能使用。可自动提取 flag。",
                     input_schema={
                         "type": "object",
                         "properties": {
                             "url": {"type": "string", "description": "目标 URL"},
                             "method": {"type": "string", "description": "HTTP 方法", "default": "GET"},
                             "headers": {"type": "object", "description": "请求头"},
                             "data": {"type": "string", "description": "POST 数据"},
                             "params": {"type": "object", "description": "URL 参数"},
                             "timeout": {"type": "integer", "description": "超时秒数", "default": 15},
                         },
                         "required": ["url"],
                     },
                     permissions=["network_access"], risk_level="medium", timeout_seconds=15),
            ToolSpec(name="ask_human", description="请求人工协助。当 Agent 无法继续时使用。",
                     input_schema={"type": "object", "properties": {"question": {"type": "string", "description": "问题"}}, "required": ["question"]},
                     permissions=[], risk_level="low", timeout_seconds=5),
            ToolSpec(name="internal_replan", description="请求重新规划解题方向。不直接结束任务。",
                     input_schema={"type": "object", "properties": {"reason": {"type": "string", "description": "replan 原因"}}, "required": ["reason"]},
                     permissions=[], risk_level="low", timeout_seconds=5),
        ]

    def _load_relevant_skill(self, task: CtfTask) -> str:
        category = (task.plan.category if task.plan else "") or task.category_hint or "misc"
        skill_path = os.path.join(os.path.dirname(__file__), "..", "skills", category, "SKILL.md")
        if os.path.isfile(skill_path):
            try:
                with open(skill_path, "r", encoding="utf-8") as f:
                    return f.read()[:8000]
            except Exception:
                pass
        generic_path = os.path.join(os.path.dirname(__file__), "..", "skills", "ctf", "SKILL.md")
        if os.path.isfile(generic_path):
            try:
                with open(generic_path, "r", encoding="utf-8") as f:
                    return f.read()[:8000]
            except Exception:
                pass
        return ""

    def _agent_think_legacy(self, task: CtfTask) -> None:
        """v7 旧流程：LLM 自主思考下一步行动（当 AgentRuntime 不可用时回退）。"""
        # 静态命中 → 直接验证
        if task.candidate_flags and any(c.get("confidence", 0) >= 0.7 for c in task.candidate_flags):
            self._record_evidence(
                task, "agent_think",
                f"静态分析已发现高置信候选 flag {len(task.candidate_flags)} 个，直接验证",
                artifacts={"static_only": True},
            )
            emit_agent_live(task.task_id, event_type="flag", phase="AGENT_THINK",
                            title="🎯 静态分析命中高置信 flag",
                            detail=f"发现 {len(task.candidate_flags)} 个高置信候选 flag，直接进入验证阶段")
            task.state = CtfState.VERIFY_FLAG
            return

        route = self._route_decision(task, "agent_think")
        if route.lane == "stop":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = "预算耗尽，转入人工接管"
            return

        # v8: 获取路由对应的真实 LLM 客户端（expert 时用 GLM5.2）
        adapter = get_route_adapter(route)
        self._last_route_models[task.task_id] = f"{route.lane}:{route.model}"

        context = self._build_agent_context(task)
        elapsed = ""
        if task.started_at:
            elapsed = f"已运行 {int(time.time() - task.started_at)}s / {task.max_time_sec}s"

        # Emit: Agent 正在思考
        emit_agent_live(
            task.task_id,
            event_type="thinking",
            phase="AGENT_THINK",
            title="🧠 Agent 正在思考...",
            detail=f"Round {task.rounds_used + 1} | {elapsed} | 模型: {route.model} ({route.lane} lane)\n正在根据上下文信息决定下一步行动...",
        )

        prompt = (
            f"## 任务信息\n"
            f"题目: {task.title}\n"
            f"题面: {task.description[:4000]}\n"  # v8: 从 600 扩大到 4000
            f"题型: {task.plan.category if task.plan else 'unknown'}\n"
            f"flag格式: {task.flag_format or '未指定（通常是 flag{{...}}、CTF{{...}}、SCTF{{...}} 等）'}\n"
            f"{elapsed}\n"
            f"\n{context}\n"
            f"\n---\n"
            f"请根据以上信息，决定下一步行动。\n\n"
            f"## 输出格式（JSON，推荐）\n"
            f'```json\n'
            f'{{"thought_summary": "简短说明当前判断",\n'
            f' "hypotheses": [{{"name": "假设名", "confidence": 0.7, "evidence": ["已有证据"], "next_test": "下一步验证"}}],\n'
            f' "action": {{"type": "shell|script|flag|replan|stuck|expand_context", "content": "命令/代码/flag/扩展请求"}},\n'
            f' "avoid_repeating": ["已失败方向"],\n'
            f' "expected_signal": "这一步希望看到什么结果"}}\n'
            f'```\n\n'
            f"## 也支持旧格式（兼容）\n"
            f"1. `SHELL: <命令>` — 执行 shell 命令\n"
            f"2. `SCRIPT:` 后接 Python 代码 — 运行脚本\n"
            f"3. `FLAG: <flag值>` — 提交 flag\n"
            f"4. `STUCK` — 确实无法继续\n\n"
            f"## 重要策略提示\n"
            f"- 附件文件已在当前工作目录中，直接用文件名访问\n"
            f"- 需要安装 Python 包时：SHELL: pip3 install <包名>\n"
            f"- reverse 题：file → strings → readelf/objdump → pyinstxtractor → python3 分析\n"
            f"  - PyInstaller：pip3 install pyinstxtractor-ng; python3 -m pyinstxtractor <file>\n"
            f"  - Python bytecode：dis 模块 + marshal 分析；Python 3.8 用 xdis\n"
            f"  - .pyd (Cython C扩展)：strings 提取常量 → 反汇编分析\n"
            f"  - **Brainfuck/VM 逆向**（极高频题型！）：\n"
            f"    1. 用正则提取 BF 代码: re.findall(rb'[><+\\-\\[\\],.]{{1000,}}', data)\n"
            f"    2. 写 BF VM（必须 8-bit cell: tape[p] = (tape[p] + 1) & 0xff）\n"
            f"    3. BF 的 `,` 在循环中会多次读输入，不能只读一次\n"
            f"    4. 先用已知 flag 格式（如 flag{{...}}）确定输入长度和前后缀\n"
            f"    5. 提取 BF 中硬编码的比较常量\n"
            f"    6. 反推校验算法（相邻异或、逐字符比较等），从末尾向前递推\n"
            f"  - ELF：checksec → 找关键函数 → 还原算法\n"
            f"- crypto 题：识别算法 → python3 写解密脚本\n"
            f"  - RSA: 检查 n 大小/因子/公钥指数\n"
            f"  - XOR: 尝试单字节/多字节/crib\n"
            f"  - Z3: pip3 install z3-solver; 约束求解\n"
            f"- misc/forensics：binwalk/exiftool/tshark/zsteg/python3\n"
            f"  - PNG: 检查 chunk/CRC/IDAT/zlib\n"
            f"  - PCAP: tshark -Y 过滤 → HTTP objects / DNS queries / TCP streams\n"
            f"  - 音频: ffmpeg -i → spectrogram\n"
            f"- **关键**：写 Python 脚本时要写完整的、可直接运行的代码，包括所有 import\n"
            f"- **关键**：BF VM 的 tape cell 必须 & 0xff（8位），否则负数循环会卡死\n"
            f"- 不要重复已失败的命令（见上方失败列表）\n"
            f"- 如果看到 flag{{...}} 或类似格式，直接提交\n"
            f"- 如果脚本成功但没有 flag，继续探索而不是停止\n"
            f"- 一次只输出一个 action，但 hypotheses 可以保留多个备选\n"
            f"- 信息不足时优先请求更多证据（expand_context），不要猜 flag\n"
        )
        sys = (
            "你是 CTF 解题专家 Agent。你不是一次性答题模型，而是一个可以调用 shell、写 Python、"
            "读取附件、维护假设、根据反馈继续探索的自动解题系统。"
            "你的目标是在授权 CTF 环境中找到 flag。"
            "困难题必须像真人选手一样进行多轮分析：先建立假设，再选择最小验证动作，"
            "观察结果，更新假设，必要时换方向。"
            "不要重复失败命令，不要在没有充分证据时 STUCK，不要因为一次脚本没输出 flag 就结束。\n\n"
            "## 解题方法论\n"
            "1. 信息收集：file/strings/binwalk/readelf 确定类型\n"
            "2. 关键提取：找到核心逻辑（BF代码/加密算法/校验函数）\n"
            "3. VM逆向（BF/自定义VM）：写完整的 VM 解释器，用 & 0xff 保证 8-bit cell\n"
            "4. 约束反推：提取硬编码常量，从已知值（flag末尾）向前递推\n"
            "5. 验证：用 VM 运行推导出的 flag，确认输出 'Right/Congrats' 等成功信号\n\n"
            "输出 JSON 格式（推荐）或旧格式（SHELL:/SCRIPT:/FLAG:/STUCK）。"
            "如果输出 JSON 失败，系统会自动重试。"
            "你的思考过程（thought_summary 和 hypotheses）要详细，这是解题关键。"
        )
        messages = [{"role": "user", "content": prompt}]
        resp = adapter.chat(
            messages,
            system_prompt=sys,
            max_tokens=route.max_tokens,
            temperature=route.temperature,
        )
        self._record_llm_cost(task, "agent_think", resp, route, messages)

        if not resp.success or not resp.content:
            self._record_evidence(
                task, "agent_think",
                f"LLM 思考失败({resp.error})，重试",
                success=False,
            )
            return

        content = resp.content.strip()
        action, detail, extra = self._parse_agent_action(content)

        # v8: 将 hypotheses 写入 blackboard
        if extra.get("hypotheses"):
            self._update_hypotheses(task, extra["hypotheses"])

        # v8: 检查 avoid_repeating — 如果命令在失败列表中，跳过
        if extra.get("avoid_repeating") and action in ("SHELL", "SCRIPT"):
            failed_cmds = self._get_failed_commands(task)
            if detail.strip() in failed_cmds:
                emit_agent_live(task.task_id, event_type="warning", phase="AGENT_THINK",
                                title="⚠️ 跳过重复失败命令",
                                detail=f"命令 `{detail[:80]}` 之前已失败，自动跳过",
                                success=False)
                task.state = CtfState.AGENT_THINK  # 重新思考
                return

        self._record_evidence(
            task, "agent_think",
            f"决定: {action} | {detail[:100]}",
            artifacts={"action": action, "detail": detail[:500], "reasoning": content[:2000],
                      "thinking": resp.thinking[:3000] if resp.thinking else "",  # v8: 保存思考过程
                      "route": route.to_dict(), **extra},
            success=True,
        )

        # Emit: Agent 做出决定
        action_label = {"SHELL": "⚡ 执行 Shell 命令", "SCRIPT": "🐍 运行 Python 脚本",
                        "FLAG": "🎯 提交 Flag", "STUCK": "🆘 声明卡住",
                        "REPLAN": "🔄 重规划", "EXPAND_CONTEXT": "📖 扩展上下文",
                        }.get(action, "❓ 未知操作")
        thought_summary = extra.get("thought_summary", "")
        detail_text = f"思考: {thought_summary[:500]}\n\n决定: {action}\n内容: {detail[:500]}" if thought_summary else f"决定: {action}\n内容: {detail[:500]}"
        emit_agent_live(task.task_id, event_type="action", phase="AGENT_THINK",
                        title=f"🧠 Agent 决定: {action_label}",
                        detail=detail_text,
                        code=detail if action in ("SHELL", "SCRIPT") else "",
                        extra={"action": action, "route": route.to_dict(), **extra})

        if action == "SHELL":
            task.shell_history.append({
                "command": detail,
                "exit_code": None, "stdout": "", "stderr": "", "duration_ms": 0,
            })
            task.state = CtfState.RUN_SHELL
        elif action == "SCRIPT":
            task.current_script = detail
            task.state = CtfState.RUN_SCRIPT
        elif action == "FLAG":
            task.candidate_flags.append({
                "flag": detail, "source": "agent_think", "confidence": 0.8,
            })
            task.state = CtfState.VERIFY_FLAG
        elif action == "STUCK":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = "Agent 声明无法继续，请人工接管"
        elif action == "REPLAN":
            # v8: 重新规划 — 升级模型或切换方向
            self._record_evidence(task, "replan", f"Agent 请求重新规划: {detail[:200]}")
            emit_agent_live(task.task_id, event_type="info", phase="AGENT_THINK",
                            title="🔄 Agent 请求重新规划",
                            detail=detail[:500])
            # 强制升级 expert 重规划
            self._replan_with_expert(task)
            task.state = CtfState.AGENT_THINK
        elif action == "EXPAND_CONTEXT":
            # v8: 扩展上下文 — 读取文件更多内容
            expanded = self._expand_context(task, detail)
            self._record_evidence(task, "expand_context", f"扩展上下文: {expanded[:200]}",
                                artifacts={"expanded_content": expanded[:5000]})
            emit_agent_live(task.task_id, event_type="info", phase="AGENT_THINK",
                            title="📖 上下文已扩展",
                            detail=f"读取了更多文件内容 ({len(expanded)} 字符)")
            task.state = CtfState.AGENT_THINK
        else:
            logger.warning("agent action parse failed: %s", content[:200])
            # v8: JSON 解析失败不要停，做一次自动修复尝试
            if '{' in content[:50]:
                emit_agent_live(task.task_id, event_type="warning", phase="AGENT_THINK",
                                title="⚠️ Action 解析失败，重试",
                                detail="LLM 输出 JSON 格式不标准，回到 AGENT_THINK 重试")
            task.state = CtfState.AGENT_THINK  # 不要停，回去重试

    def _parse_agent_action(self, content: str) -> Tuple[str, str, Dict[str, Any]]:
        """解析 Agent 输出为 (action, detail, extra)。

        v9: 内部调用新的 tool_call_parser 统一解析。
        v8 升级：支持 JSON 格式 + 旧格式兼容。
        """
        from app.core.tool_call_parser import parse_tool_calls
        result = parse_tool_calls(content)
        extra: Dict[str, Any] = {}
        if result.tool_calls:
            tc = result.tool_calls[0]
            reverse_map = {
                "run_shell": "SHELL",
                "run_python": "SCRIPT",
                "submit_flag": "FLAG",
                "read_file": "EXPAND_CONTEXT",
                "internal_replan": "REPLAN",
                "ask_human": "STUCK",
            }
            action = reverse_map.get(tc.name, "UNKNOWN")
            if action == "SHELL":
                detail = tc.arguments.get("command", "")
            elif action == "SCRIPT":
                detail = tc.arguments.get("code", "")
            elif action == "FLAG":
                detail = tc.arguments.get("flag", "")
            elif action == "EXPAND_CONTEXT":
                detail = json.dumps(tc.arguments) if tc.arguments else ""
            elif action == "REPLAN":
                detail = tc.arguments.get("reason", "")
            elif action == "STUCK":
                detail = tc.arguments.get("question", "")
            else:
                detail = json.dumps(tc.arguments, ensure_ascii=False) if tc.arguments else content
            if tc.arguments.get("_extra"):
                extra.update(tc.arguments["_extra"])
            return action, detail, extra
        if result.recoverable_error:
            extra["recoverable_error"] = result.recoverable_error
        return "UNKNOWN", content, extra

    def _build_agent_context(self, task: CtfTask) -> str:
        parts = []
        # v8: 扩展上下文容量
        if task.analysis:
            files = task.analysis.get("files", [])[:10]  # v8: 从 8 增加到 10
            if files:
                parts.append("## 文件分析结果")
                for f in files:
                    basename = os.path.basename(f.get('relative_path', ''))
                    parts.append(f"### {basename}")
                    parts.append(f"类型: {f.get('type', '')} | 大小: {f.get('size', 0)}B | MIME: {f.get('mime', '')}")
                    if f.get('suspicious_strings'):
                        parts.append(f"可疑字符串: {f['suspicious_strings'][:12]}")  # v8: 从 8 增加到 12
                    if f.get('flags_found'):
                        parts.append(f"已发现 flag: {f['flags_found'][:8]}")  # v8: 从 5 增加到 8
                    if f.get('content_preview'):
                        parts.append(f"内容预览:\n{f['content_preview'][:3000]}")  # v8: 从 1500 增加到 3000
                    if f.get('extracted_files'):
                        parts.append(f"binwalk 提取: {f['extracted_files'][:15]}")  # v8: 从 10 增加到 15
                    elf = f.get("elf_info") or {}
                    if elf:
                        for k, v in list(elf.items())[:8]:  # v8: 从 5 增加到 8
                            parts.append(f"[{k}] {str(v)[:300]}")  # v8: 从 200 增加到 300
                    if f.get("binwalk_signatures"):
                        parts.append(f"binwalk: {f['binwalk_signatures'][:8]}")  # v8: 从 5 增加到 8
                    if f.get("exif"):
                        exif_strs = []
                        for k, v in f["exif"].items():
                            if k in ("Comment", "Artist", "Copyright") or "flag" in str(v).lower():
                                exif_strs.append(f"{k}: {v}")
                        if exif_strs:
                            parts.append(f"EXIF: {exif_strs[:15]}")  # v8: 从 10 增加到 15
                    # v8: 添加 hash 信息
                    if f.get('hash_md5'):
                        parts.append(f"MD5: {f['hash_md5']}")
                    if f.get('hash_sha256'):
                        parts.append(f"SHA256: {f['hash_sha256']}")

        # v8: 增加历史长度
        if task.shell_history:
            parts.append("\n## 已执行的 Shell 命令")
            for i, h in enumerate(task.shell_history[-20:]):  # v8: 从 15 增加到 20
                cmd = h.get('command', '')
                stdout = (h.get('stdout') or '')[:2000]  # v8: 从 800 增加到 2000
                stderr = (h.get('stderr') or '')[:600]  # v8: 从 300 增加到 600
                exit_code = h.get('exit_code', '?')
                parts.append(f"### 命令 {i+1}: `{cmd}`")
                parts.append(f"exit_code={exit_code}")
                if stdout:
                    parts.append(f"stdout:\n```\n{stdout}\n```")
                if stderr:
                    parts.append(f"stderr:\n```\n{stderr}\n```")

        if task.script_runs:
            parts.append("\n## 已执行的脚本")
            for i, r in enumerate(task.script_runs[-10:]):  # v8: 从 5 增加到 10
                exit_code = r.get('exit_code', '?')
                stdout = (r.get('stdout') or '')[:2000]  # v8: 从 800 增加到 2000
                stderr = (r.get('stderr') or '')[:800]  # v8: 从 400 增加到 800
                parts.append(f"### 脚本运行 {i+1}: exit_code={exit_code}")
                if stdout:
                    parts.append(f"stdout:\n```\n{stdout}\n```")
                if stderr:
                    parts.append(f"stderr:\n```\n{stderr}\n```")

        if task.candidate_flags:
            parts.append("\n## 已发现的候选 flag")
            for c in task.candidate_flags[:10]:  # v8: 从 5 增加到 10
                parts.append(f"- {c['flag']} (confidence={c.get('confidence', '?')})")

        # v8: 添加假设账本
        hyps = self._hypotheses.get(task.task_id, [])
        if hyps:
            parts.append("\n## 当前假设")
            for h in hyps[:5]:
                parts.append(f"- [{h.get('name', '?')}] conf={h.get('confidence', '?')} next={h.get('next_test', '')}  evidence={h.get('evidence', [])[:3]}")

        # v8: 添加失败命令历史
        failed = self._get_failed_commands(task)
        if failed:
            parts.append("\n## 已失败的命令/方向（不要重复）")
            for fc in list(failed)[:15]:
                parts.append(f"- {fc[:100]}")

        # v8: 添加工具能力（如果有）
        tool_caps = self._get_tool_capabilities_cached()
        if tool_caps:
            parts.append("\n## 可用工具")
            for category, tools in tool_caps.items():
                parts.append(f"{category}: {', '.join(tools)}")

        parts.append("\n## 附件文件")
        if task.attachments:
            for a in task.attachments:
                basename = os.path.basename(a)
                if basename == "expected_flag.txt":
                    continue
                size = os.path.getsize(a) if os.path.isfile(a) else 0
                parts.append(f"- {basename} ({size}B)")

        return "\n".join(parts)

    def _run_shell(self, task: CtfTask) -> None:
        """v7: 执行 shell 命令，记录输出，回到 AGENT_THINK。"""
        if not task.shell_history:
            task.state = CtfState.AGENT_THINK
            return
        last_cmd = task.shell_history[-1].get("command", "")
        if not last_cmd:
            task.state = CtfState.AGENT_THINK
            return

        # Emit: 正在执行命令
        emit_agent_live(task.task_id, event_type="action", phase="RUN_SHELL",
                        title=f"⚡ 执行命令: `{last_cmd[:120]}`",
                        detail=f"正在执行 shell 命令，等待输出...",
                        code=last_cmd)

        try:
            from types import SimpleNamespace
            from app.core.agent_tool_gateway import AgentToolGateway
            ws = self._get_or_create_workspace(task)
            gateway = AgentToolGateway(task_id=task.task_id, workspace=ws, category=task.category_hint, authorized=task.authorized, allow_network=task.allow_network)
            stdout, stderr, success = gateway.execute("run_shell", {"command": last_cmd, "timeout": settings.CTF_SANDBOX_TIMEOUT})
            res = SimpleNamespace(exit_code=0 if success else 1, stdout=stdout, stderr=stderr, duration_ms=0, timed_out=False, success=success)
            task.shell_history[-1].update({
                "exit_code": res.exit_code,
                "stdout": res.stdout[:5000],
                "stderr": res.stderr[:2000],
                "duration_ms": res.duration_ms,
                "timed_out": res.timed_out,
            })
            self._record_evidence(
                task, "run_shell",
                f"cmd=`{last_cmd[:100]}` exit={res.exit_code} stdout={len(res.stdout)}B",
                artifacts={
                    "command": last_cmd,
                    "exit_code": res.exit_code,
                    "stdout": res.stdout[:2000],
                    "stderr": res.stderr[:500],
                    "timed_out": res.timed_out,
                },
                success=res.success,
            )
            # Emit: 命令执行结果
            stdout_preview = res.stdout[:2000] if res.stdout else "(无输出)"
            stderr_preview = res.stderr[:500] if res.stderr else ""
            result_detail = f"命令: `{last_cmd[:100]}`\n退出码: {res.exit_code}\n耗时: {res.duration_ms}ms"
            if stdout_preview:
                result_detail += f"\n\n--- stdout ---\n{stdout_preview}"
            if stderr_preview:
                result_detail += f"\n\n--- stderr ---\n{stderr_preview}"
            emit_agent_live(task.task_id, event_type="result", phase="RUN_SHELL",
                            title=f"⚡ 命令完成: exit={res.exit_code}",
                            detail=result_detail,
                            output=res.stdout[:3000],
                            success=res.success,
                            extra={"exit_code": res.exit_code, "duration_ms": res.duration_ms})
            try:
                self.blackboard.add_fact(
                    task_id=task.task_id, kind="clue",
                    content=f"shell: `{last_cmd[:80]}` => exit={res.exit_code}",
                    confidence=0.6, source_step="run_shell",
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("write shell fact failed: %s", e)
        except ValueError as e:
            task.shell_history[-1].update({
                "exit_code": -1, "stdout": "", "stderr": str(e), "duration_ms": 0,
            })
            self._record_evidence(task, "run_shell", f"命令被沙箱拒绝: {e}", success=False)
        except Exception as e:  # noqa: BLE001
            task.shell_history[-1].update({
                "exit_code": -1, "stdout": "", "stderr": str(e), "duration_ms": 0,
            })
            self._record_evidence(task, "run_shell", f"执行失败: {type(e).__name__}: {e}", success=False)

        task.state = CtfState.AGENT_THINK

    def _get_or_create_workspace(self, task: CtfTask) -> str:
        if not hasattr(task, '_workspace') or not task._workspace:
            ws = self.sandbox.create_workspace(prefix=f"{task.task_id}_")
            for a in task.attachments:
                base = os.path.basename(a)
                if base == "expected_flag.txt":
                    continue
                try:
                    dst = os.path.join(ws, base)
                    if not os.path.exists(dst):
                        shutil.copy2(a, dst)
                except Exception:
                    pass
            task._workspace = ws
        return task._workspace

    # ---------- original steps (保留兼容) ----------

    def _generate_script(self, task: CtfTask) -> None:
        """保留兼容：mock 模式走这条路径。"""
        emit_agent_live(task.task_id, event_type="thinking", phase="GENERATE_SCRIPT",
                        title="🐍 正在生成解题脚本...",
                        detail="根据文件分析结果，让 LLM 生成 Python 解题脚本")
        file_clues = ""
        if task.analysis:
            files = task.analysis.get("files", [])[:8]
            for f in files:
                basename = os.path.basename(f.get('relative_path', ''))
                file_clues += (
                    f"\n=== {basename} ===\n"
                    f"类型: {f.get('type','')} | 大小: {f.get('size',0)}B | MIME: {f.get('mime','')}\n"
                )
                if f.get("suspicious_strings"):
                    file_clues += f"可疑字符串: {f['suspicious_strings'][:5]}\n"
                if f.get("flags_found"):
                    file_clues += f"已发现 flag 候选: {f['flags_found'][:5]}\n"
                elf = f.get("elf_info") or {}
                if elf:
                    for k, v in elf.items():
                        file_clues += f"[{k}] {str(v)[:200]}\n"
                if f.get("binwalk_signatures"):
                    file_clues += f"binwalk: {f['binwalk_signatures'][:5]}\n"
                if f.get("extracted_files"):
                    file_clues += f"binwalk 提取: {f['extracted_files'][:10]}\n"
                preview = f.get("content_preview", "")
                if preview:
                    max_preview = 2000
                    if len(preview) > max_preview:
                        file_clues += f"\n--- 内容预览 (截断到 {max_preview} 字符) ---\n{preview[:max_preview]}\n--- 预览结束 ---\n"
                    else:
                        file_clues += f"\n--- 内容预览 ---\n{preview}\n--- 预览结束 ---\n"
                else:
                    file_clues += "（无内容预览）\n"
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

        if task.candidate_flags and any(c.get("confidence", 0) >= 0.7 for c in task.candidate_flags):
            self.cost_accounting.record_static_only(
                task_id=task.task_id, step="generate_script",
                reason="static_candidate_high_confidence",
            )
            task.current_script = self._fallback_script(task)
            self._record_evidence(
                task, "generate_script",
                f"静态分析已发现高置信候选 flag {len(task.candidate_flags)} 个，跳过 LLM",
                artifacts={"static_only": True},
            )
            task.state = CtfState.RUN_SCRIPT
            return

        route = self._route_decision(task, "generate_script")
        if route.lane == "stop":
            task.state = CtfState.HUMAN_REQUIRED
            task.error = "预算耗尽，转入人工接管"
            return

        # v8: route-aware LLM for script generation
        adapter = get_route_adapter(route)
        self._last_route_models[task.task_id] = f"{route.lane}:{route.model}"

        prompt = (
            f"题型: {task.plan.category if task.plan else 'unknown'}\n"
            f"题面: {task.description[:2000]}\n"  # v8: 从 800 扩大到 2000
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
        )
        messages = [{"role": "user", "content": prompt}]
        resp = adapter.chat(
            messages,
            system_prompt=sys,
            max_tokens=route.max_tokens,
            temperature=route.temperature,
        )
        self._record_llm_cost(task, "generate_script", resp, route, messages)
        if not resp.success or not resp.content:
            script = self._fallback_script(task)
            task.current_script = script
            self._record_evidence(
                task, "generate_script",
                f"LLM 失败({resp.error})，使用兜底脚本",
                success=False,
            )
        else:
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
            emit_agent_live(task.task_id, event_type="result", phase="GENERATE_SCRIPT",
                            title=f"🐍 脚本生成完成 ({len(content.splitlines())} 行)",
                            detail=f"模型: {route.model} ({route.lane})\n脚本预览:",
                            code=content[:3000],
                            success=resp.success)
        task.state = CtfState.RUN_SCRIPT

    def _run_script(self, task: CtfTask) -> None:
        if not task.current_script:
            task.state = CtfState.GENERATE_SCRIPT
            return
        # Emit: 正在执行脚本
        script_preview = task.current_script[:500]
        emit_agent_live(task.task_id, event_type="action", phase="RUN_SCRIPT",
                        title="🐍 正在执行 Python 脚本...",
                        detail=f"脚本预览:\n{script_preview}",
                        code=task.current_script[:5000])
        try:
            ws = self._get_or_create_workspace(task)
            from app.core.agent_tool_gateway import AgentToolGateway
            gateway = AgentToolGateway(task_id=task.task_id, workspace=ws, category=task.category_hint, authorized=task.authorized, allow_network=task.allow_network)
            stdout, stderr, success = gateway.execute("run_python", {"code": task.current_script, "filename": "solve.py", "timeout": settings.CTF_SANDBOX_TIMEOUT})
            run_record = {"success": success, "exit_code": 0 if success else 1, "stdout": stdout, "stderr": stderr, "duration_ms": 0, "timed_out": False, "workdir": ws}
            from types import SimpleNamespace
            res = SimpleNamespace(**run_record)
            run_index = len(task.script_runs)
            run_record["run_index"] = run_index
            task.script_runs.append(run_record)
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
            # Emit: 脚本执行结果
            stdout_preview = res.stdout[:2000] if res.stdout else "(无输出)"
            stderr_preview = res.stderr[:500] if res.stderr else ""
            result_detail = f"退出码: {res.exit_code}\n耗时: {res.duration_ms}ms"
            if stdout_preview:
                result_detail += f"\n\n--- stdout ---\n{stdout_preview}"
            if stderr_preview:
                result_detail += f"\n\n--- stderr ---\n{stderr_preview}"
            emit_agent_live(task.task_id, event_type="result", phase="RUN_SCRIPT",
                            title=f"🐍 脚本执行完成: exit={res.exit_code}",
                            detail=result_detail,
                            output=res.stdout[:3000],
                            success=res.success,
                            extra={"exit_code": res.exit_code, "duration_ms": res.duration_ms})
            if res.success:
                task.state = CtfState.VERIFY_FLAG
            else:
                task.state = CtfState.REFLECT_ERROR
        except ValueError as e:
            self._record_evidence(task, "run_script", f"脚本被沙箱拒绝: {e}", success=False)
            task.error = str(e)
            task.state = CtfState.FAILED
        except Exception as e:  # noqa: BLE001
            self._record_evidence(task, "run_script", f"执行失败: {type(e).__name__}: {e}", success=False)
            task.state = CtfState.REFLECT_ERROR

    def _reflect_error(self, task: CtfTask) -> None:
        if not task.script_runs:
            task.state = CtfState.GENERATE_SCRIPT
            return
        last = task.script_runs[-1]
        stderr = (last.get("stderr") or "")[:800]
        stdout = (last.get("stdout") or "")[:400]

        emit_agent_live(task.task_id, event_type="error", phase="REFLECT_ERROR",
                        title="🔧 脚本执行出错，正在反思修复...",
                        detail=f"错误归因分析中...\nstderr: {stderr[:300]}")

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
        if "ValueError" in stderr or "Error" in stderr:
            self._repeated_error_counts[task.task_id] = self._repeated_error_counts.get(task.task_id, 0) + 1
        try:
            self.blackboard.add_fact(
                task_id=task.task_id, kind="error",
                content=f"[{attribution.level}] {attribution.root_cause}",
                confidence=0.7, source_step="reflect_error",
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("write attribution fact failed: %s", e)

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

        # v8: route-aware LLM for reflect_error
        adapter = get_route_adapter(route)
        self._last_route_models[task.task_id] = f"{route.lane}:{route.model}"

        compressed_stderr = compress_tool_output(stderr, max_chars=1000)
        stderr_snippet = "\n".join(compressed_stderr.facts[:20]) or stderr[:500]

        prompt = (
            f"上次执行失败（归因 {attribution.level}）：\n"
            f"失败原因: {attribution.root_cause}\n"
            f"修复策略: {attribution.fix_strategy}\n"
            f"最小修复点: {attribution.minimal_patch_hint}\n"
            f"stderr:\n{stderr_snippet}\n"
            f"stdout:\n{stdout[:200]}\n"
            f"当前脚本:\n{task.current_script[:2000]}\n"  # v8: 从 1200 扩大到 2000
            "请修复脚本中的错误，输出修正后的完整脚本（纯 Python，不要 markdown 围栏）。"
        )
        messages = [{"role": "user", "content": prompt}]
        resp = adapter.chat(
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
            emit_agent_live(task.task_id, event_type="result", phase="REFLECT_ERROR",
                            title=f"🔧 脚本已修复 (归因 {attribution.level})",
                            detail=f"根因: {attribution.root_cause}\n修复策略: {attribution.fix_strategy}\n\n修复后脚本:",
                            code=content[:3000],
                            success=True,
                            extra={"attribution": attribution.to_dict()})
            task.state = CtfState.RUN_SCRIPT
        else:
            self._record_evidence(
                task, "reflect_error",
                f"LLM 修复失败: {resp.error}",
                artifacts={"attribution": attribution.to_dict()},
                success=False,
            )
            task.state = CtfState.VERIFY_FLAG

    def _verify_flag(self, task: CtfTask) -> None:
        emit_agent_live(task.task_id, event_type="thinking", phase="VERIFY_FLAG",
                        title="🔍 正在验证候选 Flag...",
                        detail=f"从执行输出和文件中提取并验证候选 flag")
        stdout_text = ""
        stderr_text = ""
        for r in reversed(task.script_runs):
            stdout_text = (r.get("stdout") or "")
            stderr_text = (r.get("stderr") or "")
            if stdout_text:
                break
        # 也检查 shell 历史
        if not stdout_text:
            for h in reversed(task.shell_history):
                stdout_text = (h.get("stdout") or "")
                if stdout_text:
                    break

        safe_attachments = [a for a in task.attachments if os.path.basename(a) != "expected_flag.txt"]
        verify = self.verifier.verify(
            stdout=stdout_text,
            stderr=stderr_text,
            files=safe_attachments,
            expected_flag=None,
            flag_format_regex=task.flag_format,
        )
        existing = {c["flag"] for c in task.candidate_flags}
        for c in verify.candidates:
            if c.flag not in existing:
                cd = c.to_dict()
                task.candidate_flags.append(cd)
                existing.add(c.flag)
                try:
                    upsert_flag(task.task_id, cd)
                except Exception as e:  # noqa: BLE001
                    logger.warning("persist flag failed: %s", e)
                try:
                    self.blackboard.add_fact(
                        task_id=task.task_id, kind="candidate",
                        content=c.flag, confidence=c.confidence,
                        source_step="verify_flag",
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("write candidate fact failed: %s", e)
        task.candidate_flags.sort(key=lambda c: -c.get("confidence", 0.5))
        task.best_flag = task.candidate_flags[0]["flag"] if task.candidate_flags else None
        # v8: 找到 flag 时重置 no-flag streak
        if task.best_flag:
            self._no_flag_continue_streak[task.task_id] = 0
        self._record_evidence(
            task, "verify_flag",
            f"提取到 {len(task.candidate_flags)} 个候选 flag，best={task.best_flag}",
            artifacts={"best_flag": task.best_flag, "candidates": task.candidate_flags[:5]},
            success=bool(task.best_flag),
        )
        if task.best_flag:
            emit_agent_live(task.task_id, event_type="flag", phase="VERIFY_FLAG",
                            title=f"🎯 找到 Flag!",
                            detail=f"最佳候选: {task.best_flag}\n共 {len(task.candidate_flags)} 个候选",
                            success=True)
            task.state = CtfState.GENERATE_WRITEUP
        else:
            emit_agent_live(task.task_id, event_type="result", phase="VERIFY_FLAG",
                            title="🔍 未找到有效 Flag，继续探索",
                            detail=f"提取了 {len(task.candidate_flags)} 个候选但均不满足格式要求，回到 Agent 思考",
                            success=False)
            # v8: 关键修复 — 没找到 flag 不能直接进 GENERATE_WRITEUP → HUMAN_REQUIRED
            # 只要有时间/预算且不是连续无进展，就回到 AGENT_THINK 继续探索
            streak = self._no_flag_continue_streak.get(task.task_id, 0) + 1
            self._no_flag_continue_streak[task.task_id] = streak
            max_no_flag_streak = 5  # 连续 5 次无新 flag 才停
            is_mock = bool(getattr(self.llm, "mock_mode", False)) or not getattr(self.llm, "enabled", True)
            timed_out = task.started_at and (time.time() - task.started_at) > task.max_time_sec * 0.95
            budget_exceeded = self.cost_accounting.is_budget_exceeded(task.task_id)

            if (streak < max_no_flag_streak
                and not timed_out
                and not budget_exceeded
                and not is_mock):
                # 有新证据（shell/script 输出已作为 evidence），继续探索
                task.state = CtfState.AGENT_THINK
                emit_agent_live(task.task_id, event_type="info", phase="VERIFY_FLAG",
                                title="🔄 继续 Agent 探索",
                                detail=f"无 flag 连续 {streak} 次，上限 {max_no_flag_streak}，回到 AGENT_THINK",
                                success=False)
            else:
                # 真正无法继续：超时/超预算/连续无进展/mock
                task.state = CtfState.GENERATE_WRITEUP

    def _generate_writeup(self, task: CtfTask) -> None:
        emit_agent_live(task.task_id, event_type="thinking", phase="GENERATE_WRITEUP",
                        title="📝 正在生成解题报告...",
                        detail="根据解题过程生成 Writeup")
        try:
            md = self.writeup.generate(task)
            task.writeup_md = md
            try:
                save_writeup(task.task_id, md)
            except Exception as e:  # noqa: BLE001
                logger.warning("persist writeup failed: %s", e)
            self._record_evidence(
                task, "generate_writeup",
                f"生成 WP {len(md)} 字符",
                artifacts={"length": len(md)},
            )
            emit_agent_live(task.task_id, event_type="result", phase="GENERATE_WRITEUP",
                            title="📝 解题报告已生成",
                            detail=f"Writeup {len(md)} 字符已生成",
                            success=True)
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

    def _write_file_facts_to_blackboard(self, task: CtfTask, summary: Dict[str, Any]) -> None:
        try:
            for f in (summary.get("files") or [])[:10]:
                content = f"file={f.get('relative_path')} type={f.get('type')} size={f.get('size')}"
                self.blackboard.add_fact(
                    task_id=task.task_id, kind="file",
                    content=content, confidence=0.7,
                    source_step="analyze_files",
                )
                for s in (f.get("suspicious_strings") or [])[:5]:
                    self.blackboard.add_fact(
                        task_id=task.task_id, kind="clue",
                        content=f"suspicious: {s}", confidence=0.6,
                        source_step="analyze_files",
                    )
            for c in task.candidate_flags:
                self.blackboard.add_fact(
                    task_id=task.task_id, kind="candidate",
                    content=c["flag"], confidence=c.get("confidence", 0.7),
                    source_step="analyze_files",
                    evidence_ref=c.get("source"),
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("write file facts to blackboard failed: %s", e)

    def _run_observer_pre_check(self, task: CtfTask, rounds_cap: int) -> None:
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
            if advice.advice and advice.advice != "状态正常，继续推进":
                self.blackboard.add_hint(
                    task_id=task.task_id,
                    content=advice.advice,
                    source="observer",
                )
            if advice.should_stop and not task.candidate_flags:
                task.state = CtfState.HUMAN_REQUIRED
                task.error = f"Observer 建议停止: {advice.advice}"
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("observer pre-check failed: %s", e)

    def _post_step_blackboard(self, task: CtfTask) -> None:
        try:
            if task.evidence:
                last = task.evidence[-1]
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

    def _route_decision(self, task: CtfTask, step: str, force_expert: bool = False) -> RouteDecision:
        repeated = self._repeated_error_counts.get(task.task_id, 0)
        analysis_chars = len(str(task.analysis or "")) if task.analysis else 0
        # v8: hard mode 下 reverse/crypto/pwn/forensics 直接 expert
        category = (task.plan.category if task.plan else "") or task.category_hint or ""
        hard_categories = {"reverse", "crypto", "pwn", "forensics"}
        if settings.CTF_HARD_MODE and category in hard_categories and step in ("agent_think", "generate_script"):
            force_expert = True
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
            force_expert=force_expert,
        )

    def _record_llm_cost(
        self,
        task: CtfTask,
        step: str,
        resp,
        route: RouteDecision,
        messages: List[Dict[str, str]],
    ) -> None:
        try:
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
        try:
            append_event(task.task_id, item.to_dict())
        except Exception as e:  # noqa: BLE001
            logger.warning("persist event failed: %s", e)

    def _default_tools_for(self, category: str) -> List[str]:
        m = {
            "web": ["http_fingerprint", "directory_probe", "js_interface_extractor"],
            "crypto": ["strings", "python_solver", "sage"],
            "reverse": ["file", "strings", "readelf", "objdump", "ghidra_headless",
                        "pyinstxtractor", "python3", "pip3"],
            "pwn": ["checksec", "readelf", "objdump", "pwntools"],
            "misc": ["file", "strings", "binwalk", "exiftool"],
            "forensics": ["tshark", "volatility", "strings", "binwalk"],
        }
        return m.get(category, ["file", "strings", "binwalk"])

    def _default_plan_for(self, category: str) -> List[str]:
        m = {
            "web": ["1. 指纹识别", "2. 目录扫描", "3. JS 接口提取", "4. 漏洞利用"],
            "crypto": ["1. 分析密文特征", "2. 尝试常见算法", "3. 编写解题脚本"],
            "reverse": ["1. file 识别类型", "2. strings 提取", "3. 检查 PyInstaller/UPX",
                        "4. 反汇编/解包", "5. 还原算法"],
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
            if lower.endswith((".exe", ".dll", ".pyd")):
                return "reverse"
        return "misc"

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
            "pyinstaller", "cython", "pyd", "brainfuck",
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
        best = max(scores.items(), key=lambda x: x[1])
        return best[0]

    def _fallback_script(self, task: CtfTask) -> str:
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

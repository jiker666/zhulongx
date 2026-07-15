"""
Experimental CC Bridge Runtime for explicit compatibility research only.

This bridge intentionally keeps the public AgentRuntime surface used by
CtfOrchestrator (turns / ledger / candidate_flags / best_flag / state / error),
while delegating the solve loop to an external Claude Code CLI when available.
It is not imported by formal APIs. Compatibility fallback requires a dedicated
opt-in flag and is disabled by default.
"""
from __future__ import annotations

import os
import re
import signal
import shlex
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from app.config import settings
from app.core.agent_runtime import AgentRuntime, ToolExecutionRecord
from app.core.flag_verifier import FlagCandidate, FlagVerifier
from app.core.tool_protocol import AgentTurn, ToolObservation, ToolSpec, make_tool_call
from app.core.ws_manager import emit_agent_live


class CcBridgeUnavailable(RuntimeError):
    """Raised when no executable Claude Code bridge can be resolved."""


class CcBridgeRuntime:
    """Claude Code backed runtime with AgentRuntime-compatible trace fields."""

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
        verifier: Optional[FlagVerifier] = None,
        fallback_runtime: Optional[AgentRuntime] = None,
    ) -> None:
        self.task_id = task_id
        self.workspace = os.path.abspath(workspace)
        self.title = title
        self.description = description
        self.category = category
        self.flag_format = flag_format
        self.attachments = attachments or []
        self.allow_network = bool(allow_network and authorized)
        self.authorized = authorized
        self.max_turns = max_turns
        self.max_time_sec = max_time_sec
        self.verifier = verifier or FlagVerifier()
        self.fallback_runtime = fallback_runtime

        self.turns: List[AgentTurn] = []
        self.ledger: List[ToolExecutionRecord] = []
        self.candidate_flags: List[Dict[str, Any]] = []
        self.best_flag: Optional[str] = None
        self.state: str = "running"
        self.error: str = ""
        self.started_at: Optional[float] = None
        self._tool_specs: Dict[str, ToolSpec] = {}
        self._skills_text: str = ""
        self._process_lock = threading.Lock()
        self._process: Optional[subprocess.Popen[str]] = None
        self._abort_event = threading.Event()

    def register_tool(self, spec: ToolSpec) -> None:
        self._tool_specs[spec.name] = spec
        if self.fallback_runtime:
            self.fallback_runtime.register_tool(spec)

    def load_skills(self, skills_text: str) -> None:
        self._skills_text = skills_text or ""
        if self.fallback_runtime:
            self.fallback_runtime.load_skills(skills_text)

    def abort(self, reason: str = "用户手动停止") -> None:
        self._abort_event.set()
        self.state = "human_required"
        self.error = reason
        if self.fallback_runtime:
            self.fallback_runtime.abort(reason)
        with self._process_lock:
            proc = self._process
        if proc is not None and proc.poll() is None:
            try:
                if os.name == "posix":
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                else:
                    proc.terminate()
                proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                if os.name == "posix":
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                else:
                    proc.kill()
            except ProcessLookupError:
                pass

    def run(self) -> str:
        self.started_at = time.time()
        if not getattr(settings, "CC_RUNTIME_ENABLED", False):
            return self._run_fallback("CC_RUNTIME_ENABLED=false")

        try:
            return self._run_external_cc()
        except CcBridgeUnavailable as exc:
            if getattr(settings, "CC_RUNTIME_REQUIRE_EXTERNAL", False):
                self.state = "human_required"
                self.error = str(exc)
                self._record_cli_turn(output="", error=self.error, success=False, duration_ms=0)
                return self.state
            return self._run_fallback(str(exc))
        except subprocess.TimeoutExpired as exc:
            self.state = "human_required"
            self.error = f"Claude Code 超时 {self.max_time_sec}s"
            output = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
            error = (exc.stderr or "") if isinstance(exc.stderr, str) else self.error
            self._record_cli_turn(output=output, error=error, success=False, duration_ms=self.max_time_sec * 1000)
            return self.state
        except Exception as exc:  # noqa: BLE001 - bridge must not crash the API worker
            if getattr(settings, "CC_RUNTIME_REQUIRE_EXTERNAL", False):
                self.state = "human_required"
                self.error = f"Claude Code bridge failed: {type(exc).__name__}: {exc}"
                self._record_cli_turn(output="", error=self.error, success=False, duration_ms=0)
                return self.state
            return self._run_fallback(f"Claude Code bridge failed: {type(exc).__name__}: {exc}")

    def _run_external_cc(self) -> str:
        command = self._resolve_command()
        prompt = self._build_prompt()
        prompt_file = Path(self.workspace) / ".zhulongx_cc_prompt.md"
        prompt_file.write_text(prompt, encoding="utf-8")

        final_command = self._materialize_command(command, prompt, str(prompt_file))
        emit_agent_live(
            self.task_id,
            event_type="info",
            phase="CC_BRIDGE",
            title="启动 Claude Code 编排核心",
            detail=f"cwd={self.workspace}\ncmd={self._redact_cmd(final_command)}",
        )

        started = time.time()
        env = os.environ.copy()
        env.setdefault("ZHULONGX_CC_BRIDGE", "1")
        env.setdefault("ZHULONGX_TASK_ID", self.task_id)
        env.setdefault("ZHULONGX_ALLOW_NETWORK", "1" if self.allow_network else "0")
        proc = subprocess.Popen(
            final_command,
            cwd=self.workspace,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=(os.name == "posix"),
        )
        with self._process_lock:
            self._process = proc
        try:
            timeout_seconds = min(self.max_time_sec, int(getattr(settings, "CC_RUNTIME_TIMEOUT", self.max_time_sec)))
            try:
                stdout, stderr = proc.communicate(timeout=timeout_seconds)
            except subprocess.TimeoutExpired as exc:
                self.abort(f"Claude Code 超时 {timeout_seconds}s")
                stdout, stderr = proc.communicate(timeout=1)
                exc.stdout = stdout
                exc.stderr = stderr
                raise
        finally:
            with self._process_lock:
                self._process = None
        duration_ms = int((time.time() - started) * 1000)
        output = (stdout or "")[-int(getattr(settings, "CC_RUNTIME_MAX_OUTPUT_CHARS", 120000)):]
        error = (stderr or "")[-20000:]
        success = proc.returncode == 0
        self._record_cli_turn(output=output, error=error, success=success, duration_ms=duration_ms)
        self._extract_candidates(output + "\n" + error)

        if self.best_flag:
            self.state = "done"
        else:
            self.state = "human_required"
            self.error = (
                "Claude Code 已运行但没有产出可验证 flag；请查看 workspace 里的 .zhulongx_cc_prompt.md "
                "和本次 CC_BRIDGE observation。"
            ) if success else f"Claude Code CLI 退出码非 0，stderr: {error[:500]}"
        return self.state

    def _resolve_command(self) -> Sequence[str]:
        template = getattr(settings, "CC_RUNTIME_COMMAND_TEMPLATE", "") or ""
        if template.strip():
            return ["__TEMPLATE__", template]

        configured = getattr(settings, "CC_RUNTIME_BIN", "") or ""
        if configured.strip():
            parts = shlex.split(configured)
            if parts:
                return parts

        path_bin = shutil.which("claude")
        if path_bin:
            return [path_bin]

        vendor_dir = self._vendor_dir()
        dist_cli = vendor_dir / "dist" / "cli.js"
        if dist_cli.is_file():
            node = shutil.which("node")
            if not node:
                raise CcBridgeUnavailable("找到 vendor/claude-code/dist/cli.js，但系统没有 node")
            return [node, str(dist_cli)]

        raise CcBridgeUnavailable(
            "未找到可执行 Claude Code：请先在 backend/vendor/claude-code 运行 bun install && bun run build，"
            "或设置 CC_RUNTIME_BIN / CC_RUNTIME_COMMAND_TEMPLATE。"
        )

    def _materialize_command(self, base: Sequence[str], prompt: str, prompt_file: str) -> List[str]:
        if base and base[0] == "__TEMPLATE__":
            values = {
                "prompt_file": prompt_file,
                "prompt_file_q": shlex.quote(prompt_file),
                "workspace": self.workspace,
                "workspace_q": shlex.quote(self.workspace),
                "max_time_sec": str(self.max_time_sec),
            }
            return shlex.split(base[1].format(**values))

        # Claude Code print mode. The unofficial recovered CLI follows the same launcher shape.
        args = list(base)
        if getattr(settings, "CC_RUNTIME_SKIP_PERMISSIONS", False):
            args.extend(["--dangerously-skip-permissions"])
        args.extend(["-p", prompt])
        return args

    def _build_prompt(self) -> str:
        files = []
        for a in self.attachments:
            name = os.path.basename(a)
            try:
                size = os.path.getsize(a)
            except OSError:
                size = 0
            files.append(f"- {name} ({size}B)")
        tool_names = ", ".join(sorted(self._tool_specs)) or "Claude Code built-in tools"
        network_rule = (
            "允许访问题目授权范围内的远程服务。" if self.allow_network else
            "禁止主动联网；只分析当前 workspace 内的附件和本地文件。"
        )
        return (
            "# ZHULONG-X / Claude Code CTF Solve Task\n\n"
            "你现在是烛龙·玄枢的主编排核心，直接使用 Claude Code 的文件、shell、编辑、搜索能力解 CTF。\n"
            "不要只给思路，必须在 workspace 中实际检查文件、写脚本、运行验证。\n\n"
            "## 任务\n"
            f"标题: {self.title}\n"
            f"题型: {self.category}\n"
            f"题面:\n{self.description[:6000]}\n\n"
            f"flag 格式: {self.flag_format or '常见 flag{...}/CTF{...}/SCTF{...}/key{...}，以题面为准'}\n"
            f"最大时间: {self.max_time_sec}s\n"
            f"网络策略: {network_rule}\n\n"
            "## 附件\n"
            f"{chr(10).join(files) if files else '- 无'}\n\n"
            "## 可参考的 ZHULONG-X 工具层\n"
            f"{tool_names}\n\n"
            "## 解题技能参考\n"
            f"{self._skills_text[:5000] if self._skills_text else '无'}\n\n"
            "## 工作要求\n"
            "1. 先列目录和识别附件类型，再选择最短可验证路径。\n"
            "2. 需要脚本时在 workspace 写 solve.py / solve_* 文件并运行。\n"
            "3. 不要覆盖原始附件；可创建 extracted/、work/、notes.md。\n"
            "4. 没有证据不要猜 flag。\n"
            "5. 找到 flag 后，最后单独输出一行：FINAL_FLAG: <flag>\n"
            "6. 如果失败，输出已尝试路径、关键证据和下一步建议。\n"
        )

    def _extract_candidates(self, text: str) -> None:
        candidates = self.verifier.extract_from_text(text, source="claude_code_cli")
        # Support explicit final line even when custom flag regex is wider than defaults.
        for match in re.finditer(r"(?im)^\s*FINAL_FLAG\s*[:：]\s*(\S+)\s*$", text or ""):
            raw = match.group(1).strip()
            if raw and not any(c.flag == raw for c in candidates):
                candidates.append(FlagCandidate(
                    flag=raw,
                    source="claude_code_cli",
                    line=None,
                    snippet="FINAL_FLAG",
                    confidence=0.95,
                    matched_pattern="FINAL_FLAG",
                ))
        seen = {c.get("flag") for c in self.candidate_flags}
        for cand in candidates:
            flag = cand.flag
            if self.flag_format:
                try:
                    if not re.search(self.flag_format, flag):
                        continue
                except re.error:
                    pass
            if flag not in seen:
                self.candidate_flags.append({
                    "flag": flag,
                    "source": "claude_code_cli",
                    "confidence": getattr(cand, "confidence", 0.8),
                    "evidence": getattr(cand, "snippet", "")[:200],
                })
                seen.add(flag)
        self.candidate_flags.sort(key=lambda c: -float(c.get("confidence", 0.5)))
        if self.candidate_flags:
            self.best_flag = self.candidate_flags[0]["flag"]

    def _record_cli_turn(self, *, output: str, error: str, success: bool, duration_ms: int) -> None:
        output_limit = int(getattr(settings, "CC_RUNTIME_MAX_OUTPUT_CHARS", 120000))
        visible_output = (output or "")[-output_limit:]
        tc = make_tool_call("claude_code_cli", {"workspace": self.workspace, "mode": "cc_bridge"})
        obs = ToolObservation(
            tool_call_id=tc.id,
            tool_name="claude_code_cli",
            success=success,
            output=visible_output[:6000],
            error=(error or "")[:2000],
            duration_ms=duration_ms,
            truncated=len(visible_output) > 6000,
        )
        self.turns.append(AgentTurn(
            turn_index=len(self.turns),
            model="claude-code-bridge",
            input_summary=f"CC bridge workspace={self.workspace}",
            tool_calls=[tc],
            observations=[obs],
            final_answer=self.best_flag or "",
        ))
        self.ledger.append(ToolExecutionRecord(
            tool_call_id=tc.id,
            tool_name="claude_code_cli",
            arguments={"workspace": self.workspace},
            success=success,
            output=visible_output,
            error=(error or "")[:500],
            duration_ms=duration_ms,
            truncated=len(visible_output) > 6000,
            timestamp=time.time(),
        ))
        emit_agent_live(
            self.task_id,
            event_type="result",
            phase="CC_BRIDGE",
            title="Claude Code 编排结果",
            detail=f"success={success} duration={duration_ms}ms\n{visible_output[:2000]}",
            output=visible_output[:3000],
            success=success,
        )

    def _run_fallback(self, reason: str) -> str:
        if not getattr(settings, "CC_RUNTIME_FALLBACK_INTERNAL", False) or self.fallback_runtime is None:
            self.state = "human_required"
            self.error = f"CC bridge 不可用，且未启用内部回退: {reason}"
            self._record_cli_turn(output="", error=self.error, success=False, duration_ms=0)
            return self.state
        emit_agent_live(
            self.task_id,
            event_type="warning",
            phase="CC_BRIDGE",
            title="Claude Code 不可用，回退到内部 AgentRuntime",
            detail=reason,
        )
        state = self.fallback_runtime.run()
        self.turns = self.fallback_runtime.turns
        self.ledger = self.fallback_runtime.ledger
        self.candidate_flags = self.fallback_runtime.candidate_flags
        self.best_flag = self.fallback_runtime.best_flag
        self.state = self.fallback_runtime.state
        self.error = self.fallback_runtime.error
        return state

    def _vendor_dir(self) -> Path:
        configured = getattr(settings, "CC_RUNTIME_VENDOR_DIR", "") or ""
        if configured:
            path = Path(configured)
            if path.is_absolute():
                return path
            cwd_path = Path.cwd() / path
            if cwd_path.exists():
                return cwd_path
            backend_path = Path(__file__).resolve().parents[2] / path
            if backend_path.exists():
                return backend_path
            return cwd_path
        return Path(__file__).resolve().parents[2] / "vendor" / "claude-code"

    @staticmethod
    def _redact_cmd(cmd: Sequence[str]) -> str:
        joined = " ".join(shlex.quote(str(x)) for x in cmd)
        joined = re.sub(r"sk-[A-Za-z0-9_\-]{8,}", "sk-****", joined)
        return joined[:2000]

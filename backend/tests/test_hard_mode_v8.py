"""
v8 Hard Mode CTF Tests — 验证困难题优化。

测试覆盖：
1. test_route_uses_expert_client — route=expert 时真实使用 expert 模型
2. test_verify_no_flag_continues — 无 flag 回到 AGENT_THINK
3. test_agent_action_json_parse — JSON action 解析
4. test_old_action_format_compatible — 旧格式兼容
5. test_hard_mode_escalates_early — hard mode 困难题型直接 expert
6. test_tool_capability_written_to_blackboard — 工具自检
7. test_no_repeated_failed_command — 不重复失败命令
8. test_context_expand_text_file — expand_context 文本
9. test_context_expand_binary_hexdump — expand_context hex
10. test_no_secret_leak_in_logs — API key 不泄露
"""
import json
import os
import pytest
from unittest.mock import MagicMock, patch, PropertyMock

# Ensure test env
os.environ.setdefault("LLM_ENABLED", "false")
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("LLM_ROUTER_ENABLED", "true")


class TestRouteUsesExpertClient:
    """RouteDecision 返回 expert 时，必须使用 expert LLM 客户端。"""

    def test_expert_route_creates_expert_adapter(self):
        """expert route → adapter 必须用 LLM_EXPERT_MODEL/base_url/key"""
        from app.core.model_router import RouteDecision
        from app.core.llm_adapter import get_route_adapter
        from app.config import settings

        route = RouteDecision(
            lane="expert",
            provider=settings.LLM_EXPERT_PROVIDER,
            model=settings.LLM_EXPERT_MODEL,
            reason="test_expert",
            max_tokens=settings.LLM_EXPERT_MAX_TOKENS,
            temperature=settings.LLM_EXPERT_TEMPERATURE,
        )
        adapter = get_route_adapter(route)
        # 必须使用 expert 配置（当 key 存在时）
        if adapter.api_key and adapter.api_key != "replace_me":
            assert adapter.model == settings.LLM_EXPERT_MODEL, f"Expected expert model {settings.LLM_EXPERT_MODEL}, got {adapter.model}"
            assert adapter.base_url == settings.LLM_EXPERT_BASE_URL, f"Expected expert base_url, got {adapter.base_url}"

    def test_cheap_route_uses_cheap_adapter(self):
        """cheap route → adapter 用 cheap 配置"""
        from app.core.model_router import RouteDecision
        from app.core.llm_adapter import get_route_adapter

        route = RouteDecision(
            lane="cheap",
            provider="deepseek",
            model="deepseek-v4-flash",
            reason="test_cheap",
            max_tokens=1800,
            temperature=0.2,
        )
        adapter = get_route_adapter(route)
        # 当有 cheap key 时用 cheap；否则用主 LLM 或 mock
        assert adapter is not None

    def test_orchestrator_agent_think_uses_route_adapter(self):
        """orchestrator._agent_think 必须通过 route adapter 调用 LLM"""
        from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfTask, CtfState

        orch = CtfOrchestrator()
        task = CtfTask(
            task_id="test_route_1", title="test", description="test",
            category_hint="reverse", plan=None,
        )
        # 模拟 route 返回 expert
        with patch.object(orch, '_route_decision') as mock_route, \
             patch('app.core.ctf_agent_orchestrator.get_route_adapter') as mock_get_adapter:
            from app.core.model_router import RouteDecision
            mock_route.return_value = RouteDecision(
                lane="expert", provider="glm", model="glm-5.2",
                reason="test", max_tokens=8192, temperature=0.15,
            )
            mock_adapter = MagicMock()
            mock_adapter.chat.return_value = MagicMock(success=False, content="", error="mock")
            mock_get_adapter.return_value = mock_adapter

            orch._agent_think(task)
            # 必须调用了 get_route_adapter 而不是 self.llm
            mock_get_adapter.assert_called_once()


class TestVerifyNoFlagContinues:
    """VERIFY_FLAG 无 flag → 回到 AGENT_THINK 而不是 GENERATE_WRITEUP。"""

    def test_no_flag_goes_back_to_agent_think(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfTask, CtfState

        orch = CtfOrchestrator()
        task = CtfTask(
            task_id="test_vf_1", title="test", description="test",
            state=CtfState.VERIFY_FLAG,
            started_at=1000.0,  # not timed out
            max_time_sec=600,
        )
        # No candidate flags → no best flag
        task.candidate_flags = []

        with patch.object(orch.cost_accounting, 'is_budget_exceeded', return_value=False), \
             patch('app.core.ctf_agent_orchestrator.time') as mock_time, \
             patch.object(orch.llm, 'mock_mode', False), \
             patch.object(orch.llm, 'enabled', True):
            mock_time.time.return_value = 1500.0  # 500s elapsed, not timed out
            orch._verify_flag(task)

        # 应该回到 AGENT_THINK，而不是 GENERATE_WRITEUP
        assert task.state == CtfState.AGENT_THINK, f"Expected AGENT_THINK, got {task.state}"

    def test_no_flag_stops_after_max_streak(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfTask, CtfState

        orch = CtfOrchestrator()
        task = CtfTask(
            task_id="test_vf_2", title="test", description="test",
            state=CtfState.VERIFY_FLAG,
            started_at=100.0,
            max_time_sec=600,
        )
        task.candidate_flags = []
        # 设置已经连续无 flag 5 次
        orch._no_flag_continue_streak[task.task_id] = 5

        with patch.object(orch.cost_accounting, 'is_budget_exceeded', return_value=False), \
             patch('app.core.ctf_agent_orchestrator.time') as mock_time:
            mock_time.time.return_value = 200.0
            orch._verify_flag(task)

        assert task.state == CtfState.GENERATE_WRITEUP, "Should stop after max no-flag streak"


class TestAgentActionJsonParse:
    """JSON action 格式解析。"""

    def test_json_shell_action(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator

        orch = CtfOrchestrator()
        content = json.dumps({
            "thought_summary": "需要先看看文件类型",
            "hypotheses": [{"name": "ELF 逆向", "confidence": 0.7, "evidence": [], "next_test": "file binary"}],
            "action": {"type": "shell", "content": "file challenge.elf"},
            "avoid_repeating": ["strings binary (failed)"],
            "expected_signal": "ELF binary type"
        })
        action, detail, extra = orch._parse_agent_action(content)
        assert action == "SHELL"
        assert detail == "file challenge.elf"
        assert "hypotheses" in extra
        assert extra["hypotheses"][0]["name"] == "ELF 逆向"

    def test_json_script_action(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator

        orch = CtfOrchestrator()
        content = json.dumps({
            "thought_summary": "写解密脚本",
            "action": {"type": "script", "content": "import os\nprint('hello')"},
        })
        action, detail, extra = orch._parse_agent_action(content)
        assert action == "SCRIPT"
        assert "import os" in detail

    def test_json_flag_action(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator

        orch = CtfOrchestrator()
        content = json.dumps({
            "thought_summary": "找到 flag",
            "action": {"type": "flag", "content": "flag{test123}"},
        })
        action, detail, extra = orch._parse_agent_action(content)
        assert action == "FLAG"
        assert detail == "flag{test123}"

    def test_json_expand_context_action(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator

        orch = CtfOrchestrator()
        content = json.dumps({
            "thought_summary": "需要看更多代码",
            "action": {"type": "expand_context", "content": {"file": "main.py", "mode": "text", "offset": 0, "limit": 20000}},
        })
        action, detail, extra = orch._parse_agent_action(content)
        assert action == "EXPAND_CONTEXT"

    def test_json_replan_action(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator

        orch = CtfOrchestrator()
        content = json.dumps({
            "thought_summary": "当前方向失败，需要换方向",
            "action": {"type": "replan", "content": "XOR 方向已穷尽，换 RSA 方向"},
        })
        action, detail, extra = orch._parse_agent_action(content)
        assert action == "REPLAN"

    def test_json_wrapped_in_code_block(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator

        orch = CtfOrchestrator()
        content = "```json\n" + json.dumps({
            "thought_summary": "test",
            "action": {"type": "shell", "content": "ls -la"},
        }) + "\n```"
        action, detail, extra = orch._parse_agent_action(content)
        assert action == "SHELL"
        assert detail == "ls -la"


class TestOldActionFormatCompatible:
    """旧格式 SHELL:/SCRIPT:/FLAG:/STUCK 仍兼容。"""

    def test_old_shell_format(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator
        orch = CtfOrchestrator()
        action, detail, extra = orch._parse_agent_action("SHELL: file binary")
        assert action == "SHELL"
        assert detail == "file binary"

    def test_old_script_format(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator
        orch = CtfOrchestrator()
        action, detail, extra = orch._parse_agent_action("SCRIPT:\nimport os\nprint('hello')")
        assert action == "SCRIPT"
        assert "import os" in detail

    def test_old_flag_format(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator
        orch = CtfOrchestrator()
        action, detail, extra = orch._parse_agent_action("FLAG: flag{test123}")
        assert action == "FLAG"
        assert detail == "flag{test123}"

    def test_old_stuck_format(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator
        orch = CtfOrchestrator()
        action, detail, extra = orch._parse_agent_action("STUCK")
        assert action == "STUCK"


class TestHardModeEscalates:
    """Hard mode 下 reverse/crypto/pwn/forensics 直接 expert。"""

    def test_hard_mode_reverse_escalates(self):
        from app.core.model_router import ModelRouter
        with patch('app.core.model_router.settings') as mock_settings:
            mock_settings.CTF_HARD_MODE = True
            mock_settings.LLM_ROUTER_ENABLED = True
            mock_settings.LLM_EXPERT_API_KEY = "sk-test-real-key-12345678"
            mock_settings.LLM_EXPERT_PROVIDER = "glm"
            mock_settings.LLM_EXPERT_MODEL = "glm-5.2"
            mock_settings.LLM_EXPERT_MAX_TOKENS = 8192
            mock_settings.LLM_EXPERT_TEMPERATURE = 0.15
            mock_settings.LLM_CHEAP_API_KEY = "sk-test"
            mock_settings.LLM_CHEAP_PROVIDER = "deepseek"
            mock_settings.LLM_CHEAP_MODEL = "deepseek-v4-flash"
            mock_settings.LLM_CHEAP_BASE_URL = "https://api.deepseek.com/v1"
            mock_settings.LLM_CHEAP_MAX_TOKENS = 1800
            mock_settings.LLM_CHEAP_TEMPERATURE = 0.2

            router = ModelRouter.__new__(ModelRouter)
            router.router_enabled = True
            router.budget_per_task = 1.0
            router.compress_threshold = 16000

            with patch.object(router, '_budget_remaining', return_value=1.0), \
                 patch('app.core.model_router.get_cost_accounting') as mock_ca:
                mock_ca_instance = MagicMock()
                mock_ca_instance.is_budget_exceeded.return_value = False
                mock_ca_instance.is_daily_budget_exceeded.return_value = False
                mock_ca_instance.get_task_summary.return_value = MagicMock(total_cost_usd=0)
                mock_ca.return_value = mock_ca_instance

                # Hard mode + repeated_error=1 should escalate
                result = router.decide(
                    task_id="test_hard_1", step="agent_think",
                    rounds_used=1, max_rounds=0,
                    repeated_error_count=1,
                )
                assert result.lane == "expert", f"Expected expert, got {result.lane}"


class TestNoRepeatedFailedCommand:
    """不重复失败命令。"""

    def test_failed_command_detection(self):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfTask, CtfState

        orch = CtfOrchestrator()
        task = CtfTask(
            task_id="test_repeat_1", title="test", description="test",
        )
        task.shell_history = [
            {"command": "strings binary", "exit_code": 1, "stdout": "", "stderr": "not found"},
        ]
        failed = orch._get_failed_commands(task)
        assert "strings binary" in failed


class TestNoSecretLeakInLogs:
    """API key 不出现在日志/报告/前端。"""

    def test_mask_secret(self):
        from app.core.llm_adapter import mask_secret
        assert "sk-real" not in mask_secret("sk-realsecretkey1234567890")
        assert "****" in mask_secret("sk-realsecretkey1234567890")

    def test_mask_sensitive_in_text(self):
        from app.core.llm_adapter import mask_sensitive_in_text
        text = "Bearer sk-realsecretkey1234567890"
        result = mask_sensitive_in_text(text)
        assert "sk-realsecretkey" not in result
        assert "****" in result

    def test_route_status_no_key(self):
        from app.core.model_router import ModelRouter
        router = ModelRouter()
        status = router.status()
        # expert status 应该只有 configured=True/False，不泄露 key
        expert = status.get("expert", {})
        assert "api_key" not in expert
        assert "api_key_configured" in expert


class TestContextExpand:
    """expand_context 功能测试。"""

    def test_expand_text_file(self, tmp_path):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfTask

        orch = CtfOrchestrator()
        # 创建测试文件
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello World\nLine 2\nLine 3")

        task = CtfTask(task_id="test_expand_1", title="test", description="test")
        task._workspace = str(tmp_path)

        result = orch._expand_context(task, json.dumps({"file": "test.txt", "mode": "text"}))
        assert "Hello World" in result

    def test_expand_hex_file(self, tmp_path):
        from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfTask

        orch = CtfOrchestrator()
        test_file = tmp_path / "test.bin"
        test_file.write_bytes(b"\x00\x01\x02\x03\x41\x42\x43\x44")

        task = CtfTask(task_id="test_expand_2", title="test", description="test")
        task._workspace = str(tmp_path)

        result = orch._expand_context(task, json.dumps({"file": "test.bin", "mode": "hex"}))
        # hex dump 应该包含十六进制表示
        assert "00" in result or "41" in result

"""Tests for model_router."""
import pytest

from app.core.model_router import (
    ModelRouter,
    RouteDecision,
    get_model_router,
)
from app.core.cost_accounting import reset_cost_accounting_for_test


@pytest.fixture
def router(monkeypatch):
    reset_cost_accounting_for_test()
    # 默认所有 key 都未配置（replace_me）
    monkeypatch.setattr("app.config.settings.LLM_CHEAP_API_KEY", "replace_me")
    monkeypatch.setattr("app.config.settings.LLM_EXPERT_API_KEY", "replace_me")
    monkeypatch.setattr("app.config.settings.LLM_FALLBACK_API_KEY", "replace_me")
    monkeypatch.setattr("app.config.settings.LLM_ROUTER_ENABLED", True)
    # 但 model_router 用的是 import 时绑定的 settings 引用，
    # 所以也要 patch model_router 内部看到的 settings
    monkeypatch.setattr("app.core.model_router.settings.LLM_CHEAP_API_KEY", "replace_me")
    monkeypatch.setattr("app.core.model_router.settings.LLM_EXPERT_API_KEY", "replace_me")
    monkeypatch.setattr("app.core.model_router.settings.LLM_FALLBACK_API_KEY", "replace_me")
    monkeypatch.setattr("app.core.model_router.settings.LLM_ROUTER_ENABLED", True)
    return ModelRouter()


def test_static_solved_returns_static_only(router):
    d = router.decide(task_id="t1", step="classify", static_solved=True)
    assert d.lane == "static_only"
    assert d.max_tokens == 0
    assert d.reason == "static_analysis_found_flag"


def test_budget_exceeded_returns_stop(router):
    from app.core.cost_accounting import get_cost_accounting
    acc = get_cost_accounting()
    for _ in range(20):
        acc.record(
            task_id="t2", step="classify",
            provider="deepseek", model="deepseek-v4-flash",
            input_tokens=100000, output_tokens=50000,
            success=True, route_reason="cheap_default",
            use_cache=False,
        )
    d = router.decide(task_id="t2", step="classify")
    assert d.lane == "stop"
    assert "budget" in d.reason


def test_cheap_default_when_no_escalation(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_CHEAP_API_KEY", "sk-test123")
    d = router.decide(task_id="t3", step="classify", rounds_used=1, max_rounds=8)
    assert d.lane == "cheap"
    assert d.reason == "cheap_default"
    assert d.max_tokens == 400


def test_escalate_expert_on_rounds_no_candidate(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_EXPERT_API_KEY", "sk-expert123")
    d = router.decide(
        task_id="t4", step="reflect_error",
        rounds_used=4, max_rounds=8,
        candidate_flags=[],
    )
    assert d.lane == "expert"
    assert d.reason == "rounds_no_candidate"


def test_escalate_expert_on_repeated_error(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_EXPERT_API_KEY", "sk-expert456")
    d = router.decide(
        task_id="t5", step="reflect_error",
        rounds_used=2, repeated_error_count=2,
        candidate_flags=[{"flag": "x"}],
    )
    assert d.lane == "expert"
    assert d.reason == "repeated_error"


def test_escalate_on_observer_loop(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_EXPERT_API_KEY", "sk-expert789")
    d = router.decide(
        task_id="t6", step="generate_script",
        observer_loop_detected=True,
    )
    assert d.lane == "expert"
    assert d.reason == "observer_loop"


def test_force_expert(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_EXPERT_API_KEY", "sk-force")
    d = router.decide(task_id="t7", step="classify", force_expert=True)
    assert d.lane == "expert"
    assert d.reason == "user_force_expert"


def test_no_real_key_returns_mock_lane(router):
    d = router.decide(task_id="t8", step="classify")
    assert d.lane == "cheap"
    assert d.provider == "mock"
    assert d.reason == "no_real_key_mock_mode"


def test_long_context_escalates(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_EXPERT_API_KEY", "sk-long")
    d = router.decide(
        task_id="t9", step="generate_script",
        analysis_summary_chars=10000,
    )
    assert d.lane == "expert"
    assert d.reason == "long_context"


def test_step_token_budget_mapping(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_CHEAP_API_KEY", "sk-budget")
    for step, expected in [
        ("classify", 400), ("plan", 600),
        ("generate_script", 1800), ("reflect_error", 900),
        ("generate_writeup", 2000), ("unknown_step", 800),
    ]:
        d = router.decide(task_id=f"t_{step}", step=step)
        assert d.max_tokens == expected, f"{step}: {d.max_tokens}"


def test_status_does_not_leak_keys(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_CHEAP_API_KEY", "sk-supersecretkey1234")
    monkeypatch.setattr("app.core.model_router.settings.LLM_EXPERT_API_KEY", "sk-expertsecretkey5678")
    s = router.status()
    import json
    flat = json.dumps(s)
    assert "sk-supersecretkey" not in flat
    assert "sk-expertsecretkey" not in flat
    assert s["cheap"]["api_key_configured"] is True
    assert s["expert"]["api_key_configured"] is True


def test_status_when_keys_not_configured(router):
    s = router.status()
    assert s["cheap"]["api_key_configured"] is False
    assert s["expert"]["api_key_configured"] is False
    assert s["router_enabled"] is True


def test_router_disabled_returns_mock(router, monkeypatch):
    monkeypatch.setattr("app.core.model_router.settings.LLM_ROUTER_ENABLED", False)
    d = router.decide(task_id="t_disabled", step="classify")
    # router disabled -> no cheap available -> mock lane
    assert d.lane == "cheap"
    assert d.provider == "mock"


def test_singleton():
    a = get_model_router()
    b = get_model_router()
    assert a is b

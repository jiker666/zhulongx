"""Tests for cost_accounting."""
from app.core.cost_accounting import (
    CostAccounting,
    estimate_cost,
    get_cost_accounting,
    reset_cost_accounting_for_test,
)


def test_estimate_tokens_and_cost():
    cost = estimate_cost("deepseek-v4-flash", input_tokens=1000, output_tokens=500)
    # 1000 * 0.14 / 1e6 + 500 * 0.28 / 1e6
    expected = round((1000 * 0.14 + 500 * 0.28) / 1_000_000, 6)
    assert abs(cost - expected) < 1e-9
    assert cost > 0


def test_estimate_cost_unknown_model_is_zero():
    cost = estimate_cost("totally-unknown-model-xyz", 1000, 500)
    assert cost == 0.0


def test_estimate_cost_mock_is_zero():
    cost = estimate_cost("mock", 1000, 500)
    assert cost == 0.0


def test_record_basic():
    acc = CostAccounting(budget_per_task_usd=0.05)
    rec = acc.record(
        task_id="t1",
        step="classify",
        provider="deepseek",
        model="deepseek-v4-flash",
        input_text="hello world " * 100,
        output_text="{}",
        success=True,
        route_reason="cheap_default",
    )
    assert rec.task_id == "t1"
    assert rec.input_tokens > 0
    assert rec.estimated_cost_usd > 0
    summary = acc.get_task_summary("t1")
    assert summary.total_calls == 1
    assert summary.successful_calls == 1
    assert summary.cheap_calls == 1
    assert summary.by_step["classify"] == 1
    assert summary.by_model["deepseek-v4-flash"] == 1


def test_record_expert_lane():
    acc = CostAccounting(budget_per_task_usd=0.05)
    acc.record(
        task_id="t2", step="reflect_error",
        provider="glm", model="glm-5.2",
        input_tokens=2000, output_tokens=800,
        success=True, route_reason="expert_escalated",
    )
    summary = acc.get_task_summary("t2")
    assert summary.expert_calls == 1
    assert summary.cheap_calls == 0


def test_record_static_only_zero_cost():
    acc = CostAccounting(budget_per_task_usd=0.05)
    acc.record_static_only(task_id="t3", step="verify_flag", reason="static_solve")
    summary = acc.get_task_summary("t3")
    assert summary.total_calls == 1
    assert summary.static_only_calls == 1
    assert summary.total_cost_usd == 0.0
    assert summary.total_input_tokens == 0


def test_budget_exceeded_detection():
    acc = CostAccounting(budget_per_task_usd=0.0001)  # very small budget
    acc.record(
        task_id="t4", step="classify",
        provider="deepseek", model="deepseek-v4-flash",
        input_tokens=10000, output_tokens=5000,
        success=True, route_reason="cheap_default",
    )
    summary = acc.get_task_summary("t4")
    assert summary.budget_exceeded is True
    assert acc.is_budget_exceeded("t4") is True


def test_budget_not_exceeded():
    acc = CostAccounting(budget_per_task_usd=10.0)
    acc.record(
        task_id="t5", step="classify",
        provider="deepseek", model="deepseek-v4-flash",
        input_tokens=100, output_tokens=50,
        success=True, route_reason="cheap_default",
    )
    assert not acc.is_budget_exceeded("t5")


def test_cache_hit_zero_cost():
    acc = CostAccounting(budget_per_task_usd=0.05)
    msgs = [{"role": "user", "content": "classify this"}]
    rec1 = acc.record(
        task_id="t6", step="classify",
        provider="deepseek", model="deepseek-v4-flash",
        input_text="classify this", output_text="{}",
        success=True, route_reason="cheap_default",
        messages=msgs, use_cache=True,
    )
    assert rec1.estimated_cost_usd > 0
    # 第二次相同 prompt
    rec2 = acc.record(
        task_id="t6", step="classify",
        provider="deepseek", model="deepseek-v4-flash",
        input_text="classify this", output_text="{}",
        success=True, route_reason="cheap_default",
        messages=msgs, use_cache=True,
    )
    assert rec2.route_reason == "cache_hit"
    assert rec2.estimated_cost_usd == 0.0
    summary = acc.get_task_summary("t6")
    assert summary.cache_hits == 1
    # cache hit 不再增加 total_cost
    assert summary.total_cost_usd == rec1.estimated_cost_usd


def test_failed_call_recorded():
    acc = CostAccounting(budget_per_task_usd=0.05)
    acc.record(
        task_id="t7", step="classify",
        provider="deepseek", model="deepseek-v4-flash",
        input_text="x", output_text="",
        success=False, route_reason="cheap_default",
    )
    summary = acc.get_task_summary("t7")
    assert summary.failed_calls == 1
    assert summary.successful_calls == 0


def test_get_task_records():
    acc = CostAccounting(budget_per_task_usd=0.05)
    for i in range(3):
        acc.record(
            task_id="t8", step=f"s{i}",
            provider="deepseek", model="deepseek-v4-flash",
            input_text="x", output_text="y",
            success=True, route_reason="cheap_default",
        )
    recs = acc.get_task_records("t8")
    assert len(recs) == 3


def test_reset_task():
    acc = CostAccounting(budget_per_task_usd=0.05)
    acc.record(task_id="t9", step="classify", provider="deepseek", model="deepseek-v4-flash",
               input_text="x", output_text="y", success=True, route_reason="cheap_default")
    acc.reset_task("t9")
    summary = acc.get_task_summary("t9")
    assert summary.total_calls == 0


def test_reset_all():
    acc = CostAccounting(budget_per_task_usd=0.05)
    acc.record(task_id="t10", step="classify", provider="deepseek", model="deepseek-v4-flash",
               input_text="x", output_text="y", success=True, route_reason="cheap_default")
    acc.reset_all()
    assert acc.get_daily_total_cost() == 0.0
    assert acc.get_task_summary("t10").total_calls == 0


def test_singleton():
    reset_cost_accounting_for_test()
    a1 = get_cost_accounting()
    a2 = get_cost_accounting()
    assert a1 is a2

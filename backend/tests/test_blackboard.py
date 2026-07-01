"""Tests for blackboard (Fact / Intent / Hint)."""
from app.core.blackboard import get_blackboard


def test_add_fact_and_list():
    bb = get_blackboard()
    bb.reset_task("bb_t1")
    f = bb.add_fact(task_id="bb_t1", kind="file", content="a.bin ELF", confidence=0.8, source_step="analyze_files")
    assert f.fact_id.startswith("fact_")
    facts = bb.list_facts("bb_t1")
    assert len(facts) == 1
    assert facts[0].content == "a.bin ELF"
    assert facts[0].kind == "file"
    assert facts[0].confidence == 0.8


def test_add_candidate_fact():
    bb = get_blackboard()
    bb.reset_task("bb_t2")
    bb.add_fact(task_id="bb_t2", kind="candidate", content="flag{x}", confidence=0.9, source_step="verify_flag")
    cands = bb.get_candidates("bb_t2")
    assert len(cands) == 1
    assert cands[0].content == "flag{x}"


def test_add_error_fact():
    bb = get_blackboard()
    bb.reset_task("bb_t3")
    bb.add_fact(task_id="bb_t3", kind="error", content="ValueError: boom", source_step="run_script")
    errs = bb.get_recent_errors("bb_t3")
    assert len(errs) == 1
    assert "ValueError" in errs[0].content


def test_fact_count():
    bb = get_blackboard()
    bb.reset_task("bb_t4")
    for i in range(5):
        bb.add_fact(task_id="bb_t4", kind="clue", content=f"clue{i}")
    assert bb.fact_count("bb_t4") == 5


def test_add_intent_and_list():
    bb = get_blackboard()
    bb.reset_task("bb_t5")
    i = bb.add_intent(task_id="bb_t5", title="extract strings", rationale="try strings first", priority=3)
    assert i.intent_id.startswith("intent_")
    intents = bb.list_intents("bb_t5")
    assert len(intents) == 1
    assert intents[0].title == "extract strings"
    assert intents[0].status == "pending"


def test_update_intent_status():
    bb = get_blackboard()
    bb.reset_task("bb_t6")
    i = bb.add_intent(task_id="bb_t6", title="test")
    updated = bb.update_intent("bb_t6", i.intent_id, status="in_progress")
    assert updated.status == "in_progress"
    # 查询验证
    intents = bb.list_intents("bb_t6")
    assert intents[0].status == "in_progress"


def test_update_intent_not_found():
    bb = get_blackboard()
    result = bb.update_intent("bb_t7", "intent_nonexistent", status="completed")
    assert result is None


def test_deprecate_intents():
    bb = get_blackboard()
    bb.reset_task("bb_t8")
    i1 = bb.add_intent(task_id="bb_t8", title="a")
    i2 = bb.add_intent(task_id="bb_t8", title="b")
    n = bb.deprecate_intents("bb_t8", [i1.intent_id, i2.intent_id])
    assert n == 2
    intents = bb.list_intents("bb_t8")
    assert all(i.status == "deprecated" for i in intents)


def test_add_hint_and_list():
    bb = get_blackboard()
    bb.reset_task("bb_t9")
    h = bb.add_hint(task_id="bb_t9", content="try xor key 0x42", source="human")
    assert h.hint_id.startswith("hint_")
    hints = bb.list_hints("bb_t9")
    assert len(hints) == 1
    assert hints[0].source == "human"
    assert hints[0].consumed is False


def test_mark_hint_consumed():
    bb = get_blackboard()
    bb.reset_task("bb_t10")
    h = bb.add_hint(task_id="bb_t10", content="test")
    ok = bb.mark_hint_consumed("bb_t10", h.hint_id)
    assert ok is True
    hints = bb.list_hints("bb_t10")
    assert hints[0].consumed is True


def test_list_hints_exclude_consumed():
    bb = get_blackboard()
    bb.reset_task("bb_t11")
    h1 = bb.add_hint(task_id="bb_t11", content="c1")
    bb.add_hint(task_id="bb_t11", content="c2")
    bb.mark_hint_consumed("bb_t11", h1.hint_id)
    unconsumed = bb.list_hints("bb_t11", include_consumed=False)
    assert len(unconsumed) == 1
    assert unconsumed[0].content == "c2"


def test_snapshot():
    bb = get_blackboard()
    bb.reset_task("bb_t12")
    bb.add_fact(task_id="bb_t12", kind="file", content="f1")
    bb.add_fact(task_id="bb_t12", kind="candidate", content="flag{x}")
    bb.add_intent(task_id="bb_t12", title="i1")
    bb.add_hint(task_id="bb_t12", content="h1")
    snap = bb.snapshot("bb_t12")
    assert snap["task_id"] == "bb_t12"
    assert len(snap["facts"]) == 2
    assert len(snap["intents"]) == 1
    assert len(snap["hints"]) == 1
    assert snap["fact_count"] == 2
    assert snap["candidate_count"] == 1


def test_reset_task_clears_all():
    bb = get_blackboard()
    bb.reset_task("bb_t13")
    bb.add_fact(task_id="bb_t13", kind="clue", content="c")
    bb.add_intent(task_id="bb_t13", title="t")
    bb.add_hint(task_id="bb_t13", content="h")
    bb.reset_task("bb_t13")
    assert bb.fact_count("bb_t13") == 0
    assert len(bb.list_intents("bb_t13")) == 0
    assert len(bb.list_hints("bb_t13")) == 0


def test_intent_depends_on_persisted():
    bb = get_blackboard()
    bb.reset_task("bb_t14")
    i = bb.add_intent(
        task_id="bb_t14", title="depends test",
        depends_on=["intent_a", "intent_b"],
    )
    intents = bb.list_intents("bb_t14")
    assert intents[0].depends_on == ["intent_a", "intent_b"]


def test_fact_filter_by_kind():
    bb = get_blackboard()
    bb.reset_task("bb_t15")
    bb.add_fact(task_id="bb_t15", kind="file", content="f")
    bb.add_fact(task_id="bb_t15", kind="candidate", content="c")
    files = bb.list_facts("bb_t15", kind="file")
    cands = bb.list_facts("bb_t15", kind="candidate")
    assert len(files) == 1
    assert len(cands) == 1

"""Tests for observer."""
from app.core.blackboard import get_blackboard
from app.core.observer import Observer, get_observer


def _make_runs(stderrs):
    return [{"stderr": s, "stdout": "", "success": False} for s in stderrs]


def test_observer_no_loop_initial():
    bb = get_blackboard()
    bb.reset_task("obs_t1")
    obs = Observer(blackboard=bb)
    advice = obs.observe(
        task_id="obs_t1",
        rounds_used=1, max_rounds=8,
        script_runs=[],
        current_script="print('hello')",
    )
    assert advice.loop_detected is False
    assert advice.should_stop is False


def test_observer_detects_loop_same_script_same_stderr():
    bb = get_blackboard()
    bb.reset_task("obs_t2")
    obs = Observer(blackboard=bb)
    script = "print('same')"
    runs = _make_runs(["ValueError: boom", "ValueError: boom"])
    # observe twice with same script
    obs.observe(task_id="obs_t2", rounds_used=1, max_rounds=8,
                script_runs=[runs[0]], current_script=script)
    advice = obs.observe(task_id="obs_t2", rounds_used=2, max_rounds=8,
                         script_runs=runs, current_script=script)
    assert advice.loop_detected is True
    assert advice.should_escalate_model is True


def test_observer_no_loop_different_stderr():
    bb = get_blackboard()
    bb.reset_task("obs_t3")
    obs = Observer(blackboard=bb)
    script = "print('same')"
    runs = _make_runs(["ValueError: first", "KeyError: second"])
    obs.observe(task_id="obs_t3", rounds_used=1, max_rounds=8,
                script_runs=[runs[0]], current_script=script)
    advice = obs.observe(task_id="obs_t3", rounds_used=2, max_rounds=8,
                         script_runs=runs, current_script=script)
    # stderr 不同，不算 loop
    assert advice.loop_detected is False


def test_observer_detects_repeated_error():
    bb = get_blackboard()
    bb.reset_task("obs_t4")
    obs = Observer(blackboard=bb)
    runs = _make_runs(["ValueError: boom", "ValueError: boom"])
    advice = obs.observe(
        task_id="obs_t4", rounds_used=2, max_rounds=8,
        script_runs=runs, current_script="x",
    )
    # 2 次相同 stderr signature → repeated_error → escalate
    assert advice.should_escalate_model is True


def test_observer_drift_detected_after_two_stable():
    bb = get_blackboard()
    bb.reset_task("obs_t5")
    obs = Observer(blackboard=bb)
    bb.add_fact(task_id="obs_t5", kind="clue", content="c1")
    # 第一次 observe 记录 fact_count=1 (baseline, no drift)
    obs.observe(task_id="obs_t5", rounds_used=1, max_rounds=8, script_runs=[])
    # 第二次 observe，没有新 fact → streak=1, not yet drift (need 2)
    obs.observe(task_id="obs_t5", rounds_used=2, max_rounds=8, script_runs=[])
    # 第三次 observe，仍没有新 fact → streak=2, drift=True
    advice = obs.observe(task_id="obs_t5", rounds_used=3, max_rounds=8, script_runs=[])
    assert advice.drift_detected is True


def test_observer_no_drift_with_new_facts():
    bb = get_blackboard()
    bb.reset_task("obs_t6")
    obs = Observer(blackboard=bb)
    bb.add_fact(task_id="obs_t6", kind="clue", content="c1")
    obs.observe(task_id="obs_t6", rounds_used=1, max_rounds=8, script_runs=[])
    bb.add_fact(task_id="obs_t6", kind="clue", content="c2")
    advice = obs.observe(task_id="obs_t6", rounds_used=2, max_rounds=8, script_runs=[])
    assert advice.drift_detected is False


def test_observer_should_replan_with_high_conf_candidate():
    bb = get_blackboard()
    bb.reset_task("obs_t7")
    obs = Observer(blackboard=bb)
    advice = obs.observe(
        task_id="obs_t7", rounds_used=1, max_rounds=8,
        script_runs=[],
        candidate_flags=[{"flag": "flag{x}", "confidence": 0.9}],
        state="GENERATE_SCRIPT",
    )
    assert advice.should_replan is True
    assert "VERIFY_FLAG" in advice.advice


def test_observer_no_replan_when_already_verifying():
    bb = get_blackboard()
    bb.reset_task("obs_t8")
    obs = Observer(blackboard=bb)
    advice = obs.observe(
        task_id="obs_t8", rounds_used=1, max_rounds=8,
        script_runs=[],
        candidate_flags=[{"flag": "flag{x}", "confidence": 0.9}],
        state="VERIFY_FLAG",
    )
    assert advice.should_replan is False


def test_observer_should_stop_when_rounds_exhausted_no_candidate():
    bb = get_blackboard()
    bb.reset_task("obs_t9")
    obs = Observer(blackboard=bb)
    bb.add_fact(task_id="obs_t9", kind="clue", content="c1")
    # baseline
    obs.observe(task_id="obs_t9", rounds_used=1, max_rounds=8, script_runs=[])
    # streak=1
    obs.observe(task_id="obs_t9", rounds_used=2, max_rounds=8, script_runs=[])
    # streak=2 drift=True; rounds=7 near cap → stop
    advice = obs.observe(task_id="obs_t9", rounds_used=7, max_rounds=8, script_runs=[])
    assert advice.should_stop is True


def test_observer_no_stop_when_has_candidate():
    bb = get_blackboard()
    bb.reset_task("obs_t10")
    obs = Observer(blackboard=bb)
    advice = obs.observe(
        task_id="obs_t10", rounds_used=7, max_rounds=8,
        script_runs=[],
        candidate_flags=[{"flag": "flag{x}", "confidence": 0.6}],
    )
    assert advice.should_stop is False


def test_observer_no_stop_when_far_from_cap():
    bb = get_blackboard()
    bb.reset_task("obs_t14")
    obs = Observer(blackboard=bb)
    bb.add_fact(task_id="obs_t14", kind="clue", content="c1")
    obs.observe(task_id="obs_t14", rounds_used=1, max_rounds=8, script_runs=[])
    obs.observe(task_id="obs_t14", rounds_used=2, max_rounds=8, script_runs=[])
    # drift but far from cap → should NOT stop
    advice = obs.observe(task_id="obs_t14", rounds_used=3, max_rounds=8, script_runs=[])
    assert advice.drift_detected is True
    assert advice.should_stop is False


def test_observer_advice_text_not_empty():
    bb = get_blackboard()
    bb.reset_task("obs_t11")
    obs = Observer(blackboard=bb)
    advice = obs.observe(task_id="obs_t11", rounds_used=1, max_rounds=8, script_runs=[])
    assert advice.advice  # non-empty


def test_observer_reset():
    bb = get_blackboard()
    bb.reset_task("obs_t12")
    obs = Observer(blackboard=bb)
    obs._script_history["obs_t12"] = ["hash1", "hash2"]
    obs.reset("obs_t12")
    assert "obs_t12" not in obs._script_history


def test_observer_to_dict_structure():
    bb = get_blackboard()
    bb.reset_task("obs_t13")
    obs = Observer(blackboard=bb)
    advice = obs.observe(task_id="obs_t13", rounds_used=1, max_rounds=8, script_runs=[])
    d = advice.to_dict()
    for k in ["should_replan", "should_escalate_model", "should_stop",
              "loop_detected", "drift_detected", "advice", "confidence"]:
        assert k in d


def test_singleton():
    a = get_observer()
    b = get_observer()
    assert a is b

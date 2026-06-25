"""
End-to-end tests for CTF orchestrator with mock LLM.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Force mock mode before imports
os.environ["LLM_ENABLED"] = "false"
os.environ["APP_ENV"] = "dev"

from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfState, get_orchestrator
from app.core.llm_adapter import LLMAdapter


@pytest.fixture
def orchestrator():
    # Reset singletons
    import app.core.ctf_agent_orchestrator as orch_mod
    import app.core.llm_adapter as la_mod
    la_mod._adapter = None
    orch_mod._orchestrator = None
    # Use mock LLM
    la = LLMAdapter(enabled=False)
    o = CtfOrchestrator(llm=la)
    return o


def _run_demo(orch, demo_root):
    meta = json.loads(open(os.path.join(demo_root, "challenge.json")).read())
    task = orch.create_task(
        title=meta["title"],
        description=meta["description"],
        category_hint=meta.get("category", "auto"),
        flag_format=meta.get("flag_format"),
        authorized=True,
        allow_network=False,
        max_rounds=8,
    )
    att_dir = os.path.join(demo_root, "attachment")
    if os.path.isdir(att_dir):
        for fn in os.listdir(att_dir):
            orch.add_attachment(task.task_id, os.path.join(att_dir, fn))
    orch.run(task.task_id)
    return orch.get_task(task.task_id)


def test_crypto_xor_demo(orchestrator):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "examples", "ctf_demo", "crypto_xor"))
    task = _run_demo(orchestrator, root)
    expected = open(os.path.join(root, "expected_flag.txt")).read().strip()
    assert task.state == CtfState.DONE, f"state={task.state}, error={task.error}"
    assert task.best_flag == expected, f"best={task.best_flag} expected={expected}"


def test_misc_exif_demo(orchestrator):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "examples", "ctf_demo", "misc_exif"))
    task = _run_demo(orchestrator, root)
    expected = open(os.path.join(root, "expected_flag.txt")).read().strip()
    assert task.state == CtfState.DONE, f"state={task.state}, error={task.error}"
    assert task.best_flag == expected


def test_forensics_log_demo(orchestrator):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "examples", "ctf_demo", "forensics_log"))
    task = _run_demo(orchestrator, root)
    expected = open(os.path.join(root, "expected_flag.txt")).read().strip()
    assert task.state == CtfState.DONE, f"state={task.state}, error={task.error}"
    assert task.best_flag == expected


def test_reverse_py_demo(orchestrator):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "examples", "ctf_demo", "reverse_py"))
    task = _run_demo(orchestrator, root)
    expected = open(os.path.join(root, "expected_flag.txt")).read().strip()
    assert task.state == CtfState.DONE, f"state={task.state}, error={task.error}"
    assert task.best_flag == expected


def test_scope_guard_blocks_unauthorized_network(orchestrator):
    """allow_network=true requires authorized=true."""
    task = orchestrator.create_task(
        title="test",
        description="test",
        category_hint="auto",
        authorized=False,
        allow_network=True,
        max_rounds=2,
    )
    orchestrator.run(task.task_id)
    task = orchestrator.get_task(task.task_id)
    # Should have force-disabled network access
    assert task.allow_network is False
    # Should have evidence recording the scope check
    scope_ev = [e for e in task.evidence if e.step == "scope_check"]
    assert len(scope_ev) > 0
    assert not scope_ev[0].success


def test_evidence_chain_recorded(orchestrator):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "examples", "ctf_demo", "misc_exif"))
    task = _run_demo(orchestrator, root)
    # Should have evidence for at least init, classify, plan, analyze_files, generate_script, run_script, verify_flag, generate_writeup
    steps = [e.step for e in task.evidence]
    for expected_step in ("init", "classify", "plan", "analyze_files", "generate_script", "run_script", "verify_flag"):
        assert expected_step in steps, f"missing step {expected_step} in {steps}"


def test_writeup_generated_on_success(orchestrator):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "examples", "ctf_demo", "crypto_xor"))
    task = _run_demo(orchestrator, root)
    assert task.state == CtfState.DONE
    assert task.writeup_md
    assert "烛龙·玄枢" in task.writeup_md
    assert "flag{xor_crypto_is_simple_but_classic}" in task.writeup_md

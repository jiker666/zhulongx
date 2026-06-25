import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "audit_solve_trace.py"


def load_audit_module():
    spec = importlib.util.spec_from_file_location("audit_solve_trace", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def base_trace(tmp_path: Path, run: Path):
    case_file = tmp_path / "ctf_cases" / "case01" / "attachments" / "puzzle.txt"
    case_file.parent.mkdir(parents=True)
    case_file.write_text("payload", encoding="utf-8")
    return {
        "rag_disabled": True,
        "history_matching_disabled": True,
        "internet_search_disabled": True,
        "evaluator_read_by_solver": False,
        "historical_runs_read_by_solver": False,
        "any_disallowed_memory_guess": False,
        "tools_used": ["CTFMiscSolver"],
        "access_log": [{
            "normalized_path": str(case_file),
            "allowed": True,
            "reason": "allowed",
        }],
        "denied_access_log": [],
        "execution_ledger": [{
            "action_id": 1,
            "action_type": "registered_tool",
            "tool_name": "CTFMiscSolver",
            "policy_decision": "allow",
        }],
        "output_dir": str(run),
    }


def test_audit_report_passes_for_clean_trace(tmp_path):
    module = load_audit_module()
    run = tmp_path / "ctf_runs" / "case01-001"
    run.mkdir(parents=True)
    (run / "solve_trace.json").write_text(module.json.dumps(base_trace(tmp_path, run)), encoding="utf-8")
    (run / "answer_candidates.json").write_text(module.json.dumps([
        {"candidate": "flag{ok}", "source_type": "decoded_chain", "evidence_ids": ["ev-1"], "confidence": 0.9}
    ]), encoding="utf-8")
    result = module.audit(run)
    module.write_report(run, result)
    assert result["passed"] is True
    assert (run / "audit_solve_report.md").exists()


def test_audit_fails_for_forbidden_trace(tmp_path):
    module = load_audit_module()
    run = tmp_path / "ctf_runs" / "case01-002"
    run.mkdir(parents=True)
    trace = base_trace(tmp_path, run)
    trace["access_log"].append({"normalized_path": str(tmp_path / "ctf_cases" / "case01" / "evaluator" / "expected_answer.txt"), "allowed": True})
    (run / "solve_trace.json").write_text(module.json.dumps(trace), encoding="utf-8")
    (run / "answer_candidates.json").write_text(module.json.dumps([
        {"candidate": "flag{ok}", "source_type": "decoded_chain", "evidence_ids": ["ev-1"], "confidence": 0.9}
    ]), encoding="utf-8")
    result = module.audit(run)
    assert result["passed"] is False
    assert any("evaluator" in item for item in result["failures"])

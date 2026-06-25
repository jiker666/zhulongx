import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def extract_json(stdout: str):
    start = stdout.find("{")
    end = stdout.rfind("}")
    assert start >= 0 and end > start, stdout
    return json.loads(stdout[start:end + 1])


def run(cmd):
    result = subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert result.returncode == 0, result.stderr + "\n" + result.stdout
    return result


def test_random_case_solves_without_expected_read():
    generated = extract_json(run([sys.executable, "scripts/generate_random_ctf_case.py", "--seed", "1337"]).stdout)
    assert generated["case_id"]
    solve = extract_json(run([sys.executable, "scripts/solve_ctf_case.py", "--case", "ctf_cases/generated/latest"]).stdout)
    evaluation = extract_json(run([sys.executable, "scripts/evaluate_ctf_case.py", "--case", "ctf_cases/generated/latest", "--run", "latest"]).stdout)
    assert evaluation["solved"] is True
    assert evaluation["rank"] == 1
    trace = json.loads((Path(solve["output_dir"]) / "solve_trace.json").read_text(encoding="utf-8"))
    assert trace["evaluator_read_by_solver"] is False
    assert trace["historical_runs_read_by_solver"] is False
    assert not any("expected_answer" in item.get("normalized_path", "") for item in trace["access_log"])

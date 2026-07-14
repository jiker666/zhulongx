import json
from pathlib import Path
import sys


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from benchmarks.runner import ROOT, run_case


def test_benchmark_expected_metadata_is_not_in_public_challenge_descriptions():
    manifest = json.loads((ROOT / "benchmarks" / "manifest.json").read_text(encoding="utf-8"))
    hidden = json.loads((ROOT / "benchmarks" / "hidden" / "manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["cases"]) == 25
    assert set(hidden["evaluators"]) == {case["id"] for case in manifest["cases"]}
    for case in manifest["cases"]:
        public_dir = ROOT / "benchmarks" / "public" / case["id"]
        challenge = json.loads((public_dir / "challenge.json").read_text(encoding="utf-8"))
        assert "expected" not in challenge
        assert "expected_flag" not in challenge
        assert json.dumps(hidden["evaluators"][case["id"]], sort_keys=True) not in challenge["objective"]
        assert not (public_dir / "expected_flag.txt").exists()


def test_benchmark_case_runs_through_agent_session():
    manifest = json.loads((ROOT / "benchmarks" / "manifest.json").read_text(encoding="utf-8"))
    result = run_case(manifest["cases"][1], repetition=1)

    assert result["validated"] is True
    assert result["status"] == "succeeded"
    assert result["event_count"] >= 10
    assert result["invalid_tool_calls"] == 0


def test_benchmark_report_is_honestly_labeled():
    report_path = ROOT / "benchmarks" / "results" / "latest.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))

    assert report["mode"] == "agent_session_mock_hidden_25"
    assert "not a live-model solve rate" in report["claim"]
    assert report["repetitions"] == 3
    assert len(report["results"]) == 75

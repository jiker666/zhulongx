from pathlib import Path

import pytest

from app.core.solve_access_guard import SolveAccessDenied, SolveAccessGuard


def make_case(tmp_path: Path) -> tuple[Path, Path, SolveAccessGuard]:
    case = tmp_path / "ctf_cases" / "case01"
    (case / "attachments").mkdir(parents=True)
    (case / "evaluator").mkdir()
    (case / "challenge.json").write_text("{}", encoding="utf-8")
    (case / "README.md").write_text("readme", encoding="utf-8")
    (case / "scope.env.example").write_text("", encoding="utf-8")
    (case / "attachments" / "flag.txt").write_text("decoy", encoding="utf-8")
    (case / "evaluator" / "expected_answer.txt").write_text("flag{secret}", encoding="utf-8")
    run = tmp_path / "ctf_runs" / "case01-001"
    guard = SolveAccessGuard(case, run, challenge_id="case01")
    return case, run, guard


def test_allows_current_attachments_and_marks_suspicious(tmp_path):
    case, _, guard = make_case(tmp_path)
    assert guard.read_text(case / "attachments" / "flag.txt", tool_name="test") == "decoy"
    assert guard.access_log[-1]["allowed"] is True
    assert guard.access_log[-1]["suspicious_name"] is True


def test_rejects_evaluator_expected_and_history(tmp_path):
    case, _, guard = make_case(tmp_path)
    with pytest.raises(SolveAccessDenied):
        guard.read_text(case / "evaluator" / "expected_answer.txt", tool_name="test")
    old_run = tmp_path / "ctf_runs" / "case01-old" / "brief.md"
    old_run.parent.mkdir(parents=True)
    old_run.write_text("old", encoding="utf-8")
    with pytest.raises(SolveAccessDenied):
        guard.read_text(old_run, tool_name="test")
    assert len(guard.denied_access_log) == 2


def test_rejects_symlink_escape(tmp_path):
    case, _, guard = make_case(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    link = case / "attachments" / "link.txt"
    link.symlink_to(outside)
    with pytest.raises(SolveAccessDenied):
        guard.read_text(link, tool_name="test")


def test_rejects_zip_escape_member(tmp_path):
    case, _, guard = make_case(tmp_path)
    archive = case / "attachments" / "payload.zip"
    archive.write_text("placeholder", encoding="utf-8")
    with pytest.raises(SolveAccessDenied):
        guard.validate_archive_member(archive, "../expected_answer.txt", tool_name="test")

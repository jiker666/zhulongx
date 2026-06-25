"""
Tests for CtfFileAnalyzer.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.ctf_file_analyzer import CtfFileAnalyzer
from app.core.code_execution_sandbox import CodeExecutionSandbox


@pytest.fixture
def analyzer(tmp_path):
    sb = CodeExecutionSandbox(base_workdir=str(tmp_path / "an"), default_timeout=3)
    return CtfFileAnalyzer(sandbox=sb)


def test_analyze_text_file(analyzer, tmp_path):
    f = tmp_path / "sample.txt"
    f.write_text("hello world\nflag{test_file_analyzer}\nend")
    result = analyzer.analyze(str(f))
    assert len(result.files) >= 1
    fa = result.files[0]
    assert "flag{test_file_analyzer}" in fa.flags_found
    assert fa.size > 0
    assert fa.md5  # hash should be computed


def test_analyze_zip(analyzer, tmp_path):
    import zipfile
    zip_path = tmp_path / "data.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("note.txt", "flag{zip_extracted}")
        zf.writestr("data/info.txt", "additional info")
    result = analyzer.analyze(str(zip_path))
    # Should have extracted and analyzed
    all_flags = []
    for f in result.files:
        all_flags.extend(f.flags_found)
    assert "flag{zip_extracted}" in all_flags


def test_summary_computed(analyzer, tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("flag{a}")
    result = analyzer.analyze(str(f))
    assert "file_count" in result.summary
    assert result.summary["file_count"] >= 1
    assert result.summary["has_flag_candidate"]


def test_recommendation_generated(analyzer, tmp_path):
    f = tmp_path / "a.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    result = analyzer.analyze(str(f))
    fa = result.files[0]
    # Recommendation should mention image
    assert fa.recommendation


def test_nonexistent_file(analyzer):
    result = analyzer.analyze("/nonexistent/path/file.bin")
    assert len(result.errors) > 0
    assert "not found" in result.errors[0]

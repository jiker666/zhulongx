import os
import tempfile
import zipfile

import pytest
from app.tools.archive import ExtractArchiveTool


def _make_zip_slip_zip(dest_path):
    with zipfile.ZipFile(dest_path, "w") as zf:
        zf.writestr("../../../tmp/evil_slip.txt", "pwned")
        zf.writestr("safe_file.txt", "safe content")


def _make_safe_zip(dest_path):
    with zipfile.ZipFile(dest_path, "w") as zf:
        zf.writestr("file1.txt", "content1")
        zf.writestr("subdir/file2.txt", "content2")


def test_zip_slip_blocked():
    ws = tempfile.mkdtemp(prefix="test_zipslip_")
    zip_path = os.path.join(ws, "malicious.zip")
    _make_zip_slip_zip(zip_path)
    tool = ExtractArchiveTool()
    result = tool.run({"workspace": ws, "path": "malicious.zip"})
    assert result["success"] is True
    assert not os.path.exists(os.path.join(ws, "../../../tmp/evil_slip.txt"))
    safe_file = os.path.join(ws, "extracted", "malicious.zip", "safe_file.txt")
    assert os.path.isfile(safe_file)


def test_safe_zip_extracts_correctly():
    ws = tempfile.mkdtemp(prefix="test_safezip_")
    zip_path = os.path.join(ws, "normal.zip")
    _make_safe_zip(zip_path)
    tool = ExtractArchiveTool()
    result = tool.run({"workspace": ws, "path": "normal.zip"})
    assert result["success"] is True
    extracted_dir = os.path.join(ws, "extracted", "normal.zip")
    assert os.path.isfile(os.path.join(extracted_dir, "file1.txt"))
    assert os.path.isfile(os.path.join(extracted_dir, "subdir", "file2.txt"))


def test_archive_path_escape_blocked():
    ws = tempfile.mkdtemp(prefix="test_archive_escape_")
    tool = ExtractArchiveTool()
    result = tool.run({"workspace": ws, "path": "../../etc/passwd"})
    assert result["success"] is False


def test_archive_nonexistent_file():
    ws = tempfile.mkdtemp(prefix="test_archive_nofile_")
    tool = ExtractArchiveTool()
    result = tool.run({"workspace": ws, "path": "nonexistent.zip"})
    assert result["success"] is False


def test_archive_unsupported_format():
    ws = tempfile.mkdtemp(prefix="test_archive_unsupported_")
    fake = os.path.join(ws, "data.rar")
    with open(fake, "wb") as f:
        f.write(b"not a real archive")
    tool = ExtractArchiveTool()
    result = tool.run({"workspace": ws, "path": "data.rar"})
    assert result["success"] is False
    assert "不支持" in result["summary"] or "unsupported" in result["summary"].lower()


def test_archive_no_path():
    tool = ExtractArchiveTool()
    result = tool.run({"workspace": "/tmp"})
    assert result["success"] is False


def test_extract_archive_tool_metadata():
    tool = ExtractArchiveTool()
    assert tool.name == "extract_archive"
    assert tool.risk_level == "medium"
    assert "local_read" in tool.permissions
    assert "local_write" in tool.permissions

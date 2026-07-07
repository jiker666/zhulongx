import os
import tempfile

import pytest
from app.tools.filesystem import ListDirTool, ReadFileTool, WriteFileTool, GrepTool


def _workspace_with_files():
    ws = tempfile.mkdtemp(prefix="test_fs_")
    with open(os.path.join(ws, "hello.txt"), "w") as f:
        f.write("hello world")
    os.makedirs(os.path.join(ws, "subdir"))
    with open(os.path.join(ws, "subdir", "nested.txt"), "w") as f:
        f.write("nested content with flag{safe_path_test}")
    return ws


def test_list_dir_blocks_path_escape():
    ws = _workspace_with_files()
    tool = ListDirTool()
    result = tool.run({"workspace": ws, "path": "../../etc"})
    assert result["success"] is False
    assert "path_escape" in str(result.get("details", {}).get("error", ""))


def test_list_dir_works():
    ws = _workspace_with_files()
    tool = ListDirTool()
    result = tool.run({"workspace": ws, "path": "."})
    assert result["success"] is True
    names = [e["name"] for e in result["details"]["entries"]]
    assert "hello.txt" in names


def test_read_file_blocks_path_escape():
    ws = _workspace_with_files()
    tool = ReadFileTool()
    result = tool.run({"workspace": ws, "file": "../../etc/passwd"})
    assert result["success"] is False
    assert "path_escape" in str(result.get("details", {}).get("error", ""))


def test_read_file_works():
    ws = _workspace_with_files()
    tool = ReadFileTool()
    result = tool.run({"workspace": ws, "file": "hello.txt"})
    assert result["success"] is True
    assert "hello world" in result["details"]["content"]


def test_read_file_with_offset():
    ws = _workspace_with_files()
    tool = ReadFileTool()
    result = tool.run({"workspace": ws, "file": "hello.txt", "offset": 6, "limit": 100})
    assert result["success"] is True
    assert "world" in result["details"]["content"]


def test_write_file_blocks_path_escape():
    ws = _workspace_with_files()
    tool = WriteFileTool()
    result = tool.run({"workspace": ws, "path": "/tmp/evil.sh", "content": "bad"})
    assert result["success"] is False
    assert "path_escape" in str(result.get("details", {}).get("error", ""))


def test_write_file_no_overwrite_original():
    ws = _workspace_with_files()
    tool = WriteFileTool()
    result = tool.run({"workspace": ws, "path": "hello.txt", "content": "overwritten", "attachments": [os.path.join(ws, "hello.txt")]})
    assert result["success"] is False
    assert "overwrite_denied" in str(result.get("details", {}).get("error", "")) or "覆盖" in result.get("summary", "")


def test_write_file_allows_overwrite_with_flag():
    ws = _workspace_with_files()
    tool = WriteFileTool()
    result = tool.run({"workspace": ws, "path": "hello.txt", "content": "overwritten", "allow_overwrite": True, "attachments": [os.path.join(ws, "hello.txt")]})
    assert result["success"] is True


def test_write_file_new_path():
    ws = _workspace_with_files()
    tool = WriteFileTool()
    result = tool.run({"workspace": ws, "path": "new_file.py", "content": "print(1)"})
    assert result["success"] is True
    assert os.path.isfile(os.path.join(ws, "new_file.py"))


def test_grep_blocks_path_escape():
    ws = _workspace_with_files()
    tool = GrepTool()
    result = tool.run({"workspace": ws, "pattern": "flag", "path": "../../etc"})
    assert result["success"] is False


def test_list_dir_absolute_path_escape():
    ws = _workspace_with_files()
    tool = ListDirTool()
    result = tool.run({"workspace": ws, "path": "/etc"})
    assert result["success"] is False


def test_read_file_no_file_specified():
    ws = _workspace_with_files()
    tool = ReadFileTool()
    result = tool.run({"workspace": ws})
    assert result["success"] is False


def test_write_file_no_path():
    ws = _workspace_with_files()
    tool = WriteFileTool()
    result = tool.run({"workspace": ws, "content": "data"})
    assert result["success"] is False

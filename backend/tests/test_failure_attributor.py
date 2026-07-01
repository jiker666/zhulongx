"""Tests for failure_attributor."""
from app.core.failure_attributor import attribute_failure


def test_l1_module_not_found():
    r = attribute_failure(
        stderr="Traceback (most recent call last):\n  File 'x.py', line 1\nModuleNotFoundError: No module named 'numpy'",
    )
    assert r.level == "L1"
    assert "环境" in r.root_cause or "依赖" in r.root_cause


def test_l1_file_not_found():
    r = attribute_failure(
        stderr="FileNotFoundError: [Errno 2] No such file or directory: '/tmp/missing.txt'",
    )
    assert r.level == "L1"


def test_l1_permission_error():
    r = attribute_failure(stderr="PermissionError: [Errno 13] Permission denied")
    assert r.level == "L1"


def test_l2_syntax_error():
    r = attribute_failure(
        script="print('hello'",
        stderr="  File 'x.py', line 1\n    print('hello'\nSyntaxError: unexpected EOF",
    )
    assert r.level == "L2"
    assert "逻辑" in r.root_cause


def test_l2_value_error():
    r = attribute_failure(
        stderr="ValueError: invalid literal for int() with base 10: 'abc'",
    )
    assert r.level == "L2"


def test_l2_key_error():
    r = attribute_failure(stderr="KeyError: 'flag'")
    assert r.level == "L2"


def test_l2_unicode_decode():
    r = attribute_failure(stderr="UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff")
    assert r.level == "L2"


def test_l2_repeated_error_triggers_expert():
    facts = [
        {"kind": "error", "content": "ValueError: invalid"},
        {"kind": "error", "content": "ValueError: invalid again"},
    ]
    r = attribute_failure(
        stderr="ValueError: invalid third time",
        facts=facts,
    )
    assert r.level == "L2"
    assert r.need_expert_model is True


def test_l3_assertion_error():
    r = attribute_failure(
        stderr="AssertionError: flag format mismatch",
    )
    assert r.level == "L3"
    assert r.need_replan is True


def test_l4_connection_refused():
    r = attribute_failure(
        stderr="ConnectionRefusedError: [Errno 61] Connection refused",
    )
    assert r.level == "L4"
    assert "人工" in r.root_cause or "信息不足" in r.root_cause


def test_l4_password_required():
    r = attribute_failure(stderr="password required to decrypt file")
    assert r.level == "L4"


def test_l4_zip_corrupt():
    r = attribute_failure(stderr="BadZipFile: File is not a zip file")
    assert r.level == "L4"


def test_l1_priority_over_l4_module_first():
    # ModuleNotFoundError is L1, should be detected first
    r = attribute_failure(
        stderr="ModuleNotFoundError: No module named 'foo'\nConnection refused",
    )
    assert r.level == "L1"


def test_to_dict_structure():
    r = attribute_failure(stderr="ValueError: test")
    d = r.to_dict()
    assert "level" in d
    assert "root_cause" in d
    assert "fix_strategy" in d
    assert "need_replan" in d
    assert "need_expert_model" in d
    assert "minimal_patch_hint" in d
    assert "matched_patterns" in d


def test_empty_stderr_falls_back_l2():
    r = attribute_failure(stderr="", stdout="", script="")
    assert r.level == "L2"
    assert "未知" in r.root_cause


def test_round_index_triggers_expert():
    r = attribute_failure(stderr="some weird error", round_index=5)
    assert r.level == "L2"
    assert r.need_expert_model is True

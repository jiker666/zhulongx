"""
Tests for FlagVerifier.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.flag_verifier import FlagVerifier, get_verifier


def test_extract_single_flag():
    v = FlagVerifier()
    r = v.extract_from_text("the answer is flag{abc123XYZ}", source="stdout")
    assert len(r) == 1
    assert r[0].flag == "flag{abc123XYZ}"
    assert r[0].source == "stdout"


def test_extract_multiple_formats():
    v = FlagVerifier()
    text = "found flag{a1} and FLAG{b2} and ctf{c3} and SCTF{d4}"
    r = v.extract_from_text(text)
    flags = {c.flag for c in r}
    assert "flag{a1}" in flags
    assert "FLAG{b2}" in flags
    assert "ctf{c3}" in flags
    assert "SCTF{d4}" in flags


def test_dedupe_and_rank():
    v = FlagVerifier()
    text = "flag{x} flag{x} flag{x} flag{y}"
    r = v.extract_from_text(text)
    # dedupe to 2
    assert len(r) == 2
    # confidence of repeated one higher
    assert r[0].flag == "flag{x}"
    assert r[0].confidence > r[1].confidence


def test_verify_with_expected():
    v = FlagVerifier()
    r = v.verify(stdout="result flag{target_match}", expected_flag="flag{target_match}")
    assert r.best is not None
    assert r.best.flag == "flag{target_match}"
    assert r.expected_match is True


def test_verify_with_format_regex():
    v = FlagVerifier()
    r = v.verify(
        stdout="found flag{x} and SCTF{real_one}",
        flag_format_regex=r"SCTF\{[^}]+\}",
    )
    assert r.best is not None
    assert r.best.flag == "SCTF{real_one}"


def test_extract_from_file(tmp_path):
    p = tmp_path / "out.txt"
    p.write_text("hello\nflag{from_file}\nworld")
    v = FlagVerifier()
    r = v.extract_from_file(str(p))
    assert any(c.flag == "flag{from_file}" for c in r)


def test_get_verifier_singleton():
    v1 = get_verifier()
    v2 = get_verifier()
    assert v1 is v2

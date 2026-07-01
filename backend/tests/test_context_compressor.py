"""Tests for context_compressor."""
from app.core.context_compressor import (
    build_llm_context_snippet,
    compress_evidence_chain,
    compress_file_analysis,
    compress_tool_output,
)


def test_compress_tool_output_extracts_flags():
    text = "some log\nflag{abc123}\nnoise noise noise\nFLAG{XYZ}\n" + "A" * 5000
    result = compress_tool_output(text, max_chars=1000)
    assert "flag{abc123}" in result.candidates
    assert "FLAG{XYZ}" in result.candidates
    assert result.compressed_chars <= 1000 + 50  # allow some slack
    assert result.original_chars > 1000


def test_compress_tool_output_empty():
    result = compress_tool_output("")
    assert result.facts == []
    assert result.candidates == []
    assert result.compressed_chars == 0


def test_compress_tool_output_dedupes_adjacent():
    text = "line1\nline1\nline1\nline2\nline2\nflag{dup}"
    result = compress_tool_output(text)
    # adjacent duplicates removed
    assert "line1" in " ".join(result.facts)
    assert result.facts.count("line1") == 1
    assert "flag{dup}" in result.candidates


def test_compress_tool_output_strips_hexdump():
    text = "00000000  48 65 6c 6c 6f 0a                            Hello.\nflag{hex}"
    result = compress_tool_output(text)
    assert "flag{hex}" in result.candidates
    # hexdump line should be stripped
    joined = " ".join(result.facts)
    assert "48 65 6c" not in joined


def test_compress_tool_output_masks_api_key():
    text = "Authorization: Bearer sk-abcdefghijklmnop1234567890abcdef\nflag{leak}"
    result = compress_tool_output(text)
    joined = " ".join(result.facts) + " ".join(result.candidates)
    assert "sk-abcdefghijklmnop" not in joined
    assert "MASKED" in joined or "flag{leak}" in joined


def test_compress_tool_output_keeps_traceback_tail():
    lines = [f"line{i}" for i in range(100)]
    lines.append("Traceback (most recent call last):")
    lines.append("  File 'x.py', line 1, in <module>")
    lines.append("ValueError: boom")
    text = "\n".join(lines)
    result = compress_tool_output(text, max_chars=3000)
    joined = " ".join(result.facts)
    assert "ValueError: boom" in joined
    assert "Traceback" in joined


def test_compress_evidence_chain_basic():
    evidence = [
        {"step": "classify", "output_summary": "crypto", "success": True, "timestamp": 1.0},
        {"step": "run_script", "output_summary": "exit=1", "success": False, "timestamp": 2.0},
        {"step": "verify_flag", "output_summary": "flag{x}", "success": True, "timestamp": 3.0},
    ]
    result = compress_evidence_chain(evidence, max_items=3)
    assert len(result.facts) <= 3
    assert any("run_script" in f for f in result.facts)  # failed kept
    assert "flag{x}" in " ".join(result.candidates) or any("verify_flag" in f for f in result.facts)


def test_compress_evidence_chain_caps_items():
    evidence = [
        {"step": f"s{i}", "output_summary": f"out{i}", "success": True, "timestamp": float(i)}
        for i in range(50)
    ]
    result = compress_evidence_chain(evidence, max_items=8)
    assert len(result.facts) <= 8 + 8  # failed+recent dedupe window
    assert result.omitted_reason


def test_compress_evidence_chain_empty():
    result = compress_evidence_chain([])
    assert result.facts == []


def test_compress_file_analysis_basic():
    analysis = {
        "summary": {"file_count": 2, "has_flag_candidate": True},
        "files": [
            {
                "relative_path": "a.bin",
                "type": "ELF",
                "size": 1024,
                "magic": "ELF 64-bit",
                "suspicious_strings": ["key=secret", "base64=data"],
                "flags_found": ["flag{from_a}"],
            },
            {
                "relative_path": "b.txt",
                "type": "ASCII",
                "size": 10,
                "flags_found": ["flag{from_b}"],
            },
        ],
    }
    result = compress_file_analysis(analysis, max_files=8, max_strings_per_file=15)
    assert any("a.bin" in f for f in result.facts)
    assert any("b.txt" in f for f in result.facts)
    assert "flag{from_a}" in result.candidates
    assert "flag{from_b}" in result.candidates
    assert any("file_count" in f for f in result.facts)


def test_compress_file_analysis_caps_files():
    analysis = {
        "summary": {},
        "files": [
            {"relative_path": f"f{i}.bin", "type": "bin", "size": i}
            for i in range(20)
        ],
    }
    result = compress_file_analysis(analysis, max_files=5)
    assert sum(1 for f in result.facts if f.startswith("file:")) <= 5
    assert result.omitted_reason


def test_compress_file_analysis_empty():
    result = compress_file_analysis({})
    assert result.facts == []


def test_build_llm_context_snippet_includes_all():
    from app.core.context_compressor import CompressedContext
    c = CompressedContext(
        facts=["f1", "f2"],
        errors=["err1"],
        candidates=["flag{x}"],
        next_relevant_context=["ctx1"],
        omitted_reason="省略噪音",
    )
    snippet = build_llm_context_snippet(c)
    assert "flag{x}" in snippet
    assert "err1" in snippet
    assert "f1" in snippet
    assert "ctx1" in snippet
    assert "省略噪音" in snippet


def test_build_llm_context_snippet_truncates():
    from app.core.context_compressor import CompressedContext
    c = CompressedContext(
        facts=["x" * 200 for _ in range(50)],
    )
    snippet = build_llm_context_snippet(c, max_chars=500)
    assert len(snippet) <= 600
    assert "截断" in snippet

import zipfile

from app.core.ctf_static_solver import CTFStaticSolver


def test_static_solver_extracts_strings_and_hash_without_execution(tmp_path):
    sample = tmp_path / "rev.exe"
    sample.write_bytes(b"MZ\x00\x00usage\x00flag{static_solver_strings}\x00")
    result = CTFStaticSolver().analyze_file(sample)
    assert result["format"]["magic"] == "PE"
    assert result["executed_binary"] is False
    assert result["sha256"]
    assert any(c["candidate"] == "flag{static_solver_strings}" for c in result["flag_like"])


def test_static_solver_reports_zip_entries(tmp_path):
    archive = tmp_path / "case.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("notes/readme.txt", "hello")
    result = CTFStaticSolver().analyze_file(archive)
    assert result["format"]["magic"] == "ZIP/JAR/APK"
    assert any(h["type"] == "zip_entries" and "notes/readme.txt" in h["entries"] for h in result["hints"])

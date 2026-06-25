import base64
import gzip

from app.core.ctf_misc_solver import CTFMiscSolver


def test_misc_solver_recovers_multilayer_gzip_base64_flag():
    payload = base64.b64encode(gzip.compress(b"flag{misc_solver_chain}")).decode()
    result = CTFMiscSolver(max_depth=6, flag_format="flag{...}").solve([("artifact.txt", f"blob={payload}")])
    assert result["success"] is True
    best = result["candidates"][0]
    assert best["candidate"] == "flag{misc_solver_chain}"
    methods = [step["method"] for step in best["decode_chain"]]
    assert "base64" in methods
    assert "gzip" in methods


def test_misc_solver_does_not_promote_api_key_as_flag():
    result = CTFMiscSolver().solve([("config", "API_KEY=sk-example-placeholder-but-not-a-flag")])
    assert all(not c["candidate"].startswith("sk-") for c in result["candidates"])

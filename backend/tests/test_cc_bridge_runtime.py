import tempfile

from app.config import settings
from app.core.cc_bridge_runtime import CcBridgeRuntime


class FakeFallbackRuntime:
    def __init__(self):
        self.turns = []
        self.ledger = []
        self.candidate_flags = [{"flag": "flag{fallback_ok}", "confidence": 0.9}]
        self.best_flag = "flag{fallback_ok}"
        self.state = "done"
        self.error = ""
        self.specs = []
        self.skills = ""

    def register_tool(self, spec):
        self.specs.append(spec)

    def load_skills(self, text):
        self.skills = text

    def run(self):
        return "done"


def test_cc_bridge_falls_back_when_cli_missing(monkeypatch):
    monkeypatch.setattr(settings, "CC_RUNTIME_ENABLED", True)
    monkeypatch.setattr(settings, "CC_RUNTIME_REQUIRE_EXTERNAL", False)
    monkeypatch.setattr(settings, "CC_RUNTIME_FALLBACK_INTERNAL", True)
    monkeypatch.setattr(settings, "CC_RUNTIME_BIN", "/definitely/not/exists/claude")
    monkeypatch.setattr(settings, "CC_RUNTIME_COMMAND_TEMPLATE", "")
    with tempfile.TemporaryDirectory() as ws:
        rt = CcBridgeRuntime(task_id="t", workspace=ws, fallback_runtime=FakeFallbackRuntime())
        assert rt.run() == "done"
        assert rt.best_flag == "flag{fallback_ok}"


def test_cc_bridge_extracts_final_flag(monkeypatch):
    with tempfile.TemporaryDirectory() as ws:
        rt = CcBridgeRuntime(task_id="t", workspace=ws)
        rt._extract_candidates("analysis\nFINAL_FLAG: flag{cc_bridge_ok}\n")
        assert rt.best_flag == "flag{cc_bridge_ok}"
        assert rt.candidate_flags[0]["source"] == "claude_code_cli"

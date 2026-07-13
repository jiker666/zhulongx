import ast
from pathlib import Path

from app.core.agent_runtime import AgentRuntime


ROOT = Path(__file__).resolve().parents[1] / "app"


def _forbidden_calls(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            text = ast.unparse(node.func)
            if text.endswith(("sandbox.run_shell", "sandbox.run_python", "self.sandbox.run_shell", "self.sandbox.run_python", "Tool().safe_run")):
                hits.append((node.lineno, text))
    return hits


def test_legacy_runtime_has_no_direct_sandbox_execution():
    assert not _forbidden_calls(ROOT / "core" / "agent_runtime.py")
    assert not _forbidden_calls(ROOT / "core" / "ctf_agent_orchestrator.py")


def test_legacy_shell_uses_gateway(monkeypatch, tmp_path):
    runtime = AgentRuntime(task_id="gateway-test", workspace=str(tmp_path), authorized=True)
    called = {}
    def execute(name, args, **kwargs):
        called["name"] = name
        return "broker-output", "", True
    monkeypatch.setattr(runtime.gateway, "execute", execute)
    output, error, success = runtime._exec_run_shell({"command": "printf ok"})
    assert success and output == "broker-output" and error == ""
    assert called["name"] == "run_shell"

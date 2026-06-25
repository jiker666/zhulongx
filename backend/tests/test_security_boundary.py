import zipfile
from pathlib import Path

from app.core.planner import PlanStep
from app.core.policy_engine import PolicyEngine
from app.tools.directory_probe import DirectoryProbeTool
from app.tools.file_parser import FileParserTool
from app.tools.http_fingerprint import HttpFingerprintTool
from app.tools.java_code_audit import JavaCodeAuditTool
from app.tools.js_interface_extractor import JSInterfaceExtractorTool
from app.core.scope_guard import scope_guard


def test_ssrf_blocks_private_targets_by_default(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.DEV_ALLOW_PRIVATE_TARGETS", False)
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", False)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_CIDRS", "")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_DOMAINS", "")
    for tool in [HttpFingerprintTool(), DirectoryProbeTool(), JSInterfaceExtractorTool()]:
        result = tool.run({"target": "http://127.0.0.1:18080"})
        assert result["success"] is False
        assert result["details"]["error_type"] == "ssrf_blocked"


def test_competition_scope_allows_only_explicit_private_target(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_LOCALHOST", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_PRIVATE_IPS", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_CIDRS", "127.0.0.1/32,10.10.0.0/16")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_DOMAINS", "localhost,arena.local")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_PORTS", "18080,8080")

    allowed = scope_guard.validate_url("http://127.0.0.1:18080")
    assert allowed.allowed is True
    assert "cidr:" in allowed.matched_scope

    bad_port = scope_guard.validate_url("http://127.0.0.1:18081")
    assert bad_port.allowed is False
    assert "端口" in bad_port.reason

    out_of_scope = scope_guard.validate_url("http://10.20.1.1:8080")
    assert out_of_scope.allowed is False
    assert "未命中" in out_of_scope.reason


def test_domain_resolving_private_still_requires_scope(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_LOCALHOST", False)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_PRIVATE_IPS", False)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_CIDRS", "10.10.0.0/16")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_DOMAINS", "arena.local")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_PORTS", "")
    monkeypatch.setattr("app.core.scope_guard._resolve_host", lambda host: ["10.10.1.5"])

    denied = scope_guard.validate_url("http://arena.local:18080")
    assert denied.allowed is False
    assert "SCOPE_ALLOW_PRIVATE_IPS=false" in denied.reason

    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_PRIVATE_IPS", True)
    allowed = scope_guard.validate_url("http://arena.local:18080")
    assert allowed.allowed is True


def test_zip_slip_member_is_skipped(tmp_path: Path):
    archive = tmp_path / "unsafe.zip"
    controller = """
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController {
  @GetMapping("/{orderId}")
  public String detail(@PathVariable Long orderId) { return "ok"; }
}
"""
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../../evil.java", controller)
        zf.writestr("src/main/java/OrderController.java", controller)
    result = JavaCodeAuditTool().run({"file_path": str(archive)})
    skipped = result["details"]["skipped_files"]
    assert any("unsafe zip path" in item for item in skipped)
    assert result["details"]["high_risk_count"] >= 1
    assert not (tmp_path.parent / "evil.java").exists()


def test_zip_size_limit_has_skip_reason(tmp_path: Path):
    archive = tmp_path / "large.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("src/main/java/LargeController.java", "A" * (1024 * 1024 + 1))
    result = JavaCodeAuditTool().run({"file_path": str(archive)})
    assert any("too large" in item for item in result["details"]["skipped_files"])


def test_policy_engine_allow_confirm_and_deny():
    policy = PolicyEngine()
    tool = FileParserTool()
    allow = policy.evaluate(PlanStep(action="文件解析", tool="FileParserTool", reason="只读分析"), tool, {})
    assert allow["decision"] == "allow"

    confirm = policy.evaluate(PlanStep(action="外部批量抓取", tool="FileParserTool", reason="中风险", risk_level="medium"), tool, {})
    assert confirm["decision"] == "require_confirmation"

    for action in ["爆破登录", "漏洞利用", "getshell", "反弹 shell", "持久化", "窃取数据", "破坏数据", "横向移动"]:
        denied = policy.evaluate(PlanStep(action=action, tool="FileParserTool", reason=action), tool, {})
        assert denied["decision"] == "deny"

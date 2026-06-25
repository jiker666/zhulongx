import zipfile
from pathlib import Path

from app.core.planner import Planner


def test_planner_uses_uploaded_zip_intent(tmp_path: Path):
    archive = tmp_path / "demo.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("pom.xml", "<project/>")
        zf.writestr("src/main/java/com/demo/OrderController.java", "class OrderController {}")

    planner = Planner()
    intent = planner.analyze_intent("auto", "请分析上传包", "", str(archive))
    plan = planner.generate_plan("auto", "请分析上传包", "", uploaded_file=str(archive))

    assert intent["recommended_scenario"] == "code_audit"
    assert "archive" in intent["input_modalities"]
    assert any(step.tool == "JavaCodeAuditTool" for step in plan)
    assert all(step.expected_input for step in plan)
    assert all(step.expected_output for step in plan)

from app.core.planner import PlanStep
from app.core.policy_engine import PolicyEngine
from app.core.reporter import Reporter
from app.tools.file_parser import FileParserTool


def test_policy_engine_denies_dangerous_action():
    step = PlanStep(action="尝试 getshell", tool="FileParserTool", reason="危险动作")
    decision = PolicyEngine().evaluate(step, FileParserTool(), {})
    assert decision["decision"] == "deny"


def test_reporter_includes_v3_sections(tmp_path, monkeypatch):
    monkeypatch.setattr("app.config.settings.REPORT_DIR", str(tmp_path))
    content = Reporter().generate(
        task_id=1,
        task_title="demo",
        task_type="log_analysis",
        task_description="分析日志",
        target="",
        plan_steps=[{"action": "文件解析", "phase": "planning", "tool": "FileParserTool", "reason": "识别文件"}],
        step_records=[{
            "step_index": 1,
            "phase": "planning",
            "action": "文件解析",
            "reason": "识别文件",
            "tool_name": "FileParserTool",
            "input_summary": "file=access.log",
            "output_summary": "日志文件",
            "next_decision": "继续",
            "status": "success",
            "plan_source": "rule",
            "risk_level": "low",
            "confidence": 1.0,
            "decision_trace": {"observation": "日志文件", "reproducibility": {"result_hash": "abc"}},
        }],
        intent={"intent_type": "log_analysis", "recommended_scenario": "log_analysis", "input_modalities": ["file"], "confidence": 0.9},
    )
    md_path = Reporter().save_report(1, content)
    html_path = Reporter().save_html_report(1, content)

    assert "任务理解结果" in content
    assert "决策审计链" in content
    assert "安全边界声明" in content
    assert md_path.endswith(".md")
    assert html_path.endswith(".html")

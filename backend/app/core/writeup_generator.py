"""
Writeup Generator — 基于 EvidenceChain 生成中文 WP。

WP 必须基于真实执行日志和证据链，不允许编造。
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from app.core.ctf_agent_orchestrator import CtfTask


class WriteupGenerator:
    """根据 CtfTask 证据链生成 Markdown WP。"""

    def generate(self, task: "CtfTask") -> str:
        lines: List[str] = []
        plan = task.plan
        lines.append(f"# {task.title} - 解题报告\n")
        lines.append(f"> 本报告由「烛龙·玄枢 ZHULONG-X」自动生成，仅用于授权 CTF / 教学。\n")
        lines.append(f"- 生成时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"- 任务 ID: `{task.task_id}`")
        lines.append(f"- 最终状态: **{task.state.value}**")
        lines.append(f"- 题型: **{plan.category if plan else 'unknown'}**")
        lines.append(f"- 置信度: {plan.confidence:.2f}" if plan else "")
        lines.append(f"- 执行轮次: {task.rounds_used}")
        if task.best_flag:
            lines.append(f"- 最终 flag: `{task.best_flag}` ✅")
        else:
            lines.append(f"- 最终 flag: ❌ 未确定（请人工接管）")
        lines.append("")

        # 题目信息
        lines.append("## 1. 题目信息\n")
        lines.append(f"- 标题: {task.title}")
        lines.append(f"- 描述: {task.description[:500] if task.description else '(无)'}")
        if task.flag_format:
            lines.append(f"- flag 格式: `{task.flag_format}`")
        if task.attachments:
            lines.append("- 附件:")
            for a in task.attachments:
                lines.append(f"  - `{a}`")
        lines.append("")

        # 解题思路
        lines.append("## 2. 解题思路\n")
        if plan:
            if plan.initial_guess:
                lines.append(f"**初始判断**: {plan.initial_guess}\n")
            if plan.script_plan:
                lines.append("**执行计划**:\n")
                for s in plan.script_plan:
                    lines.append(f"- {s}")
                lines.append("")
            if plan.risks:
                lines.append("**风险与注意**:\n")
                for r in plan.risks:
                    lines.append(f"- {r}")
                lines.append("")

        # 关键分析过程
        lines.append("## 3. 关键分析过程\n")
        if task.analysis:
            files = task.analysis.get("files", []) if isinstance(task.analysis, dict) else []
            if files:
                lines.append("### 3.1 附件分析\n")
                lines.append("| 文件 | 类型 | 大小 | 关键发现 |")
                lines.append("|------|------|------|---------|")
                for f in files[:10]:
                    sus = ""
                    if f.get("flags_found"):
                        sus = "发现 flag 候选"
                    elif f.get("suspicious_strings"):
                        sus = f.get("suspicious_strings", [""])[0][:30]
                    lines.append(
                        f"| `{f.get('relative_path','')}` | {f.get('type','')[:30]} | "
                        f"{f.get('size',0)}B | {sus} |"
                    )
                lines.append("")

        # 完整脚本
        lines.append("## 4. 解题脚本\n")
        lines.append("```python")
        lines.append(task.current_script or "# (未生成脚本)")
        lines.append("```\n")

        # 执行结果
        if task.script_runs:
            lines.append("## 5. 脚本执行记录\n")
            for i, r in enumerate(task.script_runs, 1):
                lines.append(f"### Run #{i} (exit_code={r.get('exit_code')}, {r.get('duration_ms',0)}ms)\n")
                stdout = (r.get("stdout") or "")[:1500]
                stderr = (r.get("stderr") or "")[:800]
                if stdout:
                    lines.append("**stdout**:")
                    lines.append("```")
                    lines.append(stdout)
                    lines.append("```")
                if stderr:
                    lines.append("**stderr**:")
                    lines.append("```")
                    lines.append(stderr)
                    lines.append("```")
                lines.append("")

        # flag 获取过程
        lines.append("## 6. Flag 获取\n")
        if task.candidate_flags:
            lines.append("| Flag | 来源 | 置信度 |")
            lines.append("|------|------|--------|")
            for c in task.candidate_flags[:10]:
                lines.append(
                    f"| `{c.get('flag','')}` | {c.get('source','')} | "
                    f"{c.get('confidence',0.5):.2f} |"
                )
            lines.append("")
        else:
            lines.append("未提取到候选 flag。\n")

        # 证据链
        lines.append("## 7. 完整证据链\n")
        lines.append("| 步骤 | 时间 | 结果 | 说明 |")
        lines.append("|------|------|------|------|")
        for ev in task.evidence:
            ts = time.strftime("%H:%M:%S", time.localtime(ev.timestamp))
            ok = "✅" if ev.success else "❌"
            lines.append(
                f"| {ev.step} | {ts} | {ok} | {ev.input_summary[:80]} |"
            )
        lines.append("")

        # 坑点总结
        lines.append("## 8. 坑点与改进\n")
        if task.error:
            lines.append(f"- 任务错误: {task.error}")
        if any(not e.success for e in task.evidence):
            failed_steps = [e.step for e in task.evidence if not e.success]
            lines.append(f"- 失败步骤: {failed_steps}")
        if not task.best_flag:
            lines.append("- 未拿到 flag，建议人工接管分析")
        if task.rounds_used >= task.max_rounds:
            lines.append(f"- 达到最大轮次 {task.max_rounds}，自动停机")
        lines.append("")

        lines.append("---\n")
        lines.append("> 烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X")

        return "\n".join(lines)


_writer: Optional[WriteupGenerator] = None


def get_writer() -> WriteupGenerator:
    global _writer
    if _writer is None:
        _writer = WriteupGenerator()
    return _writer

"""
Reporter - generates Markdown security analysis reports.
Round 2: AI analysis summary + Java IDOR evidence chain.
"""
import datetime
import html
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings


class Reporter:
    def generate(
        self,
        task_id: int,
        task_title: str,
        task_type: str,
        task_description: str,
        target: str,
        plan_steps: List[Dict],
        step_records: List[Dict],
        plan_source: str = "rule",
        llm_model: str = "",
        llm_enabled: bool = False,
        intent: Optional[Dict[str, Any]] = None,
    ) -> str:
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        intent = intent or {}
        risks = []
        suggestions = []
        tool_results_md = []
        key_evidence: List[str] = []
        java_findings: List[Dict] = []

        for step in step_records:
            output = step.get("output_summary", "")
            tool = step.get("tool_name", "")
            details = step.get("tool_details", {})
            if step.get("status") == "success" and output:
                tool_results_md.append(f"- **{tool}**: {output}")
                for evidence_item in step.get("tool_evidence", [])[:5]:
                    key_evidence.append(f"- **{tool}**: {evidence_item}")
                if tool == "LogAnalyzerTool":
                    if details.get("top_ips"):
                        tool_results_md.append("  - Top IP: " + ", ".join(f"{i['ip']}({i['count']})" for i in details["top_ips"][:5]))
                    if details.get("top_paths"):
                        tool_results_md.append("  - Top Path: " + ", ".join(f"{p['path']}({p['count']})" for p in details["top_paths"][:5]))
                    if details.get("time_windows"):
                        tool_results_md.append("  - 时间窗口: " + ", ".join(f"{w['window']}({w['count']})" for w in details["time_windows"][:5]))
                elif tool == "JSInterfaceExtractorTool" and details.get("api_paths"):
                    tool_results_md.append("  - API: " + ", ".join(details["api_paths"][:10]))
                elif tool == "HttpFingerprintTool":
                    title = details.get("title")
                    if title:
                        key_evidence.append(f"- **HttpFingerprintTool**: 页面标题 `{title}`")
                elif tool == "DirectoryProbeTool" and details.get("probed_paths"):
                    visible = [p for p in details["probed_paths"] if p.get("status") in (200, 301, 302, 403)]
                    if visible:
                        key_evidence.append("- **DirectoryProbeTool**: " + ", ".join(f"{p.get('path')}->{p.get('status')}" for p in visible[:8]))

            # Collect risks
            if any(kw in output for kw in ["越权", "风险", "HIGH", "可疑", "5xx", "4xx"]):
                risks.append(f"- {step.get('action', '')}: {output[:200]}")

            # Java audit findings
            if tool == "JavaCodeAuditTool" and details.get("findings"):
                java_findings.extend(details["findings"])

        intent_md = f"""## 2. 任务理解结果

| 字段 | 内容 |
|------|------|
| 意图类型 | {intent.get('intent_type', task_type)} |
| 推荐场景 | {intent.get('recommended_scenario', task_type)} |
| 输入模态 | {', '.join(intent.get('input_modalities', [])) or '(无)'} |
| 目标摘要 | {intent.get('target_summary', target or '(文件上传)')} |
| 置信度 | {int(float(intent.get('confidence', 1.0)) * 100)}% |
| 安全约束 | {'；'.join(intent.get('constraints', [])) or '只读授权安全分析'} |

**依据**

{chr(10).join('- ' + str(e) for e in intent.get('evidence', [])) if intent.get('evidence') else '- 无额外证据'}
"""

        if not risks:
            risks = ["- 本次扫描未发现明确高危风险，建议进行更深入的人工复核"]

        suggestions = [
            "- 对所有接口增加统一鉴权中间件，避免遗漏",
            "- 对涉及资源 ID 的接口（userId、orderId 等）增加所有权校验",
            "- 定期审计访问日志，关注异常 IP 和高频访问行为",
            "- 对外暴露的 admin 类路径增加额外访问控制",
            "- 建议进行人工代码审计，确认自动扫描结果",
        ]

        # Build plan table
        plan_md = ""
        for i, step in enumerate(plan_steps, 1):
            src = step.get("plan_source", "rule")
            plan_md += (
                f"{i}. **{step.get('action', '')}** "
                f"({step.get('phase', '')}) "
                f"[{src}] - 工具: {step.get('tool', '')}  \n"
                f"   原因: {step.get('reason', '')}\n"
            )

        # Build decision records
        decision_md = ""
        audit_md = ""
        for step in step_records:
            status_icon = "✅" if step.get("status") == "success" else "❌"
            risk_badge = f"**[{step.get('risk_level', 'low').upper()}]**" if step.get("risk_level") else ""
            conf = f"{int(float(step.get('confidence', 1.0)) * 100)}%" if step.get("confidence") is not None else ""
            trace = step.get("decision_trace") or {}
            trace_obj = trace if isinstance(trace, dict) else {}
            decision_md += f"""
### Step {step.get('step_index', 0)}: {step.get('action', '')}

| 字段 | 内容 |
|------|------|
| 阶段 | {step.get('phase', '')} |
| 使用工具 | {step.get('tool_name', '')} |
| 计划来源 | {step.get('plan_source', 'rule')} |
| 风险等级 | {risk_badge} |
| 置信度 | {conf} |
| 执行原因 | {step.get('reason', '')} |
| 输入摘要 | {step.get('input_summary', '')} |
| 输出摘要 | {str(step.get('output_summary', ''))[:300]} |
| 下一步决策 | {step.get('next_decision', '')} |
| 执行状态 | {status_icon} {step.get('status', '')} |

"""
            if trace_obj:
                audit_md += f"""
### Step {step.get('step_index', 0)}: {step.get('action', '')}

| 字段 | 内容 |
|------|------|
| observation | {trace_obj.get('observation', '')} |
| hypothesis | {trace_obj.get('hypothesis', '')} |
| selected_action | {trace_obj.get('selected_action', '')} |
| rejected_actions | {', '.join(trace_obj.get('rejected_actions', []))} |
| confidence | {trace_obj.get('confidence', '')} |
| result_hash | {trace_obj.get('reproducibility', {}).get('result_hash', '')} |

**DecisionTrace JSON**

```json
{json.dumps(trace_obj, ensure_ascii=False, indent=2)}
```
"""

        # AI analysis section
        if llm_enabled and plan_source in ("llm", "fallback"):
            ai_summary = f"""## AI 辅助分析摘要

| 字段 | 内容 |
|------|------|
| 计划生成方式 | {plan_source} |
| 模型名称 | {llm_model or '(未知)'} |
| 任务理解摘要 | Agent 已通过 LLM 辅助分析生成执行计划 |
| 风险判断摘要 | LLM Judge 对各步骤输出进行了智能评估 |
| 置信度 | 见各步骤置信度字段 |
"""
        elif llm_enabled and plan_source == "rule":
            ai_summary = """## AI 辅助分析摘要

> LLM 已启用，但本次任务使用规则模式完成计划生成（LLM 调用失败或返回无效，已 fallback 到规则模式）。
"""
        else:
            ai_summary = """## AI 辅助分析摘要

> 当前任务使用规则模式完成分析，未启用 LLM。
> 如需启用 LLM 辅助，请在 .env 中设置 LLM_ENABLED=true 并配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。
"""

        # Java IDOR evidence chain
        java_section = ""
        if java_findings:
            java_section = "## Java 越权审计证据链\n\n"
            for f in java_findings:
                rl = f.get("risk_level", "")
                risk_emoji = "🔴" if rl == "HIGH" else "🟡" if rl == "MEDIUM" else "🟢"
                java_section += f"""### {risk_emoji} [{rl}] `{f.get('http_method', '')} {f.get('path', '')}`

| 字段 | 内容 |
|------|------|
| 文件 | {f.get('file', '')} |
| 类名 | {f.get('class_name', '')} |
| 方法名 | {f.get('method_name', '')} |
| HTTP 方法 | {f.get('http_method', '')} |
| 接口路径 | `{f.get('path', '')}` |
| 风险参数 | {', '.join(f.get('risk_params', []))} |
| 鉴权证据 | {', '.join(f.get('auth_evidence', [])) or '(无)'} |
| 风险等级 | **{rl}** |
| 判断原因 | {f.get('reason', '')} |
| 影响 | 资源 ID 参数可能被替换，导致越权访问其他用户或租户的数据。 |
| 修复建议 | {f.get('suggestion', '')} |

"""

        report = f"""# 安全任务分析报告

> 本报告仅用于授权安全测试，禁止用于非法用途。  
> 生成时间: {now}  
> 平台: CyberPilot FinalOps v4

---

## 1. 任务概览

| 字段 | 内容 |
|------|------|
| 任务 ID | {task_id} |
| 任务标题 | {task_title} |
| 任务类型 | {task_type} |
| 分析目标 | {target or '(文件上传)'} |
| 任务描述 | {task_description[:300]} |
| 计划来源 | {plan_source} |

---

{ai_summary}

---

{intent_md}

---

## 3. Agent 执行计划

{plan_md}

---

## 4. 动态决策链

{decision_md}

---

## 5. 决策审计链

{audit_md or '- 暂无审计链数据'}

---

## 6. 工具调用结果摘要

{chr(10).join(tool_results_md) if tool_results_md else "- 暂无工具调用结果"}

---

{java_section}

## 7. 关键证据

{chr(10).join(key_evidence[:40]) if key_evidence else "- 暂无额外证据"}

---

## 8. 风险发现

{chr(10).join(risks)}

---

## 9. 修复建议

{chr(10).join(suggestions)}

---

## 10. 安全边界声明

- 本平台仅用于授权安全测试和防御性分析。
- 本次执行仅包含只读文件解析、只读 HTTP 指纹、有限固定路径探测、日志分析和代码审计。
- 不执行爆破、真实漏洞利用、getshell、反弹 shell、持久化、窃密、破坏数据或横向移动。
- 外部网络访问默认启用 SSRF 防护、超时和范围约束。

---

## 11. 可复现信息

- 任务 ID: {task_id}
- 生成时间: {now}
- 计划来源: {plan_source}
- 步骤数: {len(step_records)}
- 报告格式: Markdown，可导出 print-friendly HTML

---

## 12. 总结

本次安全分析任务（类型：{task_type}）已完成自动化扫描。  
Agent 共执行 {len(step_records)} 个步骤，计划来源：{plan_source}。  
{"LLM 辅助分析已启用（模型: " + llm_model + "）。" if llm_enabled and llm_model else "本次使用规则模式完成分析。"}  

{"Java 越权审计发现 " + str(len(java_findings)) + " 个风险接口，详见证据链章节。" if java_findings else ""}

**注意**：本系统仅进行规则化/AI辅助基础扫描，不涉及漏洞利用或破坏性操作。  
建议结合人工复核，对高风险发现进行深度验证。

---

*CyberPilot FinalOps v4 | 授权安全比赛作战台 | 仅用于授权安全测试*
"""
        return report

    def save_report(self, task_id: int, content: str) -> str:
        report_dir = Path(settings.REPORT_DIR)
        report_dir.mkdir(parents=True, exist_ok=True)
        file_path = report_dir / f"task_{task_id}_report.md"
        file_path.write_text(content, encoding="utf-8")
        return str(file_path)

    def save_html_report(self, task_id: int, markdown_content: str) -> str:
        report_dir = Path(settings.REPORT_DIR)
        report_dir.mkdir(parents=True, exist_ok=True)
        escaped = html.escape(markdown_content)
        html_content = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CyberPilot Report #{task_id}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; margin: 40px; color: #172033; }}
    pre {{ white-space: pre-wrap; word-break: break-word; background: #f6f8fa; border: 1px solid #d0d7de; padding: 16px; border-radius: 6px; }}
    @media print {{ body {{ margin: 16mm; }} }}
  </style>
</head>
<body>
<pre>{escaped}</pre>
</body>
</html>"""
        file_path = report_dir / f"task_{task_id}_report.html"
        file_path.write_text(html_content, encoding="utf-8")
        return str(file_path)

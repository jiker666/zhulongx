# Scoring Alignment

## 任务理解与执行设计

- 目标：证明 Agent 能理解自然语言、URL、上传文件和压缩包，并形成可执行计划。
- 当前能力：`TaskIntentAnalyzer` 结合描述、URL、文件后缀、ZIP 关键文件和 `FileParserTool` 解析结果，输出 `intent_type`、证据、置信度、安全约束；`Planner` 生成结构化步骤。
- 可演示入口：创建 `auto` 任务并上传 Java ZIP 或 access.log；任务详情和报告展示任务理解结果。
- 代码位置：`backend/app/core/intent_analyzer.py`、`backend/app/core/planner.py`、`backend/app/tools/file_parser.py`。
- 测试/证据：`backend/tests/test_planner_intent.py`、`make demo-smoke` 的 Java/日志报告。
- 答辩说法：不是简单下拉框，Agent 会先解释“为什么判断为该场景”，再选择工具链。
- 不足与计划：当前以规则和文件结构证据为主；后续可加入更稳健的 LLM JSON mode 和更多文件类型。

## 系统架构与工程实现

- 目标：证明平台模块化、可部署、可测试。
- 当前能力：FastAPI + SQLite + Agent Core + React/Vite；Podman compose；Makefile 统一测试、演示、训练、审计和打包。
- 可演示入口：`/api/health`、`/api/tools`、`make release-check`、`podman compose config`。
- 代码位置：`backend/app/main.py`、`backend/app/database.py`、`frontend/src/pages/*`、`Makefile`。
- 测试/证据：`python3 -m pytest -q`、`npm run build`、`make team-drill`、`make safety-audit`、`podman compose -f podman-compose.yml config`。
- 答辩说法：核心是“任务-计划-工具-判断-报告”的可审计流水线。
- 不足与计划：SQLite 不适合高并发生产；后续可替换 PostgreSQL 和任务队列。

## 决赛现场协同

- 目标：证明平台支持 3 人队伍稳定分工、复核、提交和复盘。
- 当前能力：FinalOps v4 聚合 Challenge、assignee、reviewer、EvidenceVault、AnswerCandidate、submission status、Brief、Debrief、导出/导入备份。
- 可演示入口：`/final-ops`、`make team-drill`、`docs/team_sop.md`。
- 代码位置：`frontend/src/pages/FinalOps.tsx`、`backend/app/api/challenges.py`、`scripts/team_drill.py`、`scripts/finalops_backup.py`。
- 测试/证据：team-drill scoreboard、operator timeline、submission flow 测试、backup/import 测试。
- 答辩说法：Agent 做低风险分诊和证据整理，人负责复核与提交，避免错误答案直接进入平台。
- 不足与计划：现场仍需要队员训练；下一步是人工演练三轮，不再临场加功能。

## 决策逻辑与可解释性

- 目标：证明每一步为什么执行、看到什么、下一步为何如此。
- 当前能力：每个 Step 保存 `decision_trace`，包含 observation、evidence、hypothesis、selected_action、rejected_actions、safety_check、confidence、reproducibility。
- 可演示入口：TaskDetail 展开步骤，点击复制审计链 JSON；报告“决策审计链”章节。
- 代码位置：`backend/app/core/decision_trace.py`、`backend/app/core/executor.py`、`frontend/src/pages/TaskDetail.tsx`。
- 测试/证据：`backend/tests/test_report_quality.py`、demo 输出报告。
- 答辩说法：Agent 的动作不是黑箱，审计链可以复现工具、输入摘要和结果 hash。
- 不足与计划：动态重规划是最小可用规则闭环；后续可做 run_id 和更强的因果链展示。

## 工具协同与扩展能力

- 目标：证明工具不是硬编码页面，而是标准化目录和可编排插件。
- 当前能力：`BaseTool` 暴露 schema、权限、风险等级、超时、标签；`ToolRegistry` 同步 DB 并尊重 enabled 状态；Planner 只选启用工具。
- 可演示入口：ToolCenter 展示 schema 并启用/禁用工具；`/api/tools` 返回真实字段。
- 代码位置：`backend/app/tools/base.py`、`backend/app/core/tool_registry.py`、`backend/app/api/tools.py`。
- 测试/证据：`backend/tests/test_api_observability.py`、`make demo-smoke` 工具链 summary。
- 答辩说法：新增工具只需继承 BaseTool、定义 schema、注册、写测试。
- 不足与计划：当前插件仍在源码内注册；后续可引入动态插件目录或 MCP 工具适配。

## 创新与附加价值

- 目标：证明不只是扫描器，而是安全边界内的自主安全智能体。
- 当前能力：自主任务理解、低风险策略引擎、SSRF 防护、DecisionTrace、Markdown/HTML 报告、离线演示验证。
- 可演示入口：三场景 demo smoke、报告 HTML 打印、`docs/security_boundary.md`。
- 代码位置：`backend/app/core/policy_engine.py`、`backend/app/tools/http_safety.py`、`backend/app/core/reporter.py`。
- 测试/证据：`backend/tests/test_security_boundary.py`、`docs/demo_script.md`。
- 答辩说法：平台强调授权、只读、可复现，适合“3 名队员 + 自研 AI Agent”的人机协同模式。
- 不足与计划：尚未做真实生产认证和队列隔离；初审演示以本地授权样例为主。

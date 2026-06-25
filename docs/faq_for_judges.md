# FAQ for Judges

## 这是不是简单工作流？

不是。固定工作流只会按类型跑固定步骤；CyberPilot FinalOps v4 会先生成任务理解结果，再按工具启用状态、安全策略和中间输出记录可解释决策链，并把证据、候选答案、人工回填和提交状态聚合到 Challenge。

## LLM 失败怎么办？

Planner/Judge 都有规则 fallback。LLM 输出必须是 JSON，并经过安全过滤；失败时不会阻断演示和报告生成。

## 如何保证安全边界？

默认工具只读。HTTP 工具有 SSRF 防护和超时；PolicyEngine 拒绝爆破、利用、getshell、反弹 shell、持久化、窃密、破坏和横向移动。

## 如何确认比赛目标在授权范围内？

Settings 页面提供 ScopeGuard 检查器，后端也提供 `/api/scope/check`。它会返回 allowed、reason、matched_rule、host、port 和解析 IP 摘要。

## 如何证明不是硬编码 demo？

`make demo-smoke` 通过 API 上传真实样例文件，创建任务并执行工具链，断言报告和步骤中包含上传路径、工具输出和 DecisionTrace。

## 团队训练如何证明？

`make final-drill` 覆盖固定样例，`make team-drill` 覆盖混合题型、误报、阻断、人工回填和 LLM fallback，并输出 scoreboard、timeline、debrief。

## 现场数据如何备份和恢复？

FinalOps 顶部有“导出备份”和“导入备份”；命令行可用 `make backup-final` 和 `make restore-final FILE=...`。备份 JSON 不包含 `.env`、API Key 或上传大文件本体。

## 如何扩展一个新工具？

继承 `BaseTool`，补齐 schema、权限、风险等级、超时和标签，注册到 `ToolRegistry`，新增测试和安全样例。

## 如何审计每一步决策？

TaskDetail 展开步骤可查看 observation、evidence、hypothesis、selected_action、safety_check 和 reproducibility；报告也包含决策审计链。

## 与传统自动化扫描器区别是什么？

传统扫描器强调探测项覆盖。CyberPilot 强调任务理解、跨工具编排、可解释决策、安全策略和报告复现，适合授权安全任务助手。

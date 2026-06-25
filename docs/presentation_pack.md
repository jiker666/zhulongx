# Presentation Pack - FinalOps v4

本文用于准备 PPT、3/5/10 分钟答辩、录屏脚本和评委问答。素材强调训练、SOP、稳定现场体验、备份恢复、安全审计和 Podman 交付。

## PPT 大纲

1. 标题：CyberPilot FinalOps v4 - 授权安全比赛作战台。
2. 痛点：多题并行、证据分散、候选答案难复核、提交记录易遗漏。
3. 定位：不是自动攻击器，而是安全边界内的人机协同分诊和提交工作台。
4. 架构：React + FastAPI + SQLite + ToolRegistry + ScopeGuard + EvidenceVault。
5. 现场流程：导入题单、分配队员、Triage、证据、候选、Brief、Submit、Accepted/Rejected。
6. ScopeGuard：CIDR、域名、端口、私有地址、localhost、请求预算。
7. 训练材料：`docs/team_sop.md`、`docs/failure_playbook.md`、`docs/range_onboarding.md`。
8. 稳定性：`make doctor`、`make test`、`make demo-smoke`、`make final-drill`、`make team-drill`。
9. 备份恢复：FinalOps 导出/导入 JSON，命令行 `make backup-final` / `make restore-final FILE=...`。
10. 交付：Podman 启动、v4 zip 包、SHA256、无 `.env`/db/uploads/reports/backups。

## 3 分钟口径

CyberPilot FinalOps v4 是一个面向授权安全比赛的作战台。它不追求“自动打穿”，而是把题目分配、附件分诊、证据留存、候选答案、人工复核、提交状态和 Debrief 串成稳定流程。现场只需要 Podman 启动，ScopeGuard 会把访问限制在裁判授权范围内。我们新增了团队 SOP、故障手册、靶场接入清单、备份导入导出和安全审计，保证比赛时能训练、能恢复、能解释、能交付。

## 5 分钟口径

第一分钟讲问题：决赛多题并行时，人的主要损耗不是工具不会跑，而是上下文丢失、重复提交、错误候选混淆、证据不可复现。

第二分钟讲平台：FinalOps 把 Challenge 作为中心对象，关联 task、evidence、answer candidates、notes、submit status。每题可复制 Brief 给 reviewer，也可复制 Debrief 做全队复盘。

第三分钟讲安全：ScopeGuard 默认拒绝非授权目标。Settings 有快速检查器，后端也提供 `/api/scope/check`。所有 HTTP 工具必须经过范围检查，不提供破坏性能力。

第四分钟讲训练：`make final-drill` 做固定样例，`make team-drill` 做混合类型、误报、阻断和人工回填演练，输出 scoreboard、timeline、debrief。

第五分钟讲交付：本机只用 Podman；`make release-check`、`make safety-audit`、`make package` 会生成 v4 提交包和 SHA256，并排除密钥、数据库、上传、报告和备份。

## 10 分钟演示脚本

1. 执行 `make doctor`，说明环境、端口、ScopeGuard 和 Podman 状态。
2. 执行 `COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up`。
3. 打开 `http://localhost:13000/settings`，展示 LLM fallback 和 ScopeGuard 配置。
4. 用 ScopeGuard 检查一个允许目标和一个禁止目标。
5. 打开 `http://localhost:13000/final-ops`，展示 Challenge 列表、筛选和分工。
6. 对一个样例题运行 `Triage`，展示 evidence、candidate、summary、next suggestion。
7. 点击 `Brief`，说明 reviewer 如何快速复核。
8. 点击 `Submit`，展示提交前二次确认；再演示 `Accepted` 或 `Rejected` 如何记录结果。
9. 点击 `导出备份`，说明 JSON 不包含上传大文件本体、`.env` 或 API Key。
10. 执行 `make team-drill`，展示团队演练统计。
11. 执行 `make safety-audit`，展示安全审计结果。
12. 执行 `make package`，展示 `dist/cyberpilot-finalops-v4-submission.zip` 和 `dist/SHA256SUMS`。

## 录屏脚本

- 片头 10 秒：README、VERSION、Podman 启动命令。
- 环境 30 秒：`make doctor`、`/api/health`。
- 安全 45 秒：Settings ScopeGuard 检查允许/禁止目标。
- 作战台 90 秒：导入题、Triage、Brief、Submit、Accepted/Rejected、Debrief。
- 训练 45 秒：`make final-drill`、`make team-drill` 输出文件。
- 交付 45 秒：`make safety-audit`、`make package`、SHA256。

## 推荐截图

- FinalOps v4 首页全局统计和 Challenge 卡片。
- Settings ScopeGuard 检查器 allowed=false/true 两种状态。
- Challenge Brief Markdown。
- Team Drill scoreboard。
- Safety Audit Report。
- `dist/SHA256SUMS`。

## 评委 FAQ 口径

Q: 这是固定工作流吗？  
A: 不是。Challenge 关联证据、候选、人工回填和提交状态；Agent 负责分诊和建议，人负责复核和提交。

Q: LLM 不通怎么办？  
A: 平台有规则兜底，`make team-drill` 已覆盖 LLM fallback 场景。

Q: 如何防止越界？  
A: ScopeGuard 默认拒绝非授权目标，并在 Settings 和 `/api/scope/check` 暴露原因。

Q: 如何恢复现场数据？  
A: FinalOps 导出 JSON 或 `make backup-final`，再用导入按钮或 `make restore-final FILE=...` 恢复。

Q: 提交包如何保证干净？  
A: `make safety-audit` 和 `make package` 会检查并排除 `.env`、数据库、上传、报告、备份、node_modules 和系统缓存。

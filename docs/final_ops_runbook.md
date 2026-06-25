# Final Ops Runbook

## 决赛前 30 分钟

1. `cp .env.example .env`，填入比赛授权范围和模型网关。
2. 运行 `make doctor`，确认 Python、Node、Podman、端口、storage、scope、LLM 配置。
3. 运行 `make final-drill`，确认 10 个样例可导入、分诊、生成候选和证据。
4. 使用独立端口启动：`COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up`。
5. 打开 `http://localhost:13000/final-ops`，确认顶部 Scope/LLM 状态。

## 开场 5 分钟

- 队员 A：录入题目，批量导入 JSON/CSV/Markdown，分配 assignee。
- 队员 B：核对目标是否在授权 scope 内，处理人工浏览器验证。
- 队员 C：复制 Brief、维护证据、提交答案并标记候选状态。

## 每道题流程

1. 创建 Challenge，填题型、描述、目标、附件和负责人。
2. 点击 `Triage`，生成附件摘要、推荐工具、候选答案和 EvidenceVault 证据。
3. 查看最高置信候选，复制候选或证据摘要。
4. 需要人工验证时，在卡片底部回填页面返回、截图说明或提交结果。
5. 候选提交后标记 `submitted`；正确后标记 `solved`。
6. 复制 Challenge Brief 作为提交说明或赛中交接材料。

## Scope 配置

普通展示模式：

```env
COMPETITION_MODE=false
SCOPE_CIDRS=
SCOPE_DOMAINS=
SCOPE_PORTS=
SCOPE_ALLOW_LOCALHOST=false
SCOPE_ALLOW_PRIVATE_IPS=false
```

决赛靶场示例：

```env
COMPETITION_MODE=true
SCOPE_CIDRS=10.10.0.0/16
SCOPE_DOMAINS=*.arena.local,target.local
SCOPE_PORTS=80,443,8080-8090
SCOPE_ALLOW_PRIVATE_IPS=true
SCOPE_ALLOW_LOCALHOST=false
```

本地训练 mock 才使用：

```env
SCOPE_CIDRS=127.0.0.1/32
SCOPE_DOMAINS=localhost
SCOPE_ALLOW_LOCALHOST=true
SCOPE_ALLOW_PRIVATE_IPS=true
```

## 模型网关故障

- `/api/llm/test` 失败时，Planner/Runbook 自动使用规则 fallback。
- ArtifactTriageTool、日志、代码、JS、HTTP 指纹工具不依赖 LLM。
- Reporter、Brief、Debrief 仍可生成。

## 端口冲突

使用非默认端口：

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up
```

查看日志：

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-logs
```

## 数据备份

- SQLite：`data/cyberpilot.db`
- 上传和报告：`backend/app/storage`
- 决赛中可定时复制整个 `data/` 和 `backend/app/storage/` 到外部目录。

## 安全停止条件

- 目标不在 scope 内。
- 请求数超过 `MAX_REQUESTS_PER_TASK` 或 `MAX_REQUESTS_PER_TARGET`。
- 非 GET 请求缺少人工确认。
- 出现需要登录爆破、getshell、持久化、横向移动、窃密或破坏数据的步骤。

## 赛后复盘

- 在 FinalOps 点击复制 Debrief。
- 保留 Challenge Brief、Evidence ID、Task report 和人工回填记录。

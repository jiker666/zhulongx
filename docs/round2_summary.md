# 第二轮开发总结

> 本文档由 CyberPilot 第二轮开发 Agent 生成，供第三轮 Agent 接手参考。

---

## 1. 本轮完成内容

| 优先级 | 功能 | 状态 |
|--------|------|------|
| P0 | LLMClient 模块（OpenAI-compatible）| ✅ |
| P0 | 配置模块增强（LLM 字段）| ✅ |
| P0 | LLM API（/api/llm/status, /api/llm/test）| ✅ |
| P0 | 安全过滤模块（safety.py）| ✅ |
| P0 | Planner LLM + 规则双模式 | ✅ |
| P0 | PlanStep 字段增强（plan_source/confidence/risk_level/requires_confirmation）| ✅ |
| P0 | Judge LLM + 规则双模式 | ✅ |
| P0 | DB 迁移（steps/tasks 新字段）| ✅ |
| P0 | WebSocket 实时日志（ws_manager + /ws/tasks/{id}）| ✅ |
| P0 | Executor 广播 WebSocket 事件 | ✅ |
| P1 | JavaCodeAuditTool 完整增强 | ✅ |
| P1 | Demo Java 样例文件（HIGH/MEDIUM/LOW）| ✅ |
| P1 | 前端 TaskDetail 支持 WebSocket / 轮询兜底 | ✅ |
| P1 | 前端 Settings 页面 LLM 状态展示 + 测试按钮 | ✅ |
| P1 | 前端 ToolCenter 增强展示 | ✅ |
| P1 | ToolRegistry 同步到 tools 表 | ✅ |
| P1 | Reporter 增强（AI 摘要 + Java 证据链）| ✅ |
| P2 | docs/round2_summary.md | ✅ |
| P2 | .env.example 更新 | ✅ |
| P2 | API Schema 增强 | ✅ |

---

## 2. 基于第一轮做了哪些增量修改

**遵守「不推翻架构、只增量开发」原则：**

1. **`backend/app/config.py`** — 补充 LLM_TIMEOUT / LLM_MAX_TOKENS / LLM_TEMPERATURE 字段
2. **`backend/app/database.py`** — 新增 `_migrate_db()` 函数，启动时自动 ALTER TABLE 补充新字段
3. **`backend/app/models/task.py`** — 新增 plan_source / llm_enabled / llm_model 字段
4. **`backend/app/models/step.py`** — 新增 plan_source / risk_level / confidence / requires_confirmation 字段
5. **`backend/app/schemas/task.py`** — TaskOut 新增 plan_source / llm_enabled / llm_model
6. **`backend/app/schemas/step.py`** — StepOut 新增 plan_source / risk_level / confidence / requires_confirmation
7. **`backend/app/core/planner.py`** — 完整重写，支持 LLM + 规则双模式，PlanStep 增强
8. **`backend/app/core/judge.py`** — 完整重写，支持 LLM + 规则双模式，返回结构化 dict
9. **`backend/app/core/executor.py`** — 更新持久化新字段、新增 WS 广播
10. **`backend/app/core/reporter.py`** — 新增 AI 摘要区块、Java 越权证据链区块
11. **`backend/app/core/tool_registry.py`** — 新增 sync_to_db() 方法
12. **`backend/app/tools/java_code_audit.py`** — 完整增强（见第 8 节）
13. **`backend/app/api/tasks.py`** — run_task 传递 plan_source/llm_enabled/llm_model 给 Reporter
14. **`backend/app/api/tools.py`** — 合并 DB + Registry 数据返回
15. **`backend/app/main.py`** — 注册 llm_router / ws_router，启动时 sync_to_db
16. **`backend/requirements.txt`** — 新增 websockets==12.0
17. **`frontend/src/api/index.ts`** — 新增 LLM 类型、getLLMStatus / testLLM API 函数
18. **`frontend/src/pages/TaskDetail.tsx`** — WebSocket 实时更新 + 轮询兜底 + 字段展示
19. **`frontend/src/pages/Settings.tsx`** — LLM 状态展示 + 测试按钮
20. **`frontend/src/pages/ToolCenter.tsx`** — 增强展示（schema/平台/依赖）

---

## 3. 新增后端模块

| 文件 | 说明 |
|------|------|
| `backend/app/core/llm_client.py` | OpenAI-compatible LLM Client，支持 Ollama/OneAPI/LiteLLM，含脱敏日志、超时、JSON 提取 |
| `backend/app/core/safety.py` | LLM 计划安全过滤，拦截危险关键词和未注册工具 |
| `backend/app/core/ws_manager.py` | WebSocket 连接管理器，支持多客户端订阅同一 task_id |
| `backend/app/api/llm.py` | LLM 状态/测试 API |
| `backend/app/api/ws.py` | WebSocket 端点 /ws/tasks/{task_id} |

---

## 4. 新增/修改 API

### 新增 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/llm/status` | 返回 LLM 配置状态（脱敏） |
| POST | `/api/llm/test` | 测试 LLM 连接 |
| WS | `/ws/tasks/{task_id}` | 任务实时日志 WebSocket |

### 修改的 API（向后兼容）

| 路径 | 变更 |
|------|------|
| `GET /api/tasks/{id}` | 返回新增字段 plan_source/llm_enabled/llm_model |
| `GET /api/tasks/{id}/steps` | 返回新增字段 plan_source/risk_level/confidence/requires_confirmation |
| `GET /api/health` | 返回中新增 version/llm_enabled |
| `GET /api/tools` | 合并 DB + Registry 数据 |

---

## 5. LLM 接入方式

### 配置方式

在 `.env` 中设置：

```env
LLM_ENABLED=true
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=http://localhost:11434/v1   # 替换为你的地址
LLM_API_KEY=your-api-key
LLM_MODEL=qwen2.5-coder                  # 替换为你的模型名
LLM_TIMEOUT=60
LLM_MAX_TOKENS=4096
LLM_TEMPERATURE=0.2
```

### 兼容服务

- **Ollama**: `LLM_BASE_URL=http://localhost:11434/v1`
- **OpenAI**: `LLM_BASE_URL=https://api.openai.com/v1`
- **OneAPI / LiteLLM**: 填入对应 base_url

### LLM Client 特性

- 使用 `httpx` 同步调用
- 支持超时（默认 60s）
- API Key 脱敏日志（前4后4字符）
- 支持 markdown 代码块包裹的 JSON 提取
- 任何异常均不崩溃，返回结构化错误

---

## 6. Planner / Judge 双模式说明

### Planner 逻辑

```
LLM_ENABLED=false → 直接使用规则计划 (plan_source=rule)
LLM_ENABLED=true  → 调用 LLM 生成 JSON 计划
                    → 安全过滤 (safety.py)
                    → 成功 → plan_source=llm
                    → 失败/超时/格式错 → fallback 到规则计划 (plan_source=fallback)
```

### Judge 逻辑

```
LLM_ENABLED=false → 规则评估 (source=rule)
LLM_ENABLED=true  → 调用 LLM 对工具输出进行分析
                    → 成功 → source=llm
                    → 失败 → fallback 到规则评估 (source=fallback/rule)
```

### 安全过滤 (safety.py)

拦截以下危险关键词：爆破、暴力破解、getshell、反弹 shell、木马、后门、持久化、提权、窃取、删除数据、破坏、勒索、内网横向、payload、exploit、reverse shell、bruteforce、password spraying、credential stuffing 等。

---

## 7. WebSocket 实时日志实现说明

### 架构

```
前端 TaskDetail → WS /ws/tasks/{task_id}
                ← step_created  (每步完成推送)
                ← task_status   (状态变更推送)
                ← report_ready  (报告生成推送)
```

### 跨线程广播

Executor 在 `threading.Thread` 中运行，广播通过 `_broadcast_sync()` 函数：
- 创建新的 `asyncio` event loop
- 调用 `ws_manager.broadcast(task_id, message)`
- 关闭 loop

### 兜底机制

前端 `TaskDetail.tsx`:
1. 进入页面立即尝试 WebSocket 连接
2. WS 连接失败/断开 → 自动切换到 3 秒轮询
3. 页面显示连接状态：实时连接中 / 轮询模式 / 连接断开
4. 任务完成后自动停止轮询

### 消息格式

```json
{"type": "step_created",  "task_id": 1, "data": {...}}
{"type": "task_status",   "task_id": 1, "data": {"status": "running"}}
{"type": "report_ready",  "task_id": 1, "data": {"report_url": "/api/tasks/1/report"}}
```

---

## 8. Java 越权审计增强说明

### 增强内容

| 特性 | 第一轮 | 第二轮 |
|------|--------|--------|
| 支持注解 | 部分 | 全部 8 种 HTTP 注解 |
| 类级+方法级路径组合 | 不完整 | 完整输出 `GET /api/order/{orderId}` |
| 高风险参数 | 6 个 | 14 个（含 advertiserId/agentId/erpUserId 等） |
| 鉴权检测 | 基础 | 区分强鉴权 / 弱鉴权 / 无鉴权 |
| 风险分级 | HIGH only | HIGH / MEDIUM / LOW |
| 证据链输出 | 无 | 完整 JSON 含 file/class/method/path/params/auth_evidence/suggestion |
| ZIP 大项目 | 无限制 | 最多 200 个文件，优先 controller 路径 |
| 单文件大小 | 无限制 | 超过 1MB 跳过并记录 |

### 风险分级逻辑

- **HIGH**: 有高风险资源 ID 参数 + 未发现任何鉴权
- **MEDIUM**: 有高风险资源 ID 参数 + 仅登录态校验（无归属校验）
- **LOW**: 有高风险资源 ID 参数 + 有强鉴权/归属校验

### Demo 样例

位于 `backend/app/storage/samples/java_auth_demo/`:
- `OrderController.java` → HIGH（3个接口，无任何鉴权）
- `AccountController.java` → MEDIUM（有 SecurityContextHolder 登录校验，无归属校验）
- `UserController.java` → LOW（有 @PreAuthorize + checkOwner + permissionService）

---

## 9. 前端页面增强说明

### TaskDetail.tsx

- **WebSocket 状态指示器**: 实时连接中 / 轮询模式 / 断开
- **计划来源标签**: rule（青色）/ llm（紫色）/ fallback（橙色）
- **风险等级标签**: HIGH（红）/ MEDIUM（黄）/ LOW（绿）
- **置信度显示**: 百分比
- **一键复制执行日志**按钮
- **报告已生成 Banner**

### Settings.tsx

- LLM 配置状态展示（从 `/api/llm/status` 获取）
- 当前模式展示：规则模式 / LLM 模式 / LLM 不可用规则兜底
- 「测试 LLM 连接」按钮，实时显示结果
- API Key 不展示完整值

### ToolCenter.tsx

- 展示工具输入/输出 schema
- 标注支持平台（全平台）
- 标注外部依赖情况
- 启用/禁用状态图标化

---

## 10. 数据库变更说明

### tasks 表新增字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| plan_source | VARCHAR(32) | 'rule' | 计划来源: rule/llm/fallback |
| llm_enabled | BOOLEAN | 0 | 任务执行时 LLM 是否开启 |
| llm_model | VARCHAR(128) | '' | 使用的 LLM 模型名 |

### steps 表新增字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| plan_source | VARCHAR(32) | 'rule' | 步骤计划来源 |
| risk_level | VARCHAR(32) | 'low' | 风险等级 |
| confidence | FLOAT | 1.0 | 置信度 0.0-1.0 |
| requires_confirmation | BOOLEAN | 0 | 是否需要人工确认 |

### 迁移方式

启动时自动 `ALTER TABLE ... ADD COLUMN ...`（有错误捕获，若字段已存在则跳过），不会破坏旧数据库。

---

## 11. Docker / Podman / Windows / macOS Apple Silicon 兼容情况

| 环境 | 状态 | 说明 |
|------|------|------|
| Docker Compose | ✅ | `docker compose up -d --build` |
| Podman Compose | ✅ | `podman-compose up -d --build` |
| macOS Apple Silicon (M1/M2/M3) | ✅ | python:3.11-slim + node:20-alpine 多架构镜像，无 amd64 hardcode |
| Windows PowerShell | ✅ | 脚本未改动，保持兼容 |
| Linux x86_64 | ✅ | 官方镜像全兼容 |

---

## 12. 当前可演示流程

### 演示流程 A：规则模式 Web 扫描

1. 打开 http://localhost:3000
2. 创建任务：类型=web_scan，目标=http://example.com
3. 运行任务 → 观察 WebSocket 实时步骤出现
4. 查看报告（规则模式说明 + 步骤详情）
5. Settings 页面验证 LLM 状态 = 已禁用

### 演示流程 B：Java 越权审计 Demo

1. 创建任务：类型=code_audit，不填目标（留空会自动读取 demo）
2. 运行任务 → 观察步骤：解析文件 → Controller 识别 → 越权风险判断
3. 查看报告 → 见 Java 越权证据链（HIGH/MEDIUM/LOW 均有）
4. 步骤详情展示：risk_level/confidence/plan_source

### 演示流程 C：LLM 模式（需真实 LLM 服务）

1. 配置 `.env`: LLM_ENABLED=true + 真实的 LLM_BASE_URL/KEY/MODEL
2. Settings → 测试 LLM 连接
3. 创建任务并运行 → 步骤展示 plan_source=llm
4. 查看报告 → AI 辅助分析摘要

---

## 13. 测试结果

### 13.1 规则模式（LLM_ENABLED=false）

```
✅ /api/health 正常 (version: 2.0.0, llm_enabled: false)
✅ /api/llm/status 正常 (enabled: false)
✅ /api/llm/test 返回 "LLM is disabled" 提示
✅ web_scan 任务 → 规则计划 → 正常执行 → 报告生成
✅ code_audit 任务 → 规则计划 → Java 分析 → 报告含证据链
✅ log_analysis 任务 → 规则计划 → 正常执行
✅ 所有 Python 文件 AST 语法校验通过 (35/35)
```

### 13.2 Java 越权审计 Demo

```
✅ OrderController.java  → 3 个 HIGH 风险接口
✅ AccountController.java → 2 个 MEDIUM 风险接口
✅ UserController.java   → 4 个 LOW 风险接口
✅ 证据链输出含 file/class/method/path/params/auth_evidence
```

### 13.3 WebSocket

```
✅ /ws/tasks/{id} 接口注册成功
✅ 前端 WS 断开自动降级轮询逻辑已实现
✅ Executor 广播 step_created/task_status/report_ready 事件
```

---

## 14. 已知问题

1. **Executor 跨线程 WS 广播** 使用新建 event loop 方式，在极高并发时可能有性能开销。第三轮建议改用 asyncio.Queue + 后台协程。

2. **WS 代理配置** 开发模式下 Vite dev server 不自动代理 WS。若前端无法连接 WS，请确认 `vite.config.ts` 中的 proxy 配置包含 ws 路径（已配置，但需 Vite ≥ 4.3）。

3. **LLM Plan 解析** 若模型输出 JSON 格式不稳定，`extract_json` 可能解析失败，会自动 fallback。建议第三轮增加更鲁棒的 JSON 解析或强制 json_mode。

4. **JavaCodeAuditTool 正则** 当前使用正则提取方法体，对嵌套括号较深的 Java 代码可能匹配不完整。第三轮可考虑接入 tree-sitter Java grammar。

5. **ToolCenter 工具 schema** 目前输入/输出 schema 为前端静态配置（`TOOL_DETAILS`），第三轮可将 schema 移到工具类本身并通过 API 动态返回。

6. **SQLite 并发** 多个任务同时运行时，SQLite 可能存在写锁竞争。对演示场景足够，第三轮如需高并发建议换 PostgreSQL。

---

## 15. 第三轮建议开发内容

### 功能增强

1. **LLM 流式输出** — SSE/Stream 模式的 LLM 响应，前端显示 token-by-token 生成
2. **Agent 对话模式** — 允许用户在任务执行中途提问 / 修改计划
3. **内存持久化** — Memory 组件当前仅在内存，建议持久化到 Redis 或 SQLite
4. **多工具并行执行** — Executor 当前顺序执行，第三轮可引入并行步骤
5. **工具市场** — 支持动态加载 Python 插件（.py 文件上传注册）

### Java 审计深化

6. **tree-sitter 解析** — 替换正则，更精准的 Java AST 解析
7. **数据流追踪** — 追踪参数从 Controller → Service → DAO 的调用链（结合 java-route-tracer skill）
8. **Spring Security 配置解析** — 解析 SecurityConfig 类，识别哪些路径被保护

### 工程优化

9. **异步 Executor** — 将 Executor 改为 asyncio 协程，天然支持 WS 广播
10. **Alembic 数据库迁移** — 替换当前的 ALTER TABLE 方案，支持降级
11. **单元测试** — 为 Planner/Judge/JavaCodeAuditTool 补充单元测试
12. **任务队列** — 引入 Celery 或 asyncio.Queue，解决并发执行问题

---

## 16. 需要人工确认的问题

1. **Vite WS 代理** — 在容器内，前端通过 Vite dev server 的 WS 代理访问后端。如果 WebSocket 无法连接，请检查 `vite.config.ts` 中是否已开启 `ws: true` 的代理配置，并考虑在 Nginx 代理时转发 Upgrade 头。

2. **LLM API Key** — `.env` 中 `LLM_API_KEY=replace_me` 是占位符，需要替换为真实值才能启用 LLM 模式。该值仅存在于服务器环境变量，不会暴露给前端。

3. **生产环境 CORS** — 当前 CORS 设置为 `allow_origins=["*"]`，适合开发演示，生产部署前请根据实际域名限制。

4. **SQLite 路径** — 容器内 SQLite 数据库挂载到 `./data/cyberpilot.db`，请确保 podman/docker 挂载卷权限正确，否则重启后数据会丢失。

---

*CyberPilot Round 2 Summary | 生成时间: 2026-05-28*

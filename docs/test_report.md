# CyberPilot 测试报告

## 1. 测试环境

| 项目 | 版本 |
|------|------|
| 操作系统 | macOS Sonoma / Windows 11 / Linux Ubuntu 22.04 |
| Python | 3.11+ |
| Node.js | 20.x |
| Docker | 24.x |
| Docker Compose | v2.x |
| Podman | 4.x |

---

## 2. 功能测试项

### 2.1 后端 API 测试

| 接口 | 方法 | 预期结果 | 状态 |
|------|------|----------|------|
| /api/health | GET | `{"status":"ok","app":"CyberPilot"}` | ✅ |
| /api/tasks | POST | 创建任务，返回 Task 对象 | ✅ |
| /api/tasks | GET | 返回任务列表 | ✅ |
| /api/tasks/{id} | GET | 返回单个任务 | ✅ |
| /api/tasks/{id}/run | POST | 启动任务执行，返回 `{"message":"Task started"}` | ✅ |
| /api/tasks/{id}/steps | GET | 返回执行步骤列表 | ✅ |
| /api/tasks/{id}/report | GET | 返回 Markdown 报告 | ✅ |
| /api/tools | GET | 返回工具列表（6个工具） | ✅ |
| /api/upload | POST | 文件上传，返回路径信息 | ✅ |

### 2.2 Agent 流程测试

| 场景 | 步骤数 | 状态 |
|------|--------|------|
| Web 扫描 (http://example.com) | 5步 | ✅ |
| 代码审计 (Java ZIP) | 5步 | ✅ |
| 日志分析 (access.log) | 7步 | ✅ |
| 自动识别任务类型 | N/A | ✅ |

### 2.3 工具测试

| 工具 | 功能 | 状态 |
|------|------|------|
| FileParserTool | ZIP/Java/Log 文件识别 | ✅ |
| HttpFingerprintTool | HTTP GET + 信息提取 | ✅ |
| DirectoryProbeTool | 固定路径探测（7条） | ✅ |
| JSInterfaceExtractorTool | API 路径提取 | ✅ |
| JavaCodeAuditTool | Controller + 越权参数识别 | ✅ |
| LogAnalyzerTool | Top IP/Path + 异常统计 | ✅ |

---

## 3. API 测试

```bash
# 健康检查
curl http://localhost:8000/api/health

# 创建任务
curl -X POST http://localhost:8000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"测试Web扫描","task_type":"web_scan","target":"http://example.com"}'

# 运行任务（假设 task_id=1）
curl -X POST http://localhost:8000/api/tasks/1/run

# 查看步骤
curl http://localhost:8000/api/tasks/1/steps

# 查看报告
curl http://localhost:8000/api/tasks/1/report
```

---

## 4. 前端页面测试

| 页面 | URL | 状态 |
|------|-----|------|
| Dashboard | / | ✅ |
| 创建任务 | /tasks/new | ✅ |
| 任务列表 | /tasks | ✅ |
| 任务详情 | /tasks/:id | ✅ |
| 报告展示 | /tasks/:id/report | ✅ |
| 工具中心 | /tools | ✅ |
| 系统设置 | /settings | ✅ |

---

## 5. Podman 启动测试

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 \
  podman compose -f podman-compose.yml up -d --build
# 预期：2个容器成功启动

podman ps
# 预期输出包含:
#   cyberpilot-backend   Up
#   cyberpilot-frontend  Up
```

结果：✅ 通过

---

## 6. Podman 启动测试

```bash
podman-compose up -d --build
# 预期：2个容器成功启动
```

结果：✅ 通过（使用 podman-compose 0.1.11）

---

## 7. Windows 兼容性检查

| 检查项 | 状态 |
|--------|------|
| PowerShell 启动脚本存在（.ps1） | ✅ |
| Python 代码使用 pathlib.Path | ✅ |
| 不依赖 bash-only 脚本 | ✅ |
| Podman Desktop 启动命令说明 | ✅ |

---

## 8. macOS M 系列兼容性检查

| 检查项 | 状态 |
|--------|------|
| Dockerfile 不写死 platform | ✅ |
| 使用多架构官方镜像 | ✅ |
| python:3.11-slim 支持 arm64 | ✅ |
| node:20-alpine 支持 arm64 | ✅ |
| README 包含 Apple Silicon 说明 | ✅ |

---

## 9. 已知问题

1. **任务并发执行**：当前使用 Python threading，多任务同时执行可能存在竞态（第二轮改为 AsyncIO 或 Celery）
2. **LLM 未接入**：第一轮 Planner 和 Judge 均为规则化实现，需第二轮接入 LLM
3. **前端无 WebSocket**：步骤更新依赖轮询（3秒间隔），第二轮改为 WebSocket 实时推送
4. **文件扫描限制**：JavaCodeAuditTool 最多分析 50 个 Java 文件，大型项目需优化
5. **HttpFingerprintTool 超时**：部分网络环境下请求目标可能较慢，已设置 10 秒超时

---

## 10. v3 新增测试计划

后端新增 pytest 覆盖：

- Planner intent tests
- upload/create/run file_path tests
- JavaCodeAuditTool ZIP tests
- LogAnalyzerTool common/JSON/Spring tests
- JSInterfaceExtractorTool URL/file tests
- Safety/PolicyEngine tests
- Reporter tests

推荐命令：

```bash
cd backend && python3 -m pytest -q
cd frontend && npm run build
podman compose config
```

WebSocket 验证：

- 前端连接 `/ws/tasks/{task_id}`
- 失败时自动轮询
- 重跑任务时收到 `task_reset` 并清空旧步骤

---

## 11. v4 FinalOps 交付前回归结果

| 命令 | 结果 |
|------|------|
| `cd backend && python3 -m compileall app` | ✅ 通过 |
| `cd backend && python3 -m pytest -q` | ✅ 16 passed |
| `cd frontend && npm install && npm run build` | ✅ 通过，0 vulnerabilities |
| `make test` | ✅ 通过 |
| `make demo-smoke` | ✅ Java / 日志 / Web 三场景通过 |
| `make release-check` | ✅ 通过；当前非 git 仓库，git tracked 检查跳过 |
| `make team-drill` | ✅ 覆盖混合题型、误报、阻断、人工回填和 LLM fallback |
| `make safety-audit` | ✅ 生成 `safety_audit_report.md` |
| `make package` | ✅ 生成 `dist/cyberpilot-finalops-v4-submission.zip` 和 `SHA256SUMS` |
| `podman compose -f podman-compose.yml config` | ✅ 通过 |
| `COMPOSE_PROJECT_NAME=cyberpilot_v4 podman compose -f podman-compose.yml config` | ✅ 通过 |
| `COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 podman compose -f podman-compose.yml up -d --build` | ✅ 通过 |
| `curl http://localhost:18000/api/health` | ✅ 返回 v4 health、DB ok、storage writable |
| `curl http://localhost:13000` | ✅ HTTP 200 |

说明：本机存在旧的 CyberPilot 容器，因此容器启动验证使用独立 project name 和替代端口，验证后已执行 down，不影响旧容器。

# 第一轮开发总结

> 本文档用于第二轮开发交接，请将此文件完整发送给下一个 Agent。

---

## 1. 本轮完成内容

第一轮完成了 CyberPilot 的 MVP 基础框架，包括：

1. **FastAPI 后端** - 完整 API 实现，含任务管理、工具查询、文件上传、报告生成
2. **React 前端** - 7 个功能页面，深色赛博风 UI，全程可视化
3. **SQLite 数据库** - 4 张表，本地挂载，容器删除数据不丢失
4. **Agent Core** - Planner / Executor / ToolRegistry / Memory / Judge / Reporter 六大模块
5. **6 个工具插件** - 覆盖 Web 扫描、代码审计、日志分析三大场景
6. **Docker + Podman 双容器部署** - 单个 `docker compose up` 或 `podman-compose up` 即可启动
7. **跨平台支持** - Windows PowerShell 脚本 + macOS Apple Silicon 多架构镜像
8. **完整文档** - README / design.md / deploy.md / user_manual.md / test_report.md

---

## 2. 当前项目结构

```
cyberpilot/
├── backend/
│   ├── app/
│   │   ├── main.py                    # FastAPI 入口，CORS，路由注册
│   │   ├── config.py                  # Pydantic Settings 配置
│   │   ├── database.py                # SQLAlchemy + SQLite 初始化
│   │   ├── models/
│   │   │   ├── task.py                # Task ORM 模型
│   │   │   ├── step.py                # Step ORM 模型
│   │   │   ├── report.py              # Report ORM 模型
│   │   │   └── tool.py                # Tool ORM 模型
│   │   ├── schemas/
│   │   │   ├── task.py                # TaskCreate / TaskOut
│   │   │   ├── step.py                # StepOut
│   │   │   └── report.py              # ReportOut
│   │   ├── api/
│   │   │   ├── tasks.py               # /api/tasks 全部接口
│   │   │   ├── tools.py               # /api/tools
│   │   │   ├── reports.py             # /api/reports/{task_id}
│   │   │   └── upload.py              # /api/upload
│   │   ├── core/
│   │   │   ├── planner.py             # Planner + 预置计划
│   │   │   ├── executor.py            # Executor 执行引擎
│   │   │   ├── tool_registry.py       # ToolRegistry 单例
│   │   │   ├── memory.py              # Memory 上下文存储
│   │   │   ├── judge.py               # Judge 规则化评估
│   │   │   └── reporter.py            # Reporter Markdown 报告生成
│   │   ├── tools/
│   │   │   ├── base.py                # BaseTool 抽象类
│   │   │   ├── file_parser.py         # FileParserTool
│   │   │   ├── http_fingerprint.py    # HttpFingerprintTool
│   │   │   ├── directory_probe.py     # DirectoryProbeTool
│   │   │   ├── js_interface_extractor.py  # JSInterfaceExtractorTool
│   │   │   ├── java_code_audit.py     # JavaCodeAuditTool
│   │   │   └── log_analyzer.py        # LogAnalyzerTool
│   │   └── storage/
│   │       ├── uploads/               # 上传文件存储
│   │       └── reports/               # 报告文件存储
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api/
│   │   │   └── index.ts               # Axios 封装 + TypeScript 类型定义
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx          # 首页数据看板
│   │   │   ├── CreateTask.tsx         # 创建任务（含文件上传）
│   │   │   ├── TaskList.tsx           # 任务列表（含状态自动刷新）
│   │   │   ├── TaskDetail.tsx         # 任务详情（步骤时间线，3s轮询）
│   │   │   ├── ToolCenter.tsx         # 工具中心
│   │   │   ├── ReportView.tsx         # 报告展示（Markdown 渲染）
│   │   │   └── Settings.tsx           # 系统设置
│   │   ├── App.tsx                    # 路由 + 侧边栏
│   │   ├── main.tsx                   # React 入口
│   │   └── index.css                  # Tailwind + 自定义样式
│   ├── package.json
│   ├── vite.config.ts                 # Vite 配置（proxy /api → backend）
│   └── Dockerfile
├── data/
│   └── .gitkeep                       # 数据库目录占位
├── docs/
│   ├── design.md                      # 系统设计文档
│   ├── deploy.md                      # 部署文档
│   ├── user_manual.md                 # 用户手册
│   ├── test_report.md                 # 测试报告
│   └── round1_summary.md              # 本文档
├── scripts/
│   ├── start.sh                       # Docker 启动（bash）
│   ├── stop.sh                        # Docker 停止（bash）
│   ├── start.ps1                      # Docker 启动（PowerShell）
│   ├── stop.ps1                       # Docker 停止（PowerShell）
│   ├── start-podman.sh                # Podman 启动（bash）
│   ├── stop-podman.sh                 # Podman 停止（bash）
│   ├── start-podman.ps1               # Podman 启动（PowerShell）
│   └── stop-podman.ps1                # Podman 停止（PowerShell）
├── docker-compose.yml
├── podman-compose.yml
├── .env.example
├── Makefile
└── README.md
```

---

## 3. 已实现后端接口

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | /api/health | 健康检查，返回 `{"status":"ok","app":"CyberPilot"}` |
| POST | /api/tasks | 创建任务（title, description, task_type, target） |
| GET | /api/tasks | 获取所有任务列表（倒序） |
| GET | /api/tasks/{task_id} | 获取单个任务详情 |
| POST | /api/tasks/{task_id}/run | 启动任务执行（后台线程） |
| GET | /api/tasks/{task_id}/steps | 获取任务执行步骤列表 |
| GET | /api/tasks/{task_id}/report | 获取任务 Markdown 报告 |
| GET | /api/tools | 获取已注册工具列表 |
| POST | /api/upload | 上传文件（multipart/form-data） |
| GET | /api/reports/{task_id} | 同 /api/tasks/{task_id}/report |

Swagger UI 文档：`http://localhost:8000/docs`

---

## 4. 已实现前端页面

| 页面 | 路径 | 功能 |
|------|------|------|
| Dashboard | / | 统计卡片（总任务/完成/失败/工具数）+ 最近任务列表 |
| 创建任务 | /tasks/new | 表单（标题/描述/类型/URL/文件上传）+ 创建/运行 |
| 任务列表 | /tasks | 表格展示所有任务 + 状态自动刷新（5s）+ 运行/查看操作 |
| 任务详情 | /tasks/:id | 基本信息 + 执行步骤时间线（可展开）+ 3s 轮询刷新 |
| 报告展示 | /tasks/:id/report | Markdown 渲染 + 下载 MD 文件 |
| 工具中心 | /tools | 工具卡片展示（名称/分类/描述/状态） |
| 系统设置 | /settings | 当前配置展示 + 快速链接 |

---

## 5. 已实现 Agent Core 模块

### Planner

- 规则化任务类型识别（web_scan / code_audit / log_analysis / reverse_helper / auto）
- 4 套预置执行计划（每套 4-7 步）
- `classify_task()` 方法，预留 LLM 接口

### Executor

- 按 PlanStep 顺序执行
- 自动跳过 "Reporter" 伪工具
- 工具不存在时记录 skipped 步骤
- 异常捕获包装（`safe_run`）
- 每步落库 Step 记录
- 任务状态全程更新

### ToolRegistry

- 单例模式，全局唯一实例
- 启动时自动注册 6 个默认工具
- `get(name)` / `list_tools()` / `all_names()` 接口

### Memory

- 任务独立实例
- key-value 上下文存储
- 步骤结果历史记录
- `summarize()` 生成文本摘要

### Judge

- 规则化评估 7 类动作
- 返回中文 next_decision 字符串
- 预留 LLM 评估接口位置

### Reporter

- 生成标准 7 章 Markdown 报告
- 风险提取（含"越权"/"HIGH"/"可疑"关键词）
- 修复建议（5 条默认建议）
- 同步保存到 SQLite 和本地文件

---

## 6. 已实现工具插件

### FileParserTool

- 支持：.zip / .java / .py / .js / .ts / .html / .json / .md / .log / .txt / 二进制文件
- ZIP 文件：列出目录结构，识别项目类型（java_project / frontend_project / log_files / binary_files）
- 输出：文件类型、项目类型、文件数量、顶层目录

### HttpFingerprintTool

- 对目标 URL 执行 HTTP GET（follow redirects）
- 提取：状态码、页面标题、Server、Content-Type、X-Powered-By、响应大小
- 超时：10 秒
- 异常捕获：TimeoutException 和其他网络错误

### DirectoryProbeTool

- 探测 7 条固定安全路径：`/` `/robots.txt` `/sitemap.xml` `/favicon.ico` `/login` `/admin` `/.well-known/security.txt`
- 超时：8 秒
- 不并发、不爆破

### JSInterfaceExtractorTool

- 正则提取：`/api/xxx` `/v1/xxx` `/admin/xxx` `/auth/xxx` `/user/xxx` 等
- 支持文件路径或直接传入 content
- 输出去重后的接口列表

### JavaCodeAuditTool

- 识别 `@RestController` / `@Controller`
- 提取 `@RequestMapping` / `@GetMapping` / `@PostMapping` 等注解路径
- 识别高风险参数：userId / accountId / orderId / adminId / tenantId / companyId / orgId / customerId / memberId / ownerId
- 检测鉴权逻辑：`@PreAuthorize` / `@Secured` / `checkPermission` / `hasPermission` 等
- 无鉴权 + 高风险参数 → HIGH 风险；有鉴权 → LOW 风险
- 支持 ZIP 包（最多分析 50 个 Java 文件）
- Demo 模式：无文件时返回示例结果

### LogAnalyzerTool

- 解析标准 Combined Log Format（Apache/Nginx）
- 统计 Top 10 IP、Top 10 Path
- 分类 4xx / 5xx 请求
- 识别可疑路径：/admin / /login / /wp-admin / /phpmyadmin / /.env / /actuator / /console / /manager / /.git 等
- Demo 模式：无文件时返回示例日志结果

---

## 7. 数据库表结构

### tasks 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 任务 ID |
| title | VARCHAR(256) | 任务标题 |
| description | TEXT | 任务描述 |
| task_type | VARCHAR(64) | 任务类型（web_scan/code_audit/log_analysis/reverse_helper/auto） |
| target | VARCHAR(512) | 目标 URL 或文件路径 |
| status | VARCHAR(32) | 状态（created/planning/running/completed/failed） |
| uploaded_file | VARCHAR(512) | 上传文件路径 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### steps 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 步骤 ID |
| task_id | INTEGER FK | 关联任务 ID |
| step_index | INTEGER | 步骤序号 |
| phase | VARCHAR(64) | 阶段（planning/execution/reporting） |
| action | VARCHAR(128) | 动作名称 |
| reason | TEXT | 执行原因 |
| tool_name | VARCHAR(128) | 使用工具 |
| input_summary | TEXT | 输入摘要 |
| output_summary | TEXT | 输出摘要 |
| next_decision | TEXT | 下一步决策 |
| status | VARCHAR(32) | 状态（success/failed/skipped） |
| created_at | DATETIME | 创建时间 |

### reports 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 报告 ID |
| task_id | INTEGER FK UNIQUE | 关联任务 ID |
| content | TEXT | Markdown 报告内容 |
| file_path | VARCHAR(512) | 本地文件路径 |
| created_at | DATETIME | 创建时间 |

### tools 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 工具 ID |
| name | VARCHAR(128) UNIQUE | 工具名称 |
| description | TEXT | 工具描述 |
| category | VARCHAR(64) | 分类（web/code/file/log/general） |
| enabled | BOOLEAN | 是否启用 |
| input_schema | TEXT | 输入格式说明 |
| output_schema | TEXT | 输出格式说明 |

---

## 8. Docker / Podman 启动方式

### Docker

```bash
cd cyberpilot
cp .env.example .env
docker compose up -d --build
```

停止：

```bash
docker compose down
```

查看日志：

```bash
docker logs -f cyberpilot-backend
docker logs -f cyberpilot-frontend
```

### Podman

```bash
cp .env.example .env
podman-compose up -d --build
# 或
podman compose up -d --build
```

停止：

```bash
podman-compose down
```

### 访问地址

- 前端：http://localhost:3000
- 后端：http://localhost:8000
- API 文档：http://localhost:8000/docs

---

## 9. Windows / macOS Apple Silicon 兼容情况

### Windows

- ✅ 提供 `scripts/start.ps1` / `stop.ps1`（Docker）
- ✅ 提供 `scripts/start-podman.ps1` / `stop-podman.ps1`（Podman）
- ✅ Python 代码全部使用 `pathlib.Path` 处理路径
- ✅ 不依赖 bash 脚本作为唯一入口
- ✅ README 包含 PowerShell 启动命令

### macOS Apple Silicon (M1/M2/M3/M4)

- ✅ 后端 Dockerfile：`FROM python:3.11-slim`（官方多架构镜像，支持 arm64）
- ✅ 前端 Dockerfile：`FROM node:20-alpine`（官方多架构镜像，支持 arm64）
- ✅ docker-compose.yml 不写死 `platform: linux/amd64`
- ✅ README 包含 Apple Silicon 支持说明
- ✅ 理论可在 arm64 原生构建运行

---

## 10. 当前可演示流程

**演示流程 1：Web 安全扫描**

1. 进入"创建任务"页面
2. 填写：标题=`测试 Web 目标分析`，类型=`web_scan`，目标=`http://example.com`
3. 点击"创建并运行"
4. 进入任务详情页，观察步骤时间线实时更新：
   - Step 1: 文件解析（planning）
   - Step 2: HTTP 指纹识别（execution）
   - Step 3: 安全路径探测（execution）
   - Step 4: JS 接口提取（execution）
   - Step 5: 报告生成（reporting）
5. 点击"查看报告"，看到完整 Markdown 安全分析报告

**演示流程 2：Java 代码审计**

1. 创建任务，类型=`code_audit`，描述=`分析 Java 项目中的水平越权风险`
2. （可选）上传 Java 项目 ZIP 文件
3. 运行任务，观察步骤：Controller识别 → 参数识别 → 越权判断
4. 查看报告中的风险发现章节

**演示流程 3：日志应急分析**

1. 创建任务，类型=`log_analysis`
2. 上传 access.log 文件（或不上传，使用 Demo 数据）
3. 运行任务，观察步骤：日志解析 → Top IP → Top Path → 异常状态码 → 可疑路径
4. 查看报告中的异常访问分析

---

## 11. 已知问题

1. **并发执行**：使用 Python `threading.Thread`，不适合高并发场景，需改为 AsyncIO 或 Celery
2. **LLM 未接入**：Planner 和 Judge 均为规则化，需第二轮接入
3. **轮询刷新**：前端步骤更新依赖 3-5 秒轮询，体验不够实时，需改为 WebSocket
4. **JavaCodeAuditTool 限制**：最多分析 50 个 Java 文件，大型项目需分批处理
5. **数据库路径**：Docker 内数据库路径为 `/app/data/cyberpilot.db`，本地开发为 `./data/cyberpilot.db`，需注意
6. **前端 proxy**：Vite dev proxy 针对 `/api` 转发，生产环境需要 Nginx 配置
7. **ToolRegistry 工具状态**：当前 `tools` 表未自动同步注册工具，第二轮可优化

---

## 12. 下一轮建议开发内容

优先级排序：

**高优先级（P0）**

1. **接入 LLM**：
   - 实现 `LLMClient`（OpenAI compatible API）
   - Planner 支持 LLM 动态生成执行计划
   - Judge 支持 LLM 评估工具结果
   - 配置 `LLM_ENABLED=true` 后自动切换

2. **WebSocket 实时日志**：
   - 后端：使用 FastAPI WebSocket 推送步骤更新
   - 前端：替换轮询为 WebSocket 订阅

**中优先级（P1）**

3. **增强 Java 越权审计**：
   - 数据流分析（参数从 request 到 DB 的完整链路）
   - 结合 java-route-tracer 技术
   - 支持更多框架（Struts 2 / JAX-RS）

4. **Chrome 浏览器自动化**：
   - 集成 Playwright 或 Selenium
   - 支持动态页面 JS 渲染后的接口提取

5. **MCP 工具适配**：
   - 接入 MCP（Model Context Protocol）
   - 支持外部工具插件通过 MCP 接入

**低优先级（P2）**

6. **报告导出 PDF**：使用 weasyprint 或 puppeteer
7. **用户确认高风险操作机制**：对 HIGH 风险操作弹框确认
8. **评测样例和演示视频脚本**
9. **任务模板**：预置常用安全分析任务模板
10. **结果对比视图**：同类型任务对比分析

---

## 13. 需要人工确认的问题

1. **LLM 接入方式**：第二轮使用 Ollama 本地部署还是云端 API？推荐配置是什么？
2. **演示环境**：比赛现场是否有网络访问许可？能否访问外部目标 URL？
3. **真实漏洞利用**：第二轮是否需要实现超出 MVP 范围的真实漏洞探测（如 SQLi 检测）？
4. **Java 审计深度**：第二轮代码审计是否需要处理反编译 `.class`/`.jar` 文件？
5. **评测指标**：比赛评委更关注哪个维度——工程架构、AI 能力、安全深度还是可解释性？
6. **认证机制**：是否需要添加 API Token 认证？
7. **数据持久化**：演示结束后需要保留数据吗？是否需要数据库备份/导出功能？

---

*CyberPilot Round 1 Summary | 第一轮开发完成 | 准备进入第二轮*

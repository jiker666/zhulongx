# XH-202609 开发文档

| 项目 | 内容 |
| --- | --- |
| 文档编号 | XH-202609-02 |
| 版本 | 1.0 |
| 对应代码基线 | `723f047`（`main`） |
| 读者 | 开发人员、测试人员、部署维护人员 |
| 编制日期 | 2026-08-31 |

## 1. 开发原则

本项目是安全智能体运行时，模型不是安全边界。开发工作必须遵守以下不变量：核心任务循环保持领域中立；所有主动网络能力经 `PolicyEngine` 和 operator-owned scope；单次运行不能扩权；可能阻塞的工具接受 `AbortSignal` 且返回有界输出；运行产物不保存模型 Key、Authorization、Cookie 或隐藏推理。`npm run check` 是唯一合并门禁。

编排行为的回归测试只使用确定性 faux-model 或 faux-runner。真实模型和真实目标测试属于显式启用的评测套件，不可替代单元测试，也不可把题目特例、站点选择器、固定 Flag 或答案模板写入通用运行时。

## 2. 环境与依赖

| 项目 | 要求或说明 |
| --- | --- |
| Node.js | `>=22.19.0`；本次验证使用 `v26.3.0` |
| 包管理器 | npm，依赖版本以 lockfile 为准 |
| 后端 | TypeScript、ESM、Node HTTP 服务 |
| 前端 | React 19、TypeScript、Vite、React Router、TanStack Query、XYFlow、Lucide、原生 CSS |
| 测试 | Vitest、TypeScript、ESLint；默认无真实模型请求 |
| 可选隔离环境 | Docker / Docker Compose，提供无外网 CTF sandbox |

安装依赖：

```bash
npm ci --legacy-peer-deps --ignore-scripts
npm --prefix frontend ci --ignore-scripts
```

本地模型密钥只能保存在被 Git 忽略的 `.env` 或 operator 私有环境中：

```bash
cp .env.example .env
```

严禁将 `.env`、运行目录、私有 scope、附件、平台 Token、Cookie、Authorization 或题目答案暂存、提交或放入测试截图。

## 3. 代码结构与模块边界

| 路径 | 职责 | 关键约束 |
| --- | --- | --- |
| `src/runtime.ts` | 任务生命周期、状态转换、持久化、工具清理和终态处理 | 不绕过策略执行工具 |
| `src/policy.ts` | scope、路径/主机/端口/程序、预算、重复动作与停滞门禁 | 不相信模型自报范围 |
| `src/tools.ts` | 有界 AgentTool 总线 | 每个调用产生可关联审计 |
| `src/sandbox.ts` | Unix socket sidecar 和结构化命令协议 | `spawn(program, args)`；不使用 Shell |
| `src/audit.ts` | 顺序事件与 SHA-256 前向哈希 | 原始事实不可被人工复核覆盖 |
| `src/trace.ts` | 审计投影、持久化加载、历史运行列表 | 详情读取完整状态，列表读取轻量摘要 |
| `src/run-summary.ts` | `summary.json` 投影与格式校验 | 仅保存脱敏、限长列表字段 |
| `src/run-recovery.ts` | 服务重启后的遗留运行结算 | no-replay，避免重复副作用 |
| `src/submission-policy.ts` | 严格任务的候选值与独立验证闸门 | 不从自由文本推断 submission |
| `src/writeup-generator.ts` | 终态运行的受限 WP 生成、验证和重试 | 不暴露隐藏推理或敏感凭据 |
| `src/server.ts` | 健康检查、认证、运行、设置、复核和 WP API | 控制面不允许远程扩权 |
| `frontend/src/features/` | 决策流、证据图、策略、实时合并和 WP 投影 | 只消费真实状态和审计事件 |
| `frontend/src/pages/` | 控制台、运行详情、模型设置等页面 | 不以 UI 推断隐藏思维 |
| `test/` | faux-model 与策略、预算、审计、恢复回归测试 | 默认不得调用真实模型或真实目标 |

## 4. 本地开发流程

### 4.1 后端与 sandbox

```bash
# 后端开发服务
npm run serve

# 另开终端，按需启动本地加固 sandbox
mkdir -p workspace .xuan-shu/work
sh tools/ctf/run-local-sandbox.sh
npm run sandbox-health
```

本地服务默认地址为 `http://127.0.0.1:7318/`。绑定非回环地址时必须提供 `XUANSHU_SERVER_TOKEN`。sandbox 仅执行 operator allowlist 中的结构化程序；命令输出和等待时间由运行时预算限制。

### 4.2 前端开发

```bash
npm --prefix frontend run dev
```

Vite 开发服务默认位于 `http://127.0.0.1:5173/`，并代理本地 API。Run Detail 的事实来源是 `/v1/runs/:id`、`/trace` 与 SSE 事件；修改投影逻辑时，应同时检查实时合并、历史回放、策略拒绝和终态结论场景。

### 4.3 模型接入

控制台的“模型设置”页可为**当前 API 进程**临时配置 OpenAI-compatible Base URL、API 类型、模型/部署 ID、API Key、可选 AppKey 和推理格式。页面配置只在进程内存中保存，不写入浏览器持久存储、审计链或运行产物，服务重启后失效。

无人值守环境应使用被忽略的私有 overlay 和环境变量。模型或网关配置不能包含在公共 YAML、文档示例、截图或 Git 历史中。有关默认字段和安全边界见 [模型设置](../model-settings.md)。

## 5. 新工具与新能力的工程门禁

新增模型可调用工具必须在同一改动中完成：

1. 定义 TypeBox 输入模式、明确的错误语义和输出上限。
2. 为所有等待、I/O、子进程或网络操作接入并传播 `AbortSignal`。
3. 在 `PolicyEngine` 中定义 scope、路径、主机、端口、程序和预算规则；不得以工具内部代码创建绕过通道。
4. 写入带调用关联 ID 的策略决策和工具结果审计事件。
5. 使用确定性测试覆盖允许、拒绝、预算耗尽、取消和错误分类。
6. 更新 [工具副作用与审计契约](../tool-side-effects.md)，说明读写范围、网络影响、资源风险和人工前置条件。
7. 在前端轨迹中为新事件提供可读、事实性的投影，而不是模拟模型思维。

新增 sandbox program 还需同步更新锁定依赖、`tools/ctf/capabilities.json`、operator allowlist、构建期 smoke check 和 sandbox health。程序安装并不自动授予运行时权限。

## 6. 持久化、恢复与兼容性

每个运行的完整事实保存在 `.xuan-shu/runs/<run-id>/`。关键文件包括 `state.json`、`findings.json`、`transcript.json`、`audit.jsonl`、`reviews.jsonl` 和脱敏 `handoff.md`。完整状态用于详情、回放和审计；`summary.json` 是面向运行列表的轻量索引，包含 ID、状态、阶段、截断任务摘要、时间、回合数、工具数、经验数和血缘信息。

`723f047` 引入摘要优先列表读取：历史运行不存在或损坏摘要时，列表返回 `indexing` 占位并异步回填摘要；不会删除或重写原 `state.json`。服务启动时，`run-recovery.ts` 对遗留 `queued/running` 状态追加恢复事件并结算为 `aborted`，不会重放无法确认完成情况的工具调用。开发修改持久化格式时必须保持此恢复和降级语义，并补充兼容测试。

## 7. 测试与质量门禁

日常修改至少执行：

```bash
git diff --check
npm run check
npm --prefix frontend run build
```

`npm run check` 顺序执行 typecheck、ESLint、确定性 Vitest 测试和后端生产构建。仓库测试命令使用 `--no-file-parallelism`，以降低 sandbox 健康探针并发启动造成的非确定性超时。需要验证 Compose 语法时执行：

```bash
XUANSHU_SERVER_TOKEN=validation-only docker-compose config
```

有 Docker daemon 的交付环境还应完成 `docker compose up -d --build`、sandbox/API health、页面登录和一次只读运行的冒烟测试，并记录镜像摘要。不要把配置解析成功表述为镜像构建或容器启动成功。

## 8. 调试与故障定位

| 现象 | 优先检查 | 处理原则 |
| --- | --- | --- |
| 工具请求被拒绝 | 运行的 policy 事件、scope、allowlist、预算、重复动作 | 调整 operator 配置或计划，不能通过 per-run override 扩权 |
| 运行卡在恢复/终止 | `audit.jsonl`、`handoff.md`、状态和恢复事件 | 确认 no-replay 语义，不手工重放未知副作用 |
| 前端未更新 | 服务令牌、SSE、`/trace`、浏览器控制台 | 使用稳定序号回放，避免重复写入 UI 状态 |
| 历史列表缓慢 | `summary.json` 是否存在、是否显示 indexing | 让后台回填完成；详情仍可独立读取完整状态 |
| WP 生成失败 | 终态状态、submission、验证记录、`writeup.*` 审计事件 | 只使用公开事实重试；不可补造脚本、答案或凭据 |
| sandbox 不健康 | `npm run sandbox-health`、socket、能力 manifest | 不临时放开程序白名单或网络限制 |

## 9. 提交规范

提交前确认改动边界、敏感信息和验证记录。提交信息应说明可观察的行为变化，例如 `fix: index persisted run summaries`；安全边界、工具副作用、持久化格式或前端事实投影发生变化时，必须同时更新相应测试和文档。合并前以 `git status --short` 复核暂存内容，确保无 `.env`、`.xuan-shu/`、`workspace/` 私有材料、模型凭据或未公开题目附件。

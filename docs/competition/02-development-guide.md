# 开发文档

## 1. 开发环境

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=22.19.0` |
| 包管理器 | npm |
| 后端 | TypeScript、ESM |
| 前端 | React/Vite，位于 `frontend/` |
| 测试 | Vitest、ESLint、TypeScript |

安装依赖时不将密钥写入源码或 YAML。复制 `.env.example` 为本地 `.env`，只在该被忽略的文件中填写所使用模型供应商的环境变量。

```bash
npm install --legacy-peer-deps --ignore-scripts
npm --prefix frontend ci --ignore-scripts
```

## 2. 模块边界

| 路径 | 责任 |
| --- | --- |
| `src/runtime.ts` | 生命周期、状态转换、持久化与 tool cleanup |
| `src/run-summary.ts` | 运行列表轻量摘要投影；完整状态仅由详情接口读取 |
| `src/knowledge-store.ts` | 首次规划前的本地知识检索、来源/信任标记和有界上下文 |
| `src/submission-policy.ts` | 题库/严格任务的候选提交格式、证据 grounding 和独立验证闸门 |
| `src/handoff.ts` | 脱敏运行交接摘要，支持恢复、人工交接和故障复盘 |
| `src/policy.ts` | scope、路径/主机/端口/程序、预算与停滞门禁 |
| `src/tools.ts` | 有界 AgentTool 与结构化工具总线 |
| `src/artifact-tools.ts` | ZIP 解压和二进制字节搜索等本地受限材料工具 |
| `src/sandbox.ts` | Unix socket sidecar 协议与结构化命令执行 |
| `src/audit.ts` | 追加式哈希链审计 |
| `src/session-trajectory.ts`、`src/trace.ts` | 轨迹事件、上下文投影、初学者行动说明 |
| `src/tool-catalog.ts` | 工具描述、策略元数据和模型可见目录 |
| `frontend/src/features/decision-stream/` | 审计事件到前端决策流的投影、实时合并与可读标签 |
| `frontend/src/features/writeup/` | 结构化 WP 渲染、Flag/最终提交和可下载报告 |
| `frontend/src/pages/ModelSettingsPage.tsx` | 当前 API 进程的 OpenAI-compatible 模型临时配置 |
| `test/` | 确定性 faux-model 与策略、预算、审计、运行时回归测试 |

## 3. 新增工具的工程门禁

任何新的模型可调用工具必须同时满足以下条件：

1. 定义 TypeBox 输入模式和有界输出。
2. 阻塞工作接受并传播 `AbortSignal`。
3. 通过 `PolicyEngine` 和 operator-owned scope；不得自行创建网络或执行权限。
4. 定义预算消耗、策略规则和错误分类。
5. 追加可关联的审计事件，并在前端轨迹中提供可读说明。
6. 编写策略/预算/取消行为的确定性测试。
7. 在 [../tool-side-effects.md](../tool-side-effects.md) 记录副作用和数据边界。

`extract_archive` 与 `search_artifact` 是本次二进制方向扩展的参考实现：前者只写入 run scratch，后者只读材料；两者均有资源限制、取消信号、策略测试、审计事件与副作用文档。

## 4. 配置与密钥

- 配置文件由 operator 管理，定义 `scope`、允许主机、程序 allowlist、预算与模型接入信息。
- API Key 只通过环境变量读取，禁止提交到 `.env`、配置样例、运行产物或审计链。
- 托管评测的网关地址、额外请求头和运行约束由主办方提供的私有配置 overlay 管理，不进入公共仓库。
- per-run scope override 只能收窄已有权限，不能添加主机、程序、路径或把 `observe` 提升为 `controlled`。

## 5. 本地开发与验证

```bash
# 后端静态检查、lint、串行确定性测试与构建；这是合并门禁
npm run check

# 前端构建
npm --prefix frontend run build

# Docker Compose 语法校验（需要 docker-compose 或 docker compose）
XUANSHU_SERVER_TOKEN=validation-only docker-compose config

# 启动审计台（仅在已配置本地环境变量时）
npm run serve
```

开发时优先使用 faux-model 测试覆盖编排行为。真实模型或真实目标的验证属于显式 opt-in 评测，不应成为默认回归测试的一部分。

`npm test` 使用 `--no-file-parallelism` 顺序执行测试文件。sandbox 测试包含 500ms 级别的受控探针，串行运行可以避免并发启动抖动造成非确定性超时；测试逻辑本身仍保持并行安全。

## 6. 提交前检查

```bash
git diff --check
npm run check
npm --prefix frontend run build
git status --short
```

提交前确认 `.env`、`.xuan-shu/`、截图中的敏感字段、测试题答案和私有附件均未被暂存。

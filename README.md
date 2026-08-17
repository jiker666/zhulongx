# 烛龙·玄枢

面向授权网络安全任务的自主决策智能体运行时。玄枢基于 Pi Agent Harness，让模型负责选择下一步动作，让运行时负责作用域、预算、隔离、审计和停止条件。

当前版本为 `0.2.2`。它适合本地材料分析、CTF、安全实验室和自建评测，不应被用于未授权目标。

## 核心能力

- 归一化文本、JSON/YAML/HAR/CSV、目录、ZIP 和二进制附件，所有预览均有上限。
- 对 JPEG、PNG、GIF、WebP 附件提供有界 `observe_image` 视觉观察；图片只进入支持视觉输入的模型上下文，不写入审计或 transcript。
- 强制执行 `任务理解 -> 计划 -> 行动/观察 -> checkpoint -> 证据 -> 完成/阻塞` 状态机。
- 按题型加载 9 类经过归一化审查的开源 CTF skill 索引；skill 只提供策略候选，不继承外部工具权限。
- Crypto/Misc core profile 提供可构建验证的 ECM、PARI/GP、fpylll、Z3、OR-Tools、Pickora、OCR、音频/调制解码和常见图像隐写工具。
- RE/PWN core profile 提供固定版本的 Radare2、JADX、Pwntools、gdb-multiarch、ltrace 和 binutils 辅助命令；归档提取与字节搜索也可在没有完整 sandbox 时以本地有界工具执行。
- 工具失败或策略拒绝后，必须分类失败、修订计划并说明新的行动依据。
- 只读输入、逐运行 scratch、结构化沙箱命令，以及受策略约束的 HTTP/TCP 工具。
- 可选 Playwright Chromium 运行时提供受控浏览器会话；导航、交互、DOM 与网络摘要仍由 `WebActionGuard`、`PolicyEngine`、scope 和独立预算约束。
- 主机、程序、路径、轮次、工具调用、请求、输出、重复动作和总时长预算。
- 每次运行可启用附件专属工作区；Arena 运行只暴露当前题目的只读附件，图片预算由 `runtime.maxImageBytes`、`runtime.maxImageObservations` 控制，并由 `runtime.finalizationReserveMs` 预留收尾时间。
- 同题多 agent 竞速使用有界共享证据板交换事实、候选和 dead-end；每个 agent 保留独立 scratch，且必须独立复核共享内容。
- Adaptive Campaign 将长任务拆成带租约的调查 work item，由多个 lane 并行探索；curator 整理公开证据，失败路径才按层升级。前端“自主编排”页面展示认领、Run、整理、升级和独立验证。
- JSONL SHA-256 前向哈希审计链；系统提示词、公开模型上下文、工具请求、策略判定、工具结果、上下文注入和运行血缘写入同一条追加事件流，隐藏推理、凭据和图片像素明确不持久化。
- 面向网安初学者的行动轨迹用“做什么、为什么、影响、结果、下一步”解释每个步骤，并支持按模型/上下文/策略/工具/子 Agent 来源筛选、搜索、历史回放和从指定事件创建分支。
- 服务重启时以持久状态和审计链重建运行视图；未结算运行会明确标记为中断，绝不自动重放可能已有副作用的工具调用。
- 持久可寻址 Agent、Mailbox 和 Workflow DAG 使用租约/generation、effect 调度、结果确认、总预算和副作用 no-replay；浏览器或父进程不是任务宿主。
- user/project 长期记忆、来源化知识摄取、反向 Connector、可复现实验账本、步骤级 Model Router 与有界 HeavyThink 均有明确的注入和预算边界。
- 只有经过外部平台验真的通用经验才能进入经验库，且后续任务仍需重新验证。
- CLI、异步 REST API、Docker Compose 和 NSSCTF Agent Arena 适配。

## 安全模型

模型不是安全边界。所有主动网络能力必须经过 `PolicyEngine` 和 operator-owned 配置；单次运行的 `--scope` 只能收窄权限，不能增加主机、程序、路径或把 `observe` 提升为 `controlled`。

默认配置使用 `scope.mode=observe` 且授权主机列表为空。Docker sandbox sidecar 使用无网络配置，远程服务只能通过受控 HTTP/TCP 工具访问。详细威胁模型见 [系统架构](docs/architecture.md)。

## 快速开始

要求 Node.js `>=22.19.0`、npm 和 Docker。

```bash
npm install --legacy-peer-deps --ignore-scripts
cp .env.example .env
```

在 `.env` 中设置模型 API Key：

```bash
OPENAI_API_KEY="..."
```

默认使用 OpenAI Responses-compatible 配置。使用其他兼容服务时，复制并修改 `config/default.yaml` 中的 `provider`、`id`、`name`、`baseUrl` 和 `apiKeyEnv`，不要把真实密钥写入 YAML。

示例配置按 60 RPM / 600K TPM 的模型额度预留 20% 余量：`runtime.modelRequestsPerMinute=48`、`runtime.modelTokensPerMinute=480000`，并用 `runtime.modelMinIntervalMs=7500` 抑制突发请求。运行时会在每次模型请求（包括并发任务的首轮请求）前按滚动 60 秒窗口统一预约 RPM/TPM；额度不足时等待而不是继续冲击网关。该门控只在当前服务进程内共享，同一额度不应同时供多个玄枢进程或其他客户端使用。

验证工程：

```bash
npm run check

npm --prefix frontend ci --ignore-scripts
npm --prefix frontend run build
```

真实 Chromium 集成测试默认跳过。需要验证本机浏览器运行时时，先安装 Playwright Chromium，再运行 `XUANSHU_RUN_LIVE_BROWSER=1 npm run test:browser`。

启动本地无外网 sandbox sidecar：

```bash
mkdir -p workspace .xuan-shu/work
sh tools/ctf/run-local-sandbox.sh
npm run sandbox-health
```

运行一个只读任务：

```bash
npm run dev -- run \
  --task "分析 workspace 中的材料并给出有证据的结论" \
  --attach ./workspace
```

## 授权网络任务

复制完整配置并显式设置 `scope.mode=controlled` 与精确的 `allowedHosts`。`config/scope.example.yaml` 展示了作用域格式，但 `--scope` 文件只能在完整配置已有授权的范围内继续收窄。

网络工具的行为：

- `http_request`：有界 HTTP 请求，不跟随重定向。
- `tcp_open/send/receive/close`：有界、精确 `host:port` 的状态化 TCP 会话。
- `browser`：可选的逐运行 Chromium 上下文，只允许 scope 内 HTTP(S) 导航，禁止任意 JavaScript、下载、上传、弹窗和密码字段填充。
- `run_command`：仅执行 allowlist 程序，不经过 shell；Docker sidecar 本身不能直接出网。
- 长时间运行的 sandbox 命令会在超时或调用方取消时终止；stdout/stderr 共享单次运行输出上限。

## NSSCTF Agent Arena

Arena 集成是可选能力。使用前设置：

```bash
NSSCTF_AGENT_TOKEN="nss_agent_xxx"
```

在办公网使用万擎在线推理点时，把 `WQ_API_KEY` 和 `NSSCTF_AGENT_TOKEN` 放入被 Git 忽略的 `.env`，然后一条命令启动控制台：

```bash
npm run nss
```

打开 `http://127.0.0.1:7318/`，默认勾选“持续运行”，点击“开始解题”后会持续取题，直到 operator 点击“停止”或遇到必须人工处理的题目、平台冷却与基础设施错误。取消持续运行并填写目标题数即可保留有限批次模式。`config/nss-wanqing.yaml` 使用办公网 OpenAI Chat Completions-compatible 网关，令牌只从环境变量读取；页面不会接收或保存模型令牌与 Arena Token。作业完成或停止后会展示平台验真的正确率、已验证题型、能力缺口和下一步优化建议，成功经验仍需在后续题目重新验证。

无显式答案、阻塞、错误提交或题型不在 allowlist 的题不会自动放弃；作业会停止并保留平台当前题，避免触发 early-abandon 冷却。错题题面、失败原因、运行统计和只读附件副本保存到 `.xuan-shu/wrong-questions/<attempt-id>/`，状态接口会返回有界的错题摘要，单题详情可通过 `/v1/arena/wrong-questions/<attempt-id>` 读取，供后续能力补全后重做；不会归档模型密钥、Authorization、Cookie 或隐藏推理。

控制台的“手工解题”页支持粘贴多道题目，题目之间用单独一行 `---` 分隔；单批最多 20 题，并发数限制为 1-8，默认使用单并发以控制长上下文的 TPM 峰值。一次可选择最多 20 个附件，单文件不超过 100 MiB、批次总量不超过 200 MiB，所选附件会应用到本批全部题目。每道题会建立独立运行、审计链和只读附件工作区，批量作业可单独停止，完成后会直接显示模型通过 `finish_task.submission` 提交的精确 FLAG，并可复制或跳转到运行轨迹。“生成 WP”默认开启，要求模型把方法、关键证据、复现命令、验证过程和最终答案写成有界 Markdown；可在提交前关闭。附件通过受服务令牌保护的 `POST /v1/manual/uploads` 流式写入 `.xuan-shu/work/manual-uploads/`；未提交上传在一小时后清理，已提交上传在作业结束后清理。作业 API 为 `POST /v1/manual/jobs`、`GET /v1/manual/jobs`、`GET /v1/manual/jobs/:id` 和 `POST /v1/manual/jobs/:id/stop`。

本地题库通过 `XUANSHU_QUESTION_BANK_ROOT` 指向一个 operator-owned 目录。默认读取 `task_list_crypto.txt` 和 `task_list_misc.txt`，当前 CyBench 子集会索引 15 道题。控制台“本地题库”区的“一键处理题库”只会把未完成题目放进有界的单题并发批次；`questionBank.raceAgents`（NSS 配置默认 3）会为每题启动 N 个独立 agent。竞速 run 共享最多 64 条、64 KiB 的脱敏证据板，但不共享 scratch；`read_shared_evidence` 和 `publish_shared_evidence` 仍受策略、动作预算、checkpoint 和审计约束。首个同时满足 `finish_task` 完成态、明确 submission、`independentlyVerified=true` 且在 verification 证据中出现原答案的 agent 成为 winner，其他 agent 立即停止并等待收尾。没有通过闸门的猜测不会结束竞速。每题独立运行，明确调用 `finish_task` 报告受阻的题标记为“已跳过”并继续后续题目。已通过题目会记录在 `.xuan-shu/question-bank-progress.json`，后续批次自动跳过；记录只包含题目 ID、公开材料指纹、完成时间和运行 ID，不包含 flag、答案、附件正文、凭据或隐藏推理。首次读取时会从已有的已完成题库运行中回填进度。材料变动会生成新指纹并重新进入待处理队列。模型瞬时限流或网关错误会按退避策略最多重试两次，避免被误记为题目失败。若模型把输出预算全部耗在 reasoning、未产生工具调用，运行时会降低 thinking 强度并在当前上下文中做最多两次有界续接；仍然耗尽时归类为模型失败，不会伪装成题目受阻或“已跳过”。题库加载器不会修改原目录，只会把最多 20 个公开题目文件复制进每次运行的只读输入目录，并排除 `metadata`、`solution`、`writeup`、flag/answer/secret/solve 文件和符号链接，避免参考答案进入模型上下文。

需要交互式本地服务的题目可显式启用 `questionBank.instanceRunner`。运行器只读取 `metadata.json` 顶层的公开 prompt/target 和 Compose 服务映射，不读取或传递子题答案；它以固定 Docker 参数启动 operator-owned challenge、强制把目标端口绑定到 `127.0.0.1`、将每次运行的 scope 收窄到该精确端口，并在题目结束或中止后执行 Compose 清理。Docker 输出只记录有界字节数和哈希，实例生命周期审计保存在 `.xuan-shu/question-bank-instances/<instance-id>/audit.jsonl`。若 Compose 声明外部网络，名称必须匹配配置；缺失的网络会以 `--internal` 创建并保留复用。此功能会构建和运行题库目录中的容器，默认不启用，应仅用于 operator 信任的题库。

```bash
XUANSHU_QUESTION_BANK_ROOT=/path/to/cybench-crypto-misc npm run dev -- question-bank-list
XUANSHU_QUESTION_BANK_ROOT=/path/to/cybench-crypto-misc npm run dev -- question-bank-solve --concurrency 1
```

题库 API 为 `GET /v1/question-bank` 和 `POST /v1/question-bank/jobs`。后一接口只接受是否生成 WP；题目内容、分类、附件、单题并发、竞速 agent 数和瞬时故障重试均由 operator-owned 题库配置产生。通用手工作业也可在 `POST /v1/manual/jobs` 中传 `raceAgents`（1-8）；CLI 对应 `question-bank-solve --race-agents n`。

单题闭环：

```bash
npm run dev -- arena-solve-once --config config/arena.yaml
```

只运行并人工复核，不自动提交：

```bash
npm run dev -- arena-solve-once --no-auto-submit --config config/arena.yaml
```

固定题数评测：

```bash
npm run dev -- arena-evaluate --max-attempts 20 --config config/arena.yaml
```

`arena-loop` 未指定 `--max-attempts` 时也是持续模式；CLI 进程由 operator 通过终止信号停止。

Arena 控制面仅允许访问配置源站的 `/api/skill/agent/arena/` 前缀。平台返回的动态题目地址必须先被完整配置授权，运行时再收窄到实际 `host:port`。

## REST API 与审计台

```bash
XUANSHU_SERVER_TOKEN="replace-with-a-long-random-value" npm run serve
```

打开 `http://127.0.0.1:7318/` 查看运行、行动轨迹、模型可见上下文、策略门禁、工具证据、checkpoint、假设变化、经验候选和结论。页面展示可复核的外显决策，不保存或推断隐藏思维链。

```bash
curl http://127.0.0.1:7318/health

curl -X POST http://127.0.0.1:7318/v1/runs \
  -H "Authorization: Bearer $XUANSHU_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"检查授权工作区并记录证据"}'

# 从历史事件 #12 创建独立分支
curl -X POST http://127.0.0.1:7318/v1/runs/<run-id>/fork \
  -H "Authorization: Bearer $XUANSHU_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"boundarySequence":12,"instruction":"基于已有证据尝试另一条验证路径"}'

# 从父运行最后一条事件继续
curl -X POST http://127.0.0.1:7318/v1/runs/<run-id>/resume \
  -H "Authorization: Bearer $XUANSHU_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

非回环地址启动时必须设置服务令牌。

持久编排与 operator 数据 API 也使用同一服务令牌：

- `/v1/agents`、`/v1/agent-tasks/:id`：创建、寻址、等待、中断和确认后台任务；
- `/v1/workflows`：创建、查询和取消有界 DAG；
- `/v1/connectors`：对 operator 预配置的反向 Connector 做注册、心跳、断开、claim 和结果结算；
- `/v1/memory`：管理有 TTL、来源、置信度和用户确认状态的 user/project 记忆；
- `/v1/knowledge`：摄取、查询和删除带 URL、哈希、引用、信任级别及提示注入标记的知识快照；
- `/v1/evaluations`：固定环境/预算 manifest、登记 attempt 并读取成功率、耗时、Token、成本和错误分类报告。

Deep Research 没有裸抓取 REST 端点。宿主必须显式提供 `policyControlled` fetcher，每个 URL 仍先经过 `PolicyEngine` 和 operator scope。Step Model Router 与 HeavyThink 同样是默认不调用真实模型的应用服务库；启用时必须提供 runner，并纳入分支数、时间、Token 和成本预算。

## Docker

```bash
mkdir -p workspace
export OPENAI_API_KEY="..."
export XUANSHU_SERVER_TOKEN="..."
docker compose up --build
```

默认镜像只安装 core 工具。heavy profile 会显著增加构建时间、镜像体积和 CPU/内存需求，需由 operator 显式启用：

```bash
XUANSHU_INSTALL_HEAVY_CTF_TOOLS=true docker compose build ctf-sandbox
```

core 构建包含并 smoke-test GAP、patchelf、scalpel、Radare2 6.2.0、JADX 1.5.5、Pwntools、gdb-multiarch、ltrace 和 binutils 辅助命令；Radare2/JADX 发行包在构建期校验 SHA-256。heavy 构建会固定源码 commit 并运行 `verify-heavy-tools.sh`；包含 SageMath、RsaCtfTool、CADO-NFS、flatter、额外的 radare2 源码构建、stegseek、angr、qiling、frida、PyTorch 和 Transformers。Ghidra、UPX 与 GPU hashcat 调优仍需按部署环境人工处理。`crypto-attacks`、`gf2bv`、`lll_cvp`、`lattice-based-cryptanalysis` 和 `cuso` 仅记录为 operator-managed 审查项，在许可证、安装与确定性样例完整前不会伪装成默认能力。安装任何工具都不会扩大运行时程序 allowlist 或网络 scope。详见 [二进制工具链](docs/binary-toolchain.md)。

主服务以非 root 用户运行；`workspace` 只读挂载，scratch 和审计材料写入独立卷。Arena Token 仅在使用 Arena 功能时需要。

TSecBench 托管评测使用独立的自启动镜像和网关配置，详见 [TSec 托管评测](docs/tsec-hosted.md)。

## 运行材料

每次运行在 `.xuan-shu/runs/<run-id>/` 中生成：

- `state.json`：最终状态、计划、预算和摘要。
- `findings.json`：结构化发现与证据。
- `transcript.json`：去除隐藏推理并脱敏后的会话。
- `audit.jsonl`：带 SHA-256 前向哈希的审计链。
- `reviews.jsonl`：人工对具体审计序号的复核与修正。

脚本、payload 和中间产物位于 `.xuan-shu/work/runs/<run-id>/`。这些目录和 `.env` 均被 Git 忽略。

## 项目结构

- `src/runtime.ts`：Agent 生命周期、状态与持久化。
- `src/agent-store.ts`、`src/workflow.ts`：可寻址任务内核与 effect-aware 持久 DAG。
- `src/executor.ts`、`src/connector.ts`：统一执行器和 operator 配置的反向 Connector。
- `src/memory.ts`、`src/knowledge-store.ts`、`src/deep-research.ts`：来源化长期参考与策略受控研究摄取。
- `src/evaluation-ledger.ts`、`src/model-routing.ts`：可复现实验账本、步骤路由和 HeavyThink 预算协调。
- `src/skill-catalog.ts`、`skills/`：开源 CTF skill 的固定来源、类别索引与接入边界。
- `src/policy.ts`：作用域、预算和停滞门禁。
- `src/tools.ts`：模型可调用的有界工具。
- `src/sandbox.ts`：sidecar 协议与结构化命令执行。
- `src/audit.ts`、`src/session-trajectory.ts`、`src/trace.ts`：追加审计链、来源/上下文信封、行动解释、回放与运行分支。
- `src/experience.ts`：经外部验真的通用经验。
- `src/arena*.ts`：Arena 客户端与评测闭环。
- `src/question-bank.ts`、`src/manual-jobs.ts`：本地题库索引与可跳过的有界批处理。
- `src/shared-evidence.ts`：同题竞速的有界、脱敏、进程内证据板。
- `src/web-reasoning/`、`src/agents/web/`：Web 任务识别、证据推理、受控浏览器与角色编排。
- `frontend/`：React 审计控制台源码与 Playwright 页面测试。
- `test/`：确定性 faux-model、策略、沙箱和 API 测试。

架构、工具副作用、CTF skills、参考项目研究、评测方法与路线图分别见 [docs/architecture.md](docs/architecture.md)、[docs/tool-side-effects.md](docs/tool-side-effects.md)、[skills/README.md](skills/README.md)、[docs/reference-agent-study.md](docs/reference-agent-study.md)、[docs/evaluation.md](docs/evaluation.md) 和 [docs/roadmap.md](docs/roadmap.md)。本项目当前仍缺少 DNS 解析锁定、统一出口代理、跨实例持久事件总线和租户级 microVM 隔离；受控浏览器也不持久化登录会话，不应把当前版本视为无人值守生产安全扫描器。

## XH-202609 参赛材料

面向“具备自主决策能力的通用网络安全智能体技术研究”榜题的源码、设计、开发、测试、使用、技术报告、演示脚本、PPT 和提交清单位于 [docs/competition/](docs/competition/README.md)。其中需要学校/团队盖章、百度网盘链接、线上测试地址或报名系统生成文件的项目明确保留为人工待办，避免在仓库中编造或提交敏感信息。

## 贡献与许可证

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。代码采用 [MIT License](LICENSE)，第三方依赖与参考说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

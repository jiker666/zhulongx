# 系统架构

## 设计目标

玄枢把模型视为“可替换的决策部件”，而不是安全边界。模型决定下一步做什么；运行时决定该动作是否在授权范围内、是否还有预算、结果如何持久化以及何时必须停止。

```mermaid
flowchart LR
    I["任务与附件"] --> N["输入归一化"]
    N --> A["Pi Agent 决策循环"]
    A --> G["规划与 checkpoint 门禁"]
    G --> P["PolicyEngine"]
    P -->|允许| T["工具注册表"]
    P -->|拒绝及原因| A
    T --> S["CTF sandbox sidecar"]
    S --> X["逐运行 scratch/HOME 命名空间"]
    T --> O["有界观察结果"]
    S --> O
    O --> A
    A --> F["发现与完成状态"]
    N --> L["哈希链审计"]
    A --> L
    P --> L
    T --> L
    F --> L
    L --> V["可视化决策审计与人工复核"]
    F --> E["经验候选"]
    E -->|平台验真成功| K["通用经验库"]
    K --> A
    A --> C["Timeline / Context 双投影"]
    A --> Q["持久 Agent / Workflow"]
    Q --> R["统一 Executor"]
    R --> S
    R --> RC["反向 Connector"]
```

## 核心边界

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `input.ts` | 解析任务、文件、目录与 ZIP，限制资源占用 | 不执行附件内容 |
| `runtime.ts` | 驱动 Pi、状态转换、预算、持久化、工具 cleanup | 不绕过策略执行工具 |
| `executor.ts` / `connector.ts` | 统一命令与文件执行契约；管理反向 Connector 心跳、generation、租约和有界结果 | 不允许 Connector 自报程序或网络权限 |
| `session-trajectory.ts` / `runtime-events.ts` / `context-projection.ts` | 为追加事件标注来源、执行者、关联 ID 与父序号；记录脱敏限长的模型可见上下文，并从同一事实源生成用户时间线和模型上下文 | 不删除原始审计事件，不把隐藏推理、凭据或图片像素持久化 |
| `run-recovery.ts` | 服务启动时结算未完成运行、续接审计链并禁止副作用重放 | 不自动重试或重放旧工具调用 |
| `policy.ts` | 计划门禁、路径/主机/端口/程序范围、停滞与预算控制 | 不相信模型自报范围 |
| `tools.ts` | 只读输入、有限图片观察、scratch 写入、sandbox 命令、HTTP/TCP、发现与终止 | 不在 API/model 进程内执行 CTF 命令 |
| `sandbox.ts` | Unix socket sidecar 协议、结构化命令执行、输出和超时上限 | 不持有模型密钥或出网授权 |
| `audit.ts` | 顺序化写入和 SHA-256 前向哈希校验 | 不替代外部不可篡改存储 |
| `trace.ts` / `dashboard.ts` | 将审计记录投影为外显决策时间线，接受人工纠错 | 不展示或推断隐藏思维链 |
| `experience.ts` | 脱敏、平台验真后晋升、按类别检索和人工启停通用经验 | 不保存题号、flag、固定地址或未经验证的答案 |
| `skill-catalog.ts` | 将固定版本的开源 CTF skill 归一化为类别、技术族和 pivot 信号 | 不执行上游脚本、不继承外部工具权限、不把上游内容当证据 |
| `server.ts` | 健康检查、异步运行、鉴权、审计台与复核 API | 不允许远程扩大配置范围 |
| `manual-jobs.ts` | 有界批处理与同题多 agent 竞速；首个通过验证闸门的 run 胜出并取消同题其余 run | 不改变任务 scope，不让未经验证的 submission 结束竞速 |
| `shared-evidence.ts` | 提供同题 race 内有界、脱敏、带来源的事实/候选/dead-end 交换 | 不作为跨题知识库，不共享 scratch，不把其他 agent 的结论当作已验证事实 |
| `agent-store.ts` / `agent-worker.ts` | 持久化可寻址 Agent、任务、Mailbox、预算、租约、generation 和结果确认 | 不用内存 Promise 充当任务事实源，不允许旧租约覆盖新结果 |
| `workflow.ts` / `workflow-worker.ts` | 验证和执行有界 DAG，调度 effect、写租约、动态扩图、聚合预算和 no-replay | 不让节点声明扩大工具能力，不重放副作用不明的过期节点 |
| `memory.ts` / `knowledge-store.ts` | 保存有来源、TTL、置信度和注入标记的长期参考 | 不保存凭据，不把历史或网页文本当成高优先级指令 |
| `deep-research.ts` | 对显式 URL 做策略判定、有界并发抓取和知识摄取 | 不提供绕过 `PolicyEngine` 的抓取器或默认联网端点 |
| `evaluation-ledger.ts` | 固定数据集、模型、运行环境、容器摘要、预算和轨迹引用并聚合指标 | 不声称单次演示等于基准能力 |
| `model-routing.ts` | 按步骤的难度、effect、能力和预算选择模型；约束 HeavyThink 分支和聚合 | 不默认调用真实模型，不允许分支越过总 Token/成本/时间预算 |

## 自主性机制

1. `submit_plan` 是所有调查动作的前置条件，计划包含假设、待验证假说、成功标准和候选工具。
2. 连续动作达到阈值后，策略层只允许 `checkpoint` 等元工具，迫使智能体总结证据和调整计划。
3. 相同工具与参数超过重复阈值会被拒绝，避免无进展循环。
4. `record_finding` 要求证据和置信度，`finish_task` 要求明确的完成或阻塞状态。
5. 轮次、工具、HTTP、TCP、时间、scratch 文件和输出量均有独立上限；任何一个上限都不能由模型提高。
6. 每个模型请求（包括并发运行的首轮请求）都经过进程共享的滚动 RPM/TPM 门控；请求按估算上下文和最大输出预算预约额度，等待与预约写入审计链，并接受 `AbortSignal` 终止。
7. CTF 任务先做通用 triage，再根据证据在 web、pwn、crypto、reverse、forensics、malware、OSINT、misc、AI/ML 之间 pivot。
8. Arena 完成前必须调用 `record_lesson` 记录通用经验候选；只有平台接受提交后才写入经验库，后续运行仍必须重新验证。
9. 任务类别命中时只加载一个经过审查且长度受限的 skill 索引。它与 playbook 一样只是决策提示，任何行动仍需经过工具注册表和 `PolicyEngine`。
10. `observe_image` 与其他调查动作一样经过 `PolicyEngine`，检查安全相对路径、单图字节上限和 run 级观察次数；其副作用仅为读取文件、返回模型上下文，并追加不含像素的 `image.observed` 审计事件。
11. Arena 完成要求候选答案出现在至少两条验证记录中，并同时绑定到 confirmed hypothesis、高置信度 finding 和空的 remainingRisks；`independentlyVerified` 不能单独充当证据。
12. Arena 可由 operator-owned `arena.allowedCategories` 限定题型；不在 allowlist 的题目不会启动模型、不会自动放弃，作业会停止并保留当前题供 operator 调整配置后重试，避免触发平台 early-abandon 冷却。
13. 持续作业会把错误提交或阻塞题归档到 `.xuan-shu/wrong-questions/`，保留题面、失败原因、运行统计和附件副本；记录不包含模型凭据、会话 Cookie、Authorization 或隐藏推理。
14. 同题竞速共享题目准备结果和进程内 `SharedEvidenceBoard`，不共享可变工作目录；每个 agent 使用独立 run/scratch。证据板最多 64 条、64 KiB，只保存脱敏后的 fact/candidate/dead-end，并记录来源 run。读写工具属于策略控制的调查动作，消耗工具与 checkpoint 预算并写入 `collaboration.evidence_*` 审计事件；共享内容必须独立复核。
15. winner 必须提供结构化 submission、`independentlyVerified=true` 和包含该 submission 的 verification 记录，随后统一停止并等待 loser 收尾，避免后台 run 或题目实例泄漏。

## 隔离与可观测性

- sidecar 为每个 run-id 建立独占的 `scratchRoot/runs/<run-id>`，命令的 cwd、`HOME`、`TMPDIR` 和路径校验都绑定到该目录；附件复制到本次运行的只读 `inputs/`。
- 手工上传接口只接受经过校验的叶子文件名，流式执行单文件、文件数和批次总量预算；上传暂存在 `scratchRoot/manual-uploads/`，提交后只供对应批次读取，并在批次结束时删除。服务令牌保护上传入口，响应不返回服务器文件路径。
- `workspaceMode=attachments-only` 时，文件工具的 workspace 根目录就是本次运行的只读 `inputs/`；共享 workspace 不会被列出，`run_command(cwd=workspace)` 被策略拒绝。图片在上下文之外只保留 MIME、大小和 SHA-256 等摘要。
- 该机制消除正常工具协议下的跨题 scratch 污染。Docker sidecar 仍是所有运行共享的 OS 容器；需要互不信任租户级的内核隔离时，应由部署层为每次运行调度独立容器或 microVM。
- `audit.jsonl` 是唯一运行事实源。新事件在哈希信封中携带 `source`、`actor`、`correlationId` 和可选 `parentSequence`；`tool.requested`、`policy.decision` 与 `tool.result` 通过同一工具调用 ID 配对，前端不靠时间猜测因果关系。
- 每次模型请求前追加 `model.context`，记录经过脱敏、限长并剔除隐藏 reasoning 与图片像素的系统提示词、公开消息、工具 schema、请求摘要和 SHA-256 digest。首次任务资料、经验、Memory 和分支上下文以 `context.injected` 单独记录，因此可以回答“模型当时看到了什么、这些内容从哪里来”。
- 行动轨迹从同一事件流派生小白解释层，逐步说明“正在做什么、为什么、影响、结果、下一步”，并支持按来源检索、序号回放和人工复核。技术原始事件保持可用，不覆盖事实层。
- `POST /v1/runs/:id/fork` 可在确切审计序号创建独立子运行；`POST /v1/runs/:id/resume` 从最后事件继续。两者只继承公开、脱敏的轨迹投影，并把 `parentRunId`、边界和继承事件数写入新运行血缘；父运行保持不可变。
- 服务启动前会检查持久化的 `queued/running` 状态。遗留运行统一记录 `run.recovered_after_restart` 并结算为 `aborted`；恢复采用 `no-replay`，避免无法确认完成情况的工具产生重复副作用。恢复写入会续接原审计序号和前向哈希，重复启动不会追加重复恢复事件。
- 人工复核写入独立 `reviews.jsonl`，不修改原始哈希链，因此原始行为与事后修正可以同时追溯。
- 每个 persisted runtime event 使用 `(epoch, seq)` 排序；SSE 使用稳定 event id 支持 `Last-Event-ID` 回放。检索、UI 历史回放、恢复视图和分支上下文都读取同一审计序列，重复事件由纯 reducer 去重，重连先回放缺口再继续实时流。
- 模型上下文投影会删除隐藏 thinking、裁剪过长工具数据并在阈值处压缩旧上下文；审计时间线保持完整。压缩摘要带来源边界，并明确作为不可信历史参考注入。

## 持久编排与 Connector

- joined subagent 与 addressable agent 使用同一持久任务内核，但 await/cancel 策略不同。Agent、Task、Result、Mailbox 和事件保存在 `.xuan-shu/orchestration/`，worker 只持有可丢弃的活动租约。
- 每次 claim 都增加 `leaseGeneration`；续租、结算和迟到结果必须同时匹配 owner 与 generation。父进程重启后仍可查询已完成结果，operator 通过 ack 明确确认消费。
- Workflow 节点声明 `pure_readonly`、`workspace_read`、`workspace_write`、`network` 或 `unknown` effect。只读节点可并行，workspace 写入互斥；网络节点还消耗独立节点数与请求预算。
- controller 只能在节点数和扩图次数预算内增加经过完整 DAG 校验的节点。副作用节点租约过期后标记失败并记录 no-replay；只读节点只有在尝试预算内才可重新排队。
- Connector 是 operator 预配置的反向执行目标。客户端注册和心跳不能改变 capability、allowedPrograms、输出上限或网络权限；重绑定增加 generation 并拒绝旧连接的未完成工作。
- 默认 Connector `networkAccess=false`。主动网络继续由 API 进程内的 HTTP/TCP/Browser 工具经过 `PolicyEngine` 执行，不能借 Connector 绕过 scope。
- 内置执行后端目前为 sandbox 与 connector。`ExecutorKind` 为 local/SSH 保留协议位，但配置加载会拒绝没有 operator adapter 的选择，不会静默降级到 sandbox；新增 adapter 仍需实现路径边界、health、统一结果、取消和策略测试。

## 记忆、知识与研究

- 长期记忆按 user/project scope 隔离，记录来源 session、置信度、用户确认、最后验证时间和 TTL。敏感材料在写入前被拒绝，过期或 disabled 记录不会进入模型上下文。
- 知识文档保留规范化 URL、内容哈希、信任级别、引用、代码片段和提示注入标记。非 operator 文档一旦命中注入特征会自动降级为 `untrusted`。
- Deep Research 只接受声明 `policyControlled=true` 的 fetcher；每个 URL 在发送前均调用 `PolicyEngine`，并受文档数、并发、单文档字节和总字节预算与 `AbortSignal` 控制。
- Memory/Knowledge 注入都带“数据而非指令”的固定边界。当前任务、operator scope、策略和直接证据始终优先。

## 威胁模型

- 提示注入：附件和网站内容均是不可信数据；系统约束与策略执行在模型之外。
- 范围扩张：单次请求只能缩小 operator-owned 配置，不能从 `observe` 提升到 `controlled`。
- 命令注入：`run_command` 通过 Unix socket 交给 `ctf-sandbox` 执行，使用 `spawn(program, args)` 且 `shell=false`，程序与路径在 policy 和 sidecar 两层检查。
- 进程隔离：API/model 进程不执行 CTF 命令；Docker 部署中 sidecar 不接收模型 key，challenge input 只读挂载，每次运行只使用自己的 scratch/HOME 命名空间。
- 出网隔离：Docker sidecar 使用 `network_mode: none`；远程 web/pwn 只能走经过 `PolicyEngine` 的 HTTP/TCP 工具。
- SSRF/重定向：HTTP 只允许配置主机并使用 `redirect=manual`。生产阶段还需增加 DNS 解析锁定和出口代理。
- 凭据泄露：审计与会话按敏感字段名脱敏，模型密钥只从环境变量读取。
- 资源耗尽：输入、ZIP、工具输出、请求体、scratch 文件、TCP 字节数、轮次与时间均设置上限。

## CTF sandbox profile

`tools/ctf/capabilities.json` 是能力 manifest。默认 core profile 覆盖：

- Web/API：HTTP 工具、curl/sqlmap/flask-unsign/requests/jq。
- Pwn：pwntools、ROPgadget、ropper、gdb/gdb-multiarch、checksec、seccomp-tools、one_gadget、patchelf、qemu-user、binutils。
- Crypto：pycryptodome、sympy、gmpy2、py_ecc、hashpumpy；`fpylll+cysignals` 提供可用的 LLL/BKZ 基础，Z3/OR-Tools 提供 SMT 与 CP-SAT，`ecm`、`gp`、`gap`、`factor`、`bc` 提供有界的整数分解、代数和数论 CLI。
- Reverse/Malware：固定版本的 Radare2、JADX、file/strings/xxd/binutils、gdb-multiarch、ltrace、capstone、unicorn、lief、pefile、yara、oletools、apktool。
- Forensics/Misc/OSINT：binwalk、foremost、scalpel、exiftool、tshark、sleuthkit、ffmpeg/ffprobe、ImageMagick、SoX、minimodem、multimon-ng、zbar/qrencode、Tesseract、pngcheck/gifsicle、steghide/outguess/stegsnow、Pickora、Pillow/numpy/matplotlib。Pwn 额外提供 `patchelf` 修补解释器和依赖路径。

Core profile 固定安装并 smoke-test Radare2 6.2.0、JADX 1.5.5、Pwntools、gdb-multiarch、ltrace 与 binutils 辅助程序；两个发行包在镜像构建期下载并校验 SHA-256。Heavy profile 通过 `INSTALL_HEAVY=true` 可选安装 angr、qiling、frida-tools、torch、transformers、SageMath、RsaCtfTool、CADO-NFS、flatter、额外的 radare2 源码构建和 stegseek。源码工具固定到 `capabilities.json` 中的 commit，并由 `verify-heavy-tools.sh` 做构建期 smoke test；Ghidra、UPX 和 GPU hashcat 调优仍作为人工确认的重型扩展。`crypto-attacks`、`gf2bv`、`lll_cvp`、`lattice-based-cryptanalysis` 与 `cuso` 只记录在 operator-managed 审查清单，不是默认镜像能力；许可证、安装入口或确定性调用样例未完成前不会进入 allowlist。

这些能力是 sandbox programs，不是新的核心 AgentTool。它们只在无外网 sidecar 内通过 `run_command` 执行，并接受 `PolicyEngine` 的 operator-owned 程序白名单、总工具调用预算、重复动作与 checkpoint 门禁。读取型命令只观察输入；转换、OCR、隐写提取和 Pickora 可在本次运行的 scratch 命名空间内创建文件；分解、约束、OCR、音频和密码尝试可能消耗较多 CPU。所有命令受统一超时、AbortSignal 终止和 stdout/stderr 字节上限约束，每次调用都会写入 `policy.decision` 与 `tool.result` 审计事件。

镜像构建会运行 `tools/ctf/verify-core-tools.sh`：检查声明的 CLI、导入关键 Python 模块，并执行最小 LLL、CP-SAT 与 Z3 smoke test。heavy 构建额外验证固定源码工具、SageMath 和关键 Python 模块；它体积较大，且分解、符号执行和 ML 工作负载仍受同一命令超时与资源预算。远程交互依然只能使用作用域内的 HTTP/TCP AgentTool；题目依赖中的 netcat 不会因此进入 Arena/default 程序白名单，运行中也禁止临时调用包管理器扩展能力。

当前默认、Arena 和 Wanqing NSS 配置将 Arena 题型 allowlist 设置为 `crypto`、`misc`；核心循环仍不认识题目专属逻辑，其他部署可通过省略该 operator 配置恢复全题型模式。

开源 skill 来源、固定版本与内容筛选规则见 [`skills/README.md`](../skills/README.md)。外部 skill 的网络、shell 或安装权限不会进入运行时。

## 扩展协议

新增核心 AgentTool 需要同时提交：TypeBox 输入模式、工具实现、策略规则、审计事件、输出上限、AbortSignal 处理、单元测试和副作用说明。新增 sandbox program 需要更新锁定依赖、能力 manifest、operator allowlist、构建期 smoke check、策略/预算回归和副作用说明；它仍只能经 `run_command` 进入审计链。受控浏览器等主动网络工具必须保持逐运行隔离并经过 `PolicyEngine`；Burp、重型反编译器或取证工具应作为插件或 sandbox profile 加入，不应修改核心状态机。完整副作用矩阵见 [`tool-side-effects.md`](tool-side-effects.md)。

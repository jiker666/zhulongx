# 工具副作用与审计契约

所有模型可调用工具都先经过统一工具总线、`PermissionGate` 和 `PolicyEngine`。单次运行只能缩小 operator-owned scope；输出受 `runtime.maxOutputBytes` 等预算限制，阻塞操作接受 `AbortSignal`。工具结果和策略判定进入 `audit.jsonl`，不会持久化 Authorization、Cookie、模型 Key 或隐藏推理。

| 工具族 | 可见副作用 | 主要预算与停止条件 | 审计事件 |
| --- | --- | --- | --- |
| 计划、checkpoint、finding、lesson、finish | 更新当前 run 的结构化状态和持久产物 | 轮次、工具调用、重复动作、checkpoint 间隔、字段长度 | `plan.submitted`、`decision.checkpoint`、`finding.recorded`、`lesson.captured`、`run.finished_by_agent` |
| workspace 读取、附件检查、图片观察 | 读取 operator workspace 或本次只读附件；不写输入 | 安全相对路径、读取字节、目录项、图片字节和次数 | `policy.decision`、`tool.result`、`image.observed` |
| `extract_archive`、`search_artifact` | 从 workspace/scratch 读取 ZIP 或二进制；前者只写入本次 scratch | 安全相对路径、ZIP 500 条目/32 MiB、搜索前缀 16 MiB、模式 4 KiB、匹配 100 条、上下文 256 字节、`AbortSignal` | `policy.decision`、`tool.result`、`artifact.archive_extracted`、`artifact.searched` |
| scratch 读写 | 只在本次 run 的 scratch 命名空间创建、追加或读取文件 | 路径根、单文件/总字节、输出上限、AbortSignal | `policy.decision`、`tool.result` |
| `run_command` | 在无网络 sidecar 内启动 allowlist 程序；可读输入、写本次 scratch、消耗 CPU/内存 | program+args 结构化校验、cwd、程序 allowlist、超时、输出字节、重复动作、AbortSignal | `permission.requested/resolved`、`policy.decision`、`tool.result` |
| HTTP/TCP | 向 operator scope 内精确主机发送主动网络请求 | mode、host/port、HTTP 次数、TCP session/字节、超时、AbortSignal | `permission.requested/resolved`、`policy.decision`、`tool.result` |
| Browser | 创建逐运行 Chromium context，在 scope 内导航和交互 | session/page/navigation/action/DOM/network/screenshot 预算；禁止任意脚本、下载、上传、弹窗和密码填充 | `permission.requested/resolved`、`policy.decision`、`tool.result` 及浏览器证据事件 |
| 外部/MCP 工具 | 执行 operator 注册的适配器；side effect 由 descriptor 声明 | 输入 schema、effect、requiredCapabilities、工具输出上限、AbortSignal | 与内置工具相同的权限、策略和结果事件 |
| Agent 委派 | 创建持久 Agent/Task/Result/Message；可能间接启动独立 run | agent/task 数、并发、runtime/token/cost、租约/generation、取消策略 | Agent Store 事件和子 run 审计链 |
| Workflow | 创建/扩展/取消 DAG；节点可能读写 workspace 或主动联网 | 节点数、effect 调度、写租约、network 节点/请求、runtime/token/cost、controller 扩图 | Workflow Store 事件和节点 run 审计链 |
| Connector | 在 operator 配置的反向客户端执行命令或文件操作 | 固定 capabilities/programs、relative path、scratch-only 写、输出、pending task、心跳、generation、lease、AbortSignal | 服务 API 鉴权；实际操作仍由调用它的工具/run 审计 |
| Memory/Knowledge API | 在 `.xuan-shu/orchestration/` 写入或删除脱敏后的长期参考 | 记录/字符/来源/文档/代码片段上限、TTL、敏感拒绝、服务令牌 | operator API；注入发生时记录 run 上下文事件，不作为工具证据 |
| Deep Research | 经策略控制 fetcher 读取 URL 并摄取知识 | 每 URL `PolicyEngine`、文档数、并发、单文档/总字节、HTTP 预算、AbortSignal | `research.policy/fetched/ingested/failed` 回调，由宿主接入审计链 |
| Evaluation Ledger | 写入环境 manifest、结果指标和轨迹引用；可读取 operator 指定 artifact 并计算哈希 | manifest/attempt/文件数/总字节、每次 runtime/token/cost、服务令牌 | 评测账本自身为可复现记录，不执行目标网络动作 |

Sandbox programs 不是独立 AgentTool。`gap`、`patchelf`、`scalpel` 等程序只有同时出现在镜像、`capabilities.json`、operator `allowedPrograms` 和 sandbox health 中时才可由 `run_command` 使用。程序可能创建大量文件或消耗显著 CPU，因此必须把输出写入本次 scratch，并依赖统一命令超时与取消。

Python 模块同样必须在 operator 选定的解释器 site-packages 中预装；sandbox health 会在隔离 `HOME` 下检查 `scope.pythonModules`。host-backed sandbox 的安装只通过构建前的 `tools/ctf/install-local-python-core.sh` 完成，任务运行中禁止包管理器。

Deep Research、Step Model Router 和 HeavyThink 是应用服务库，不是默认 REST 动作。宿主必须显式提供策略受控 fetcher 或真实模型 runner，并把它们的事件、Token、成本和时间计入当前任务预算；项目默认测试只使用确定性 faux 实现。

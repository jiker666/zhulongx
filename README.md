# 烛龙·玄枢

面向授权网络安全任务的自主决策智能体运行时。玄枢基于 Pi Agent Harness，让模型负责选择下一步动作，让运行时负责作用域、预算、隔离、审计和停止条件。

当前版本为 `0.2.2`。它适合本地材料分析、CTF、安全实验室和自建评测，不应被用于未授权目标。

## 核心能力

- 归一化文本、JSON/YAML/HAR/CSV、目录、ZIP 和二进制附件，所有预览均有上限。
- 强制执行 `任务理解 -> 计划 -> 行动/观察 -> checkpoint -> 证据 -> 完成/阻塞` 状态机。
- 工具失败或策略拒绝后，必须分类失败、修订计划并说明新的行动依据。
- 只读输入、逐运行 scratch、结构化沙箱命令，以及受策略约束的 HTTP/TCP 工具。
- 主机、程序、路径、轮次、工具调用、请求、输出、重复动作和总时长预算。
- JSONL SHA-256 前向哈希审计链、决策时间线和人工复核记录。
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

验证工程：

```bash
npm run check
```

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
- `run_command`：仅执行 allowlist 程序，不经过 shell；Docker sidecar 本身不能直接出网。

## NSSCTF Agent Arena

Arena 集成是可选能力。使用前设置：

```bash
NSSCTF_AGENT_TOKEN="nss_agent_xxx"
```

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

Arena 控制面仅允许访问配置源站的 `/api/skill/agent/arena/` 前缀。平台返回的动态题目地址必须先被完整配置授权，运行时再收窄到实际 `host:port`。

## REST API 与审计台

```bash
XUANSHU_SERVER_TOKEN="replace-with-a-long-random-value" npm run serve
```

打开 `http://127.0.0.1:7318/` 查看运行、计划、策略门禁、工具证据、checkpoint、假设变化、经验候选和结论。页面展示可复核的外显决策，不保存或推断隐藏思维链。

```bash
curl http://127.0.0.1:7318/health

curl -X POST http://127.0.0.1:7318/v1/runs \
  -H "Authorization: Bearer $XUANSHU_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"检查授权工作区并记录证据"}'
```

非回环地址启动时必须设置服务令牌。

## Docker

```bash
mkdir -p workspace
export OPENAI_API_KEY="..."
export XUANSHU_SERVER_TOKEN="..."
docker compose up --build
```

主服务以非 root 用户运行；`workspace` 只读挂载，scratch 和审计材料写入独立卷。Arena Token 仅在使用 Arena 功能时需要。

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
- `src/policy.ts`：作用域、预算和停滞门禁。
- `src/tools.ts`：模型可调用的有界工具。
- `src/sandbox.ts`：sidecar 协议与结构化命令执行。
- `src/audit.ts`、`src/trace.ts`：审计链和决策投影。
- `src/experience.ts`：经外部验真的通用经验。
- `src/arena*.ts`：Arena 客户端与评测闭环。
- `test/`：确定性 faux-model、策略、沙箱和 API 测试。

架构、评测方法与路线图分别见 [docs/architecture.md](docs/architecture.md)、[docs/evaluation.md](docs/evaluation.md) 和 [docs/roadmap.md](docs/roadmap.md)。本项目当前仍缺少浏览器插件、DNS 解析锁定、出口代理和租户级 microVM 隔离，不应把当前版本视为无人值守生产安全扫描器。

## 贡献与许可证

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。代码采用 [MIT License](LICENSE)，第三方依赖与参考说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# zhulongx(烛龙·玄枢)

> 以 **FGS 状态图**为核心的自主任务运行时:**Go 调度引擎 + Pi Agent Loop 唯一运行时 + SQLite 持久化**。
> 由 [Cairn](https://github.com/oritera/Cairn) 深度重构而来(上游基线完整保留在 [`testdata/upstream/`](testdata/upstream/),AGPL-3.0)。

**状态:早期实验性项目。** 核心闭环(Decide/Execute、状态持久化与崩溃恢复、工具策略门禁)有自动化测试覆盖;已实测对接真实 Pi CLI 0.73.x(协议冒烟 + 真实模型与 bash 工具执行),E2E 回归使用 mock 子进程以便无 key 运行。详见[限制与路线图](#限制与路线图)。

---

## 这是什么

zhulongx 是一个单进程的任务推进引擎:给定一个**目标**,它持续决定"下一步做什么"(Decide)、派出 Agent 执行(Execute)、把可信结果写回状态图,循环直到目标完成或判定应停止。

三个职责严格分离,不混为一谈:

| 职责 | 承担者 | 说明 |
|---|---|---|
| **调度器** | Go(`internal/engine`) | 决定何时 Decide、哪个 Step 何时执行、预算/超时/重试/取消 |
| **Agent Loop** | [Pi CLI](https://pi.dev)(`internal/pi`) | 单次任务内的模型推理与工具调用,Go 经官方 RPC(JSONL)协议控制 |
| **状态图** | FGS + SQLite(`internal/fgs`、`internal/store`) | 长期任务状态、事实、发现与审计 |

### FGS 状态模型

| 节点 | 含义 |
|---|---|
| **Fact** | 已验证、只追加的事实,带来源链 |
| **Goal** | 目标(origin/objective)与完成判定 |
| **Step** | 由 Decide 声明的具体行动(依赖、认领、心跳、尝试次数) |
| **Finding** | Execute 产出的**未验证**发现;只有 Decide 审查后才能晋升为 Fact |

关键信任边界:**模型自报"成功"不等于任务成功**——Execute 结果一律先落为 Finding,经 Decide 审查晋升才成为 Fact。

### 两种运行模式

- **Decide**(全局串行):读图 → 判断目标是否完成 → 创建/调整/废弃 Step → 审查 Finding 晋升。只操作状态图,不执行系统命令。
- **Execute**(受预算并发):认领一个 Step → 组装上下文 → 调 Pi 执行 → 校验输出 → 写 Finding/更新 Step 状态。错误区分**可重试/永久/权限拒绝**。

---

## 快速开始

依赖:Go ≥ 1.27;运行期需要 [Pi CLI](https://pi.dev)(`npm install -g @mariozechner/pi-coding-agent`,已验证 0.73.x);模型与 Provider 由**你自己的 Pi 配置**决定,zhulongx 不假设、不配置模型(自定义 Provider 见 `~/.pi/agent/models.json`,示例见 [docs/zhulongx/03-build-and-run.md](docs/zhulongx/03-build-and-run.md))。

```bash
# 构建
go build -o zhulongx.exe ./cmd/zhulongx    # Linux/macOS: go build -o zhulongx ./cmd/zhulongx

# 生成默认配置(zhulongx.yaml)
./zhulongx.exe init-config

# 建目标
./zhulongx.exe goal new --title "示例" --origin "授权范围内" --objective "完成某项调查"

# 注入人工事实/提示(可选)
./zhulongx.exe fact add goal_0001 --content "目标域名 example.com" --creator tester
./zhulongx.exe hint add goal_0001 --content "优先看 443 端口" --creator tester

# 启动调度循环(Ctrl+C 优雅退出;运行中的 Step 会释放回 pending,重启后恢复)
./zhulongx.exe run

# 观察与干预
./zhulongx.exe status            # 全部目标概览
./zhulongx.exe status goal_0001  # 单目标图详情(事实/步骤/发现/提示)
./zhulongx.exe audit goal_0001   # 审计日志
./zhulongx.exe export goal_0001  # 导出整图为 YAML
./zhulongx.exe goal stop goal_0001 --feedback "人工叫停原因"
```

> Windows 说明:npm 安装的 `pi` 是 `.cmd` 启动器,已实测 Go 可按 `pi.command: pi` 裸名直接启动(解析走 PATHEXT);若你的 PATH 不含 npm 全局目录,再改配绝对路径。

完整配置说明(超时、并发、重试、`pi.blocked_tools` 工具封禁策略等)见 [docs/zhulongx/03-build-and-run.md](docs/zhulongx/03-build-and-run.md)。

## 安全边界

- **工具策略门禁**(`pi.blocked_tools`):大小写不敏感正则列表;Pi 的 bash 命令命中任一模式时**运行中途中止并硬杀进程**,该 Step 判**永久失败**不重试。空列表 = 不限制(默认)。
- **授权使用**:本项目面向安全研究与**已获授权**的测试场景。不得在未获明确授权的系统、网络或数据上使用。见文末免责声明。

## 测试

```bash
go test ./...                              # 单元测试 + E2E(基于 mock 的 Pi 子进程,无需 API key)
go vet ./...

# 真实 Pi CLI 协议冒烟(可选;不配模型也跑得通,协议层完成即可)
ZHX_PI_SMOKE=1 go test ./internal/pi/ -run TestRealPiProtocolSmoke -v
# 真实模型往返(可选;需自行配置可用 Provider)
ZHX_PI_SMOKE=2 go test ./internal/pi/ -run TestRealPiProtocolSmoke -v
```

覆盖:FGS 状态机与 SQLite 存层(状态转换、CAS 认领、心跳回收、崩溃恢复)、输出契约校验、Pi RPC 适配器(JSONL 分帧、完成事件、超时/取消/崩溃/非零退出/策略违规中止)、Decide/Execute 闭环 E2E(含进程树击杀与重启恢复),以及**真实 Pi CLI 的协议冒烟**(0.73.x 实测:`agent_end` 完成事件、`tool_execution_*` 工具事件、进程复用;含真实模型 + bash 工具执行验证)。

## 目录结构

```text
cmd/zhulongx/     CLI 入口(run / goal / hint / fact / status / export / audit)
internal/fgs/     FGS 领域模型与状态转换规则
internal/store/   SQLite 持久化(WAL、审计、CAS 语义)
internal/engine/  调度引擎:Decide(全局串行)/ Execute(受预算并发)
internal/pi/      Pi RPC 适配器(含测试用 mockpi)
internal/contract/ Agent 输出提取与契约校验
internal/prompt/  Decide/Execute 提示词模板(内嵌)
internal/cfg/     配置加载与校验
e2e/              端到端测试
docs/zhulongx/    架构文档、源码映射、构建运行指南、遗留引用审计
testdata/upstream/ 上游 Cairn 基线(Python 原始快照,见下)
```

## 与上游 Cairn 的关系

- 本仓库是 [Cairn](https://github.com/oritera/Cairn)(AGPL-3.0)的 Go 深度重构:沿用其调度触发启发式、claim/heartbeat 租约、conclude→Fact 事务化与输出契约等核心机制;移除其多 Worker/多后端 Agent 体系,Pi 为唯一 Agent 运行时。模块级对应关系见 [docs/zhulongx/01-source-mapping.md](docs/zhulongx/01-source-mapping.md)。
- **上游基线**:`testdata/upstream/` 保存 Cairn 原始 Python 源码快照及其 Docker/配置/文档,不参与 zhulongx 的构建与运行;其回归测试可独立复现(`uv sync --project testdata/upstream/cairn --group dev && uv run --project testdata/upstream/cairn --group dev pytest`)。
- **许可证**:全仓库沿用 **AGPL-3.0**(见 `LICENSE`),衍生与版权声明见 [`NOTICE-zhulongx.md`](NOTICE-zhulongx.md)。商业化授权须另行联系上游作者与法律审查,**本项目不对商业可用性作任何承诺**。

## 限制与路线图

- [x] ~~与真实 Pi CLI 的集成验证~~(已完成:0.73.x 协议冒烟 + 真实模型/GLM bash 工具执行;E2E 回归仍用 mockpi 保证无需 key 可跑)
- [ ] Pi 工具桥接扩展(FGS 读写工具经 TypeScript 扩展暴露给 Pi,当前以提示词约束代替)
- [ ] Docker 部署与 CI 发布物
- [ ] 多目标并发调度的大型场景验证

## 免责声明

本项目仅可用于你**拥有或已获明确授权**的环境。你对使用方式负全部责任;未经授权对系统、网络、应用或数据进行安全测试、漏洞利用或数据访问可能违法。项目作者与贡献者不为任何滥用行为及其后果承担责任。

---

**License**:GNU AGPL-3.0(继承自上游 Cairn,全仓库适用)

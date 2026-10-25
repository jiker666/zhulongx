# zhulongx 构建与运行

## 依赖

- Go ≥ 1.27(`go.exe` 在 Windows 上通常位于 `C:\Program Files\Go\bin`)
- 纯 Go 依赖,无 cgo:`modernc.org/sqlite`(SQLite 驱动)、`gopkg.in/yaml.v3`
- 运行期唯一外部程序:**Pi CLI**(`pi` 命令可用)。运行时用哪个模型由
  用户自己的 Pi 配置决定,zhulongx 不假设、不配置模型。
- 国内网络环境可设 `GOPROXY=https://goproxy.cn,direct`

首次拉依赖:

```bash
go mod download
```

## 构建

```bash
go build ./...                      # 全量编译检查
go build -o zhulongx.exe ./cmd/zhulongx
```

## 配置

```bash
./zhulongx.exe init-config          # 生成 zhulongx.example.yaml 的副本
```

配置项(`zhulongx.yaml`):

| 键 | 默认 | 含义 |
|---|---|---|
| `db_path` | `zhulongx.db` | SQLite 文件(WAL 模式) |
| `log_level` | `info` | debug/info/warn/error |
| `runtime.tick_interval` | `2s` | 调度 tick,兼作心跳周期 |
| `runtime.decide_timeout` | `10m` | 单轮 Decide 的 Pi 调用超时 |
| `runtime.execute_timeout` | `15m` | 单个 Step 的 Pi 调用超时 |
| `runtime.max_concurrent_steps` | `2` | Execute 并发预算 |
| `runtime.max_steps_per_decide` | `3` | 单轮 Decide 最多声明 Step 数 |
| `runtime.step_max_attempts` | `3` | Step 重试上限 |
| `runtime.decide_noop_limit` | `3` | 连续空判轮数上限(超限自动停 Goal) |
| `pi.command` | `pi` | Pi CLI 命令或绝对路径 |
| `pi.args` | `[]` | 追加参数(自动补 `--mode rpc --no-session`) |
| `pi.dir` | `""` | 子进程工作目录 |
| `pi.spawn_retries` | `1` | Pi 启动失败重试次数 |
| `pi.blocked_tools` | `[]` | 工具封禁策略:大小写不敏感正则列表;bash 命令命中任一模式 → **运行中途 abort、硬杀进程、Step 判永久失败**(不重试)。空 = 不限制 |

## 运行

```bash
# 1. 建目标(返回 goalID)
./zhulongx.exe goal new --title "渗透测试" --origin "授权范围见合同" \
    --objective "拿到内网立足点" --config zhulongx.yaml

# 2. 补充人工事实/提示
./zhulongx.exe fact add goal_0001 --content "目标域名 example.com" --creator tester
./zhulongx.exe hint add goal_0001 --content "优先看 443" --creator tester

# 3. 启动调度循环(Ctrl+C 优雅退出,运行中 Step 释放为 pending)
./zhulongx.exe run --config zhulongx.yaml

# 4. 随时观察
./zhulongx.exe status                 # 所有 Goal 概览
./zhulongx.exe status goal_0001       # 图详情:steps/findings/facts
./zhulongx.exe audit goal_0001        # 审计轨迹(认领/回收/晋升/完成)
./zhulongx.exe export goal_0001       # 整图导出 YAML

# 5. 人工干预
./zhulongx.exe goal stop goal_0001
./zhulongx.exe goal resume goal_0001
./zhulongx.exe goal reopen goal_0001 --feedback "范围扩大到子公司"
```

标志位可写在位置参数前后(`--config` 放最后也有效)。

## 崩溃与重启

引擎被硬杀(断电、taskkill)时,运行中的 Step 停留在 running。
下次 `run` 启动即执行确定性恢复:running → pending(写
`step.reclaimed` 审计),随后按正常重试预算继续。租约心跳机制
(`HeartbeatStep`/`ReclaimStaleSteps`)保留,供多实例部署时兜底。

## 测试

```bash
go test ./... -count=1       # 全部:store/contract/pi/engine/e2e
go test ./e2e/ -count=1 -v   # 真二进制端到端(含崩溃恢复)
gofmt -l .                   # 应无输出
go vet ./...
```

e2e 会构建 zhulongx.exe 与 mockpi.exe 到临时目录,全程不接触真实
Pi CLI、不产生外部副作用。

## 常见问题

- **`pi: command failed` / 启动失败**:确认 `pi --version` 在同一环境
  可执行;配置 `pi.command` 为绝对路径。
- **Goal 一直 active 不推进**:看 `audit`——可能是 Decide 连续空判
  (noop 保护未触发前)或 Step 反复重试;`log_level: debug` 有完整
  上下文。
- **Windows 下测试残留进程**:引擎硬杀测试用 `taskkill /T /F` 清理
  进程树,手工排查可用 `tasklist | findstr mockpi`。
- **时间类测试偶发失败**:Windows 时钟量化约 0.5ms,纳秒级 TTL 断言
  已改为注入确定性的过期心跳,不受影响。

## Pi CLI 安装与 Provider 配置(实测 2026-10-26)

```bash
npm install -g @mariozechner/pi-coding-agent   # bin 名为 pi;注意不是 @mariozechner/pi(那是 GPU 部署工具)
pi --version                                    # 0.73.x
```

zhulongx 只按 `pi --mode rpc --no-session` 启动 Pi,模型/Provider 完全由你自己的
Pi 配置决定。自定义 Provider(如智谱 GLM 的 Anthropic 兼容端点)配置在
`~/.pi/agent/models.json`,`apiKey` 字段支持**环境变量名引用**(key 不落盘):

```json
{
  "providers": {
    "glm": {
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "api": "anthropic-messages",
      "apiKey": "ZHIPU_API_KEY",
      "authHeader": true,
      "models": [{ "id": "glm-5.3", "name": "GLM 5.3 (Anthropic-compat)" }]
    }
  }
}
```

注意:Pi 不读取 `ANTHROPIC_BASE_URL`;其内置 `anthropic` Provider 打官方端点。
走智谱等兼容端点必须如上自定义 Provider。

## 真实 Pi 冒烟测试

```bash
# 协议层(无需可用模型;会话以 agent_end 完成即通过)
ZHX_PI_SMOKE=1 go test ./internal/pi/ -run TestRealPiProtocolSmoke -v
# 真实模型往返(需已配置可用 Provider,如 ZHIPU_API_KEY + 上面的 glm 条目)
ZHIPU_API_KEY=... ZHX_PI_SMOKE=2 go test ./internal/pi/ -run TestRealPiProtocolSmoke -v
```

协议依据:@mariozechner/pi-coding-agent 0.73.1 包内 `docs/rpc.md` + 实测会话。
关键点:命令名走 `type` 字段;完成事件是 `agent_end`(`agent_settled` 为旧文档遗留名,
适配器双兼容);工具执行事件为 `tool_execution_start/update/end`(`toolName`/`args.command`);
`prompt` 响应 `success:true` 仅表示**已接受**,结果在事件流中。

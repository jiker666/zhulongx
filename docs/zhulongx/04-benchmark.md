# TSec Benchmark Platform 接入(zhulongx bench)

zhulongx 对 [TSecBench](docs 语境下的 TSec Benchmark Platform)Challenges API 的适配:平台下发一个跑分任务(一组安全题目 + 靶场容器),zhulongx 把每道题变成一个 Goal,由正常的 Decide/Execute 循环自主解题。

## 适配方式

职责划分与引擎架构一致——Go 只做它该做的(导入、复核),解题过程全部交给 Agent:

| 环节 | 承担者 | 说明 |
|---|---|---|
| **拉题导入** | `bench import` | 每道题一个 Goal(标题 `bench:<unique_code>`),origin 携带完整作战简报 |
| **解题** | Agent(Execute) | 经 bash + curl 自助调用 start / hint / submit / close,简报里给了全部端点速查与约束 |
| **状态复核** | `bench sync` | 以平台 `is_completed` 为真值,补写通关 Fact 并完成 Goal;发现"本地判完成但平台不认"时只报告不回滚 |

作战简报(origin)包含:题目元数据(描述/难度/满分/flag 数)、五个接口的完整 URL 模板、约束(3 容器上限、VPN、总时限、hint 扣分、duplicate 幂等)、完成自检判据(接口确认 `is_completed=true`,每个 flag 附 API 响应作为 Finding evidence)。简报随图快照进入每一轮 Decide/Execute 提示词,引擎零改动。

## 使用

```bash
# 1. 平台创建跑分任务,拿到 BENCHMARK_BASE_URL / BENCHMARK_TOKEN,并连上靶场 VPN

# 2. 注入环境(token 只走环境变量,不进配置文件/命令行/提示词)
export BENCHMARK_BASE_URL=https://<platform-host>
export BENCHMARK_TOKEN=<uuid>

# 3. 导入题目为 Goal(幂等,可重复执行)
./zhulongx.exe bench import

# 4. 正常跑调度循环;Agent 在自己的 bash 里用 $BENCHMARK_TOKEN 调平台 API
./zhulongx.exe run

# 5. 复核:平台确认通关的题自动完成 Goal;输出 MISMATCH 需人工复查
./zhulongx.exe bench sync
```

`--base-url` 可代替 `BENCHMARK_BASE_URL`;token 只认环境变量(拒绝空 token,防止误连)。Pi 子进程继承 zhulongx 的环境,所以 Agent 的 shell 里 `$BENCHMARK_TOKEN` 直接可用。

## 信任边界

- **平台是唯一真值**:Agent 自报"全部提交成功"不足以完成 Goal——`bench sync` 用平台 `is_completed` 复核后才落通关 Fact 并完成;本地完成但平台不认的,以 `MISMATCH` 报告,不自动回滚也不自动放行。
- **token 隔离**:`BENCHMARK_TOKEN` 只存在于环境变量与 HTTP 头;不写入 Goal/Fact/审计/提示词;简报中仅出现环境变量名。
- **授权范围**:解题操作只发生在平台下发、VPN 内可达的靶场容器上——这正是本项目"仅限已授权环境"边界内的标准场景。

## API 错误处理

客户端(`internal/bench`)把统一错误体 `{code, message, detail}` 解析为 `*bench.APIError`,提供 `bench.CodeIs(err, code)` 判定;覆盖 `task_not_found` / `challenge_not_found` / `invalid_state` / `duplicate` / `resource_unavailable` / `internal_error` 与 FastAPI 422 框架校验错误(归为 `validation_error`)。submit 在客户端先做 1~4096 长度校验,省一次 422 往返。

## 测试

```bash
go test ./internal/bench/ -count=1
```

覆盖:五个接口的编解码(httptest)、鉴权头断言、全部错误码与 422/非 JSON 体、flag 长度本地校验;导入幂等与非 bench Goal 隔离、平台确认完成→Goal 完成+通关 Fact、mismatch/missing 报告、重复 sync 稳定性。

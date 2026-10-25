# zhulongx 源码映射文档(Phase 1 产出)

> 基于 Cairn 真实源码的逐文件分析,给出 Cairn → zhulongx 的模块级映射。
> 分析日期:2026-10-26。Cairn 代码根:`cairn/src/cairn/`。
> 本文档是后续所有 Go 实现的依据;实现不得凭空发明行为,应能回溯到本文引用的源码位置。

## 1. 已通读的 Cairn 源码清单

| 文件 | 状态 |
|---|---|
| `server/app.py` / `server/db.py` / `server/models.py` / `server/services.py` | 通读 |
| `server/routers/projects.py` / `routers/intents.py` | 通读 |
| `dispatcher/scheduler/loop.py`(936 行) | 通读 |
| `dispatcher/contracts.py` / `dispatcher/config.py` / `dispatcher/models.py` | 通读 |
| `dispatcher/tasks/common.py` / `reason.py` / `explore.py` / `bootstrap.py` | 通读 |
| `dispatcher/prompting.py` / `output_parser.py` / `protocol/client.py` | 通读 |
| `dispatcher/workers/base.py` / `adapters/pi.py` | 通读 |
| `prompts/default/*.md`(reason/explore/bootstrap ×2) | 通读 |
| `runtime/local_process.py`(grep 定位 POSIX 依赖) | 部分阅读 |

外部参考:
- Pi RPC 官方文档(已抓取):https://pi.dev/docs/latest/rpc 、/rpc-commands 、/cli-integration
- Cairn_Y FGS 分析:https://l3yx.github.io/2026/08/30/... ;SapperLens、ARTEX 仓库(方法论参考)

## 2. Cairn 架构摘要(实测,非推测)

Cairn 是"黑板 + 白蚁觅食"式多智能体系统,三个角色:

1. **Server**(FastAPI + SQLite):持有图状态。核心表 `projects` / `facts` / `intents` / `intent_sources` / `hints` / `settings` / `counters`。Fact(id `origin`/`goal` 起始,之后 `f001…`);Intent(有向边,`from` 若干 Fact → `to` 一个 Fact 或 NULL=未完成)。
2. **Dispatcher**(轮询调度器):HTTP 轮询 Server,按 `dispatch.yaml` 选择 worker,在**每项目一个 Docker 容器**里 exec agent CLI。任务三类:bootstrap(首答直解)、reason(判断完成/提出新 Intent)、explore(执行一个 Intent)。
3. **Worker 适配器**:claudecode / codex / pi / mock 四种,把统一任务渲染成各 CLI 的命令行并解析输出。

关键机制(逐条对应源码):

- **claim/heartbeat 租约**(`routers/intents.py` + `services.py:expire_workers`):Intent 被 worker 认领(`worker` 列非空),任务期间线程每 interval 秒 POST heartbeat;超过 `intent_timeout` 无心跳 → `worker=NULL` 自动回收,别的 dispatcher 可重新认领。reason 有独立租约(projects 表 `reason_*` 四列)。
- **conclude 换 Fact**(`routers/intents.py:conclude`):explore 成功 → 新建 Fact + Intent.`to_fact_id` 指向它 + `concluded_at` 置时。原子事务。
- **complete**(`routers/projects.py:complete_project`):reason 判定目标达成 → 写一条 `to='goal'` 的 Intent,project 状态转 `completed`。`from` 不得包含 `goal`(services.py:validate_goal_not_in_sources)。
- **reopen**(`routers/projects.py:reopen_project`):completed 项目回滚:删除 completion intent,写入外部反馈 Fact,project 回 active。
- **reason 触发条件**(`scheduler/loop.py:_reason_trigger`):快照(fact 数, hint 数, open_intent 数)有增长,或 open intents 清零 → 触发 reason。防止空转:无变化不调度。
- **输出契约**(`contracts.py`):容忍 markdown 包裹的 JSON(`output_parser.extract_json_object`:整段→fenced block→逐 `{` 位置 raw_decode);reason 结果四种 `complete| intents | noop | rejected`;intents 在 open_intents 为空时必须非空,超出 `max_intents` 截断。
- **失败语义**:进程非零退出/超时(124/137)/JSON 解析失败 → 任务 failed 并 best-effort release;**模型自称成功不算数**,必须通过 contracts 验证才写图。
- **conclude fallback**(`tasks/explore.py:_try_conclude_fallback`):主阶段超时/解析失败但存在 session 时,用同一 session 追问"总结已确认的发现",把残局兑换成 Fact。
- **心跳丢失竞态**:heartbeat 返回 403/409 时任务立即终止(租约被抢)。

## 3. FGS 概念映射(Cairn → zhulongx)

| Cairn | zhulongx FGS | 语义变化 |
|---|---|---|
| Project(origin+goal 两个特殊 Fact) | **Goal**(一等实体:origin、goal、状态机 active→completed/stopped) | Project 的 status/reopen 语义并入 Goal |
| Fact | **Fact**(已验证结论) | 不变;但只能由 Execute 成功后写入 |
| —(无) | **Finding**(未验证观察) | 新增:Execute 产出先落 Finding,Decide 审阅后可提升为 Fact 或废弃 |
| Intent(有向边 from→to) | **Step**(待执行步骤,depends_on 若干 Fact,产出 Finding/Fact) | "边"改为"节点+依赖";claim/heartbeat 租约机制保留 |
| Hint | Hint(挂在 Goal 上,进 Decide 上下文) | 保留人类输入通道 |
| reason 任务 | **Decide 模式**(串行,全局唯一) | 判断完成/产出新 Step/提升或废弃 Finding |
| explore + bootstrap 任务 | **Execute 模式**(并发执行 Step) | bootstrap"直解路径"删除:Goal 创建后第一次 Decide 即承担首步规划 |
| worker(多后端) | (删除)Pi Agent Loop 唯一运行时 | 见 §5 |

## 4. 模块映射表

| Cairn 原模块 | 当前职责 | zhulongx 对应实现 | 处理方式 |
|---|---|---|---|
| `server/db.py` | SQLite schema、连接管理(WAL、外键) | `internal/store/schema.go` | **重写**:FGS 新 schema(goals/steps/findings/facts/hints/audit_log/计数器),WAL 保留 |
| `server/services.py` | id 生成、校验、**expire_workers/expire_reason_leases 心跳回收** | `internal/store/`(各方法)+ `internal/fgs/state.go` | **移植**:心跳过期回收语义保留;状态迁移改为显式状态机+审计 |
| `server/models.py` | Pydantic API 模型 | `internal/fgs/types.go` | **重写**:Go 结构体 Fact/Goal/Step/Finding |
| `server/routers/projects.py` | create/get/complete/reopen/status/title | `internal/store` + `cmd/zhulongx`(CLI 子命令) | **收缩**:去掉 HTTP 层(单进程),语义并入 store 方法与 CLI;reopen 保留 |
| `server/routers/intents.py` | create/claim/heartbeat/release/conclude | `internal/store`(step 认领/心跳/完成)+ `internal/engine/execute.go` | **移植**:conclude 的事务原子性(Finding+Step 状态一次提交)必须保留 |
| `server/routers/hints.py`、`settings.py`、`export.py` | Hint CRUD、超时设置、YAML 导出 | `internal/store` + `cmd/zhulongx export` | **移植**:YAML 导出保留(Decide 上下文输入);settings 并入配置文件 |
| `server/app.py` + `static/`(Web UI) | FastAPI 组装 + 网页黑板 | 不迁移 | **删除**:CLI `status` 提供可读视图;Web UI 列入"未来工作" |
| `dispatcher/scheduler/loop.py` | 轮询调度、项目轮转、reason 触发、worker 选择、futures 回收 | `internal/engine/scheduler.go` | **重写**:Decide 串行(单飞)+ Execute 并发(有界 worker 池);reason 触发条件(finding/fact/hint 增长或 open steps 清零)移植 |
| `dispatcher/tasks/reason.py` | reason 任务全流程 | `internal/engine/decide.go` | **重写**:prompt→Pi RPC→contract 验证→写图;竞态容忍(403/409)简化为单进程内的 Goal 状态检查 |
| `dispatcher/tasks/explore.py` | explore 执行 + conclude fallback | `internal/engine/execute.go` | **重写**:conclude fallback 由"同 session 二次进程"改为"同 Pi 会话二次 prompt"(RPC 模式天然支持);超时→abort 命令 |
| `dispatcher/tasks/bootstrap.py` | 首答直解 + complete 落图 | (并入 decide.go 首轮) | **删除独立任务**:zhulongx Goal 创建即触发 Decide;直解语义=Decide 一次产出 complete |
| `dispatcher/tasks/common.py` | 容器执行封装、心跳附着、释放、图快照写入 | 拆解:`internal/pi`(进程)+ `internal/engine`(释放)+ `internal/prompt`(上下文) | **拆散**:图快照不再写容器 /tmp,直接内联进 prompt |
| `dispatcher/contracts.py` | 输出 JSON 提取与验证 | `internal/contract/` | **逐条移植**:提取算法、complete/steps/finding 校验规则、max_steps 截断、open steps 空时必须给 steps |
| `dispatcher/output_parser.py` | JSON 对象鲁棒提取 | `internal/contract/extract.go` | **移植**:fenced-block 优先 + `{` 位置扫描算法 |
| `dispatcher/prompting.py` + `prompts/default/*` | 模板加载/占位符渲染 | `internal/prompt/` + `prompts/` | **移植并改名**:reason.md→decide.md,explore.md→execute.md,术语 Intent→Step,新增 Finding 提升/废弃输出格式 |
| `dispatcher/workers/base.py` + `registry.py` + `health.py` | 四种 CLI 适配器框架、健康检查 | (仅留接口) `internal/pi` | **删除多后端**:zhulongx 只对接 Pi;mock 行为由测试桩承担 |
| `dispatcher/workers/adapters/pi.py` | 旧式 Pi 一次性进程(`--mode json`)、事件流解析、models.json 注入 | `internal/pi/`(RPC 模式适配器) | **重写升级**:改为官方 RPC 模式(`pi --mode rpc --no-session` 长驻子进程,JSONL 双向);JSON-mode 的 `turn_end`/`agent_end` 解析被 `agent_settled` 事件 + `get_last_assistant_text` 取代 |
| `dispatcher/workers/adapters/claudecode.py`、`codex.py` | 其他 agent CLI 适配 | — | **删除**(违反"Pi 唯一运行时"约束) |
| `dispatcher/workers/adapters/mock.py` | 概率化 mock 输出 | `internal/pi/mock`(测试桩,Go) | **重写**:mock RPC 子进程(测试用),场景覆盖文档测试矩阵 |
| `dispatcher/protocol/client.py` | dispatcher→server HTTP 客户端 | — | **删除**:单进程直接调 store |
| `dispatcher/runtime/containers.py`、`backend.py` | Docker 容器编排/生命周期 | — | **删除**:zhulongx 以本地子进程运行 Pi(部署=单二进制+用户自备 pi);容器化列为部署选项而非内置 |
| `dispatcher/runtime/local_process.py` | 本地进程组管理(POSIX-only,Windows 不可用) | `internal/pi/process.go` | **重写**:Go `os/exec` + `context.Context` 取消,跨平台(Windows 兼容) |
| `dispatcher/runtime/heartbeat.py`、`cancellation.py` | 心跳线程、进程取消 | `internal/store`(claim 心跳)+ Go `context` | **重构**:单进程内由 engine 直接刷心跳;取消=ctx cancel→Pi abort→杀进程 |
| `dispatcher/config.py` | dispatch.yaml 解析、多 worker 校验、mock 行为配置 | `internal/cfg/` | **重写**:`zhulongx.yaml`(数据库路径、调度参数、Pi 命令行、超时/预算、步骤并发);删除 worker/container 段 |
| `dispatcher/models.py` | RunningTask/ReasonCheckpoint 快照 | `internal/engine/state.go` | **移植概念**:Decide 触发快照 |
| `cli.py`(serve/dispatch 子命令) | 入口 | `cmd/zhulongx/main.go` | **重写**:`zhulongx run`(主循环)/`status`/`export`/`init-config` |
| `tests/*` | 行为基线(contracts、租约、调度) | `internal/**/*_test.go` + `e2e/` | **移植语义**:契约验证、状态迁移、心跳过期、mock RPC 矩阵、崩溃恢复 |

## 5. 明确不迁移的内容与理由

1. **多 worker 后端**(claudecode/codex/pi 并存):违反"Pi 是唯一 agent 运行时"的硬约束。
2. **Docker 容器编排**(per-project worker 容器、docker.sock):zhulongx 定位单机单二进制;隔离交给用户部署层(将来可容器化运行 zhulongx 本身)。相应的 `network_mode`、`cap_add`、`completed_action` 配置全部移除。
3. **HTTP Server/Dispatcher 分离**:两进程+HTTP 租约协议是为了多 dispatcher 竞争;zhulongx 单进程内嵌 store,租约退化为进程内互斥 + 崩溃恢复(重启时 running→pending)。
4. **bootstrap 独立任务**:与 reason 语义重叠;Goal 创建后的第一次 Decide 覆盖该场景(`goal.bootstrap` 路径不再需要)。
5. **Web UI**:不在本期范围,CLI status 替代。
6. **健康检查(startup_and_task)**:模型连通性由 Pi 自身管理;zhulongx 只在 Pi 进程崩溃/超时层面做有界重试,不做模型级 ping。

## 6. Pi RPC 协议要点(zhulongx 适配器依据)

来源:官方文档(2026-10 抓取)。与 Cairn 旧 pi 适配器(`--mode json` 一次性进程、解析 stdout 事件)完全不同:

- **启动**:`pi --mode rpc --no-session`(可加 `--provider`/`--model`/`--session-dir`/`--cwd` 等;zhulongx 不覆盖 provider/model,模型由用户 Pi 配置决定)。
- **分帧**:stdin/stdout 各一行一个 JSON 对象,LF 结尾(容 CR);**绝不能按 U+2028/2029 分行**。stderr 只做诊断日志,不参与协议。
- **关联**:每条命令可带 `id`;响应 `{"id","type":"response","command","success","data"|"error"}`。响应乱序合法,必须按 id 关联。非法 JSON → `command:"parse"` 的失败响应(无 id)。
- **请求被接受 ≠ 任务完成**:`prompt` 响应 `data.disposition ∈ {started, queued, handled}` 只表示已受理;**完成标志是 `agent_settled` 事件**(`agent_end` 只是一次低层 run 结束,后面可能还有)。
- **取最终文本**:命令 `{"type":"get_last_assistant_text"}` → `data.text`;配合 `message_end`(权威消息)事件流。
- **取消**:命令 `{"type":"abort"}`;进程级兜底 kill。
- **优雅关闭**:关闭 stdin;信号处理。
- **工具桥**(zhulongx 需要的最小 TS 扩展,仅当内置工具不足):`pi init-extension` 脚手架,`messages`/`tools` UI;不引入其他 agent loop。

## 7. 风险与不确定项

1. **事件流 payload 细节未全量确认**:`agent_settled`/`message_end` 的字段以文档示例为准,adapter 对未知字段做透传保留,测试用 mock 按文档形状生成;真实 Pi 联调列为验收前的独立步骤。
2. **Pi 未安装在本机**:E2E 用 mock RPC 子进程;真机测试需要用户环境提供 `pi` CLI(`npm i -g @mariozechner/pi-coding-agent` 或官方渠道)。
3. **AGPL-3.0 合规**:zhulongx 衍生自 Cairn(AGPL-3.0),保留原版权声明与 LICENSE 全文,新增 NOTICE 说明衍生关系与修改范围。
4. **Windows 开发环境**:Go 测试全平台可跑;涉及真实进程信号行为的用例在 Windows 上语义弱化(仅文档化,不降低断言)。

## 8. 分支与历史策略(执行记录)

原目录是 zip 解包、无 `.git`。处置:在仓库根 `git init`,首次提交收录**未修改的原始源码**作为基线(含本任务之前生成的环境配置文件,但**剔除含密钥的 dispatch.yaml**,以占位版入库);随后建 `zhulongx` 分支开发。原 zip 不含 git 历史,此为无法保留项,已在交付物"局限性"章节如实说明。

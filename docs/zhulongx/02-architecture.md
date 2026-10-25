# zhulongx 架构(中文)

zhulongx 是一个独立 Go 项目,核心设计是**三段式分离**:

```
┌─────────────────────────────────────────────────────────────┐
│  ① Go 调度器        cmd/zhulongx + internal/engine          │
│     Decide/Execute 循环、并发预算、超时/取消/重试、恢复      │
├─────────────────────────────────────────────────────────────┤
│                ↕ Runner 接口(进程边界)                     │
│  ② Pi Agent Loop    internal/pi  (`pi --mode rpc --no-session`)│
│     唯一 agent 运行时;JSONL RPC 协议;stdout 数据/stderr 诊断│
├─────────────────────────────────────────────────────────────┤
│                ↕ Store 接口(SQLite, WAL)                  │
│  ③ FGS 状态图       internal/fgs + internal/store           │
│     Fact / Goal / Step / Finding;合法迁移;审计;恢复        │
└─────────────────────────────────────────────────────────────┘
```

三段各自独立编译、独立测试:调度器不 import 协议细节之外任何 agent
实现;Pi 适配器不知道 FGS 语义;store 层不知道有 agent 存在。

---

## ① Go 调度器(internal/engine)

只有两种模式,**没有第三种角色**:

### Decide(**全局串行**——同一时刻整个引擎至多一轮,跨 Goal 也互斥)
- 触发启发式:首次见到 Goal / Fact 增长 /
  Finding 增长 / Hint 增长 / 开放 Step 清零。
- 先**审查 Finding**(promote→新 Fact、discard),再处理裁决——顺序是有意的:
  `complete.from` 可能引用本轮 promote 刚生成的 Fact,先 complete 会让
  store 拒绝后续审查(goal 已非 active)。
- 裁决三种:complete(引用既有 Fact)、steps(声明新 Step,带 DependsOn)、
  noop(连续 `decide_noop_limit` 轮且无开放 Step → 自动停 Goal,
  避免无界空转)。
- 模型输出经 `internal/contract` 校验:JSON 对象提取、契约校验、
  非法引用(Fact 不存在)的 Step 整条丢弃,**不**静默降级。

### Execute(有界并发,默认 2)
- `ClaimNextStep` CAS 认领(attempts+1),心跳租约按 tick 续期;
  心跳丢失(goal 被停 / 重启竞态)→ 主动中止。
- 推送单个 Step 的 prompt 给 Pi,等待 `agent_settled`。
- **模型说成功 ≠ 任务成功**:输出必须含合法 finding 契约
  (content + evidence),否则该次尝试判为可重试失败。
- 错误三分类:
  | 类别 | 判定 | 后果 |
  |---|---|---|
  | 可重试 | 超时、进程退出、协议噪声、无 JSON、非法 payload | attempts<max → pending,否则 failed |
  | 永久 | permission denied / eacces / unauthorized / quota | 直接 failed,不耗尽重试 |
  | 取消 | claim 丢失或引擎关停 | 释放为 pending(下次重启重试) |
- 终态写库用**脱离引擎生命周期的 10s context**——引擎关停/取消后
  状态也必须落盘(finally 语义)。

### 恢复
- 启动时 `RecoverAllRunning`:所有 running Step 确定性回到 pending,
  写 `step.reclaimed` 审计。zhulongx
  单进程模型下启动即回收,更快且无 TTL 时钟量化的坑。

## ② Pi Agent Loop 适配(internal/pi)

- 唯一 agent 运行时;无多 worker/多后端体系。
- 启动:`pi --mode rpc --no-session`,stdin/stdout 交换严格 LF 分帧的
  JSONL;stderr 只作诊断(环形缓冲,不参与协议)。
- **完成语义**:`prompt` 响应的 `disposition ∈ {started,queued,handled}`
  只表示**受理**,不是完成;真正完成是 `agent_settled` 事件。之后用
  `get_last_assistant_text` 取最终文本(流式 `message_end` 文本作后备)。
- id 关联:响应可能乱序,按 id 唤醒对应 waiter。
- 超时:先发 `abort`,再关 stdin(5s 宽限)→ 强杀,返回 `ErrTimeout`。
- 崩溃/非零退出:`ErrProcessExit`;非法 JSONL:`ErrProtocol`;空请求无
  settled:同样超时或进程退出兜底。
- 每次 Decide/Execute 各起一个**隔离进程上下文**,不共享会话状态;
  启动失败按 `spawn_retries` 有界重试。

### 工具桥接决策(MVP)
MVP 直接使用 Pi 内建工具集(bash、edit 等),不为 zhulongx 写 TS 扩展。
理由:zhulongx 的价值在调度与状态图,不在自定义工具;工具层由用户
自己的 Pi 配置决定。预留路径:官方 `pi init-extension` 生成的 TS 扩展
可注册自定义工具,Go 侧无需改动(Pi 子进程内部消化)。这是"最小 TS
扩展仅用于工具桥接"约束的落地方式——当前为零 TS 代码。

### 工具权限(封禁策略)
`pi.blocked_tools` 配置大小写不敏感正则列表。zhulongx 在 agent 进程
**外部**,无法在命令执行前拦截——诚实且有效的执行点是**运行中**:
适配器监听 `bash_execution_update` 事件,命令命中封禁模式即刻

1. 中止当前 prompt(不等 `agent_settled`),返回 `ErrPolicyViolation`;
2. **硬杀** agent 进程(被判死的运行不做优雅排空);
3. 引擎把该 Step 判为**永久失败**(重试同样会撞墙),审计留痕。

执行前拦截需要 Pi TS 扩展(见上节未来路径);当前实现是事后即中止,
这个边界在 NOTICE 中如实声明。

## ③ FGS 状态图(internal/fgs + internal/store)

- **Fact**:只增不改。来源链 `source`(human / `decide:promote:fd_xxxx`)。
- **Goal**:active → completed | stopped;stopped ⇄ active;completed →
  active 仅经 `reopen`(带人工反馈,写审计)。completed 只能由
  `CompleteGoal` 达成(引用 Fact),普通 SetGoalStatus 拒绝直达。
- **Step**:pending → running → done | failed;running → pending
  (取消/心跳丢失);failed → pending 仅人工重试路径。带 DependsOn
  (引用 Fact,创建时校验存在)、attempts、claim/heartbeat 租约。
- **Finding**:open → promoted(→ 新 Fact)| discarded。**只有 Decide
  能改变 Finding 状态**——这是信任边界:Execute 产出 Finding 只是"观察",
  晋升为 Fact 必须经过 Decide 审查。
- 全部状态变更走 `transition.go` 的合法迁移表;SQLite CHECK 约束 +
  WAL + 单连接(避免嵌套查询死锁);每步操作写 `audit` 表
  (seq/actor/action/entity/detail)。

---

## 测试矩阵

| 层 | 方式 | 覆盖 |
|---|---|---|
| store | 内存 SQLite 单测 9 例 | 迁移合法性、claim 竞态、租约回收、审查原子性、非法直达 completed |
| contract | 表驱动 12 例 | 整体/围栏/交错 JSON 提取、契约校验、截断、互斥 |
| pi | **真实 mockpi 子进程** 14 例 | 正常/多行/工具事件/完成语义/非法 JSON/超时/取消/崩溃/非零退出/settled 早于响应/无文本/策略违规中途中止/未命中放行 |
| engine | fake Runner 11 例 | 闭环到完成、重试与耗尽、永久失败、noop 停机、启动恢复、Decide 全局串行、策略违规永久失败 |
| e2e | 真二进制 + 真 SQLite + mockpi | 建目标→Decide→Execute→中途硬杀→重启回收重试→promote→completed→审计/导出 |

mockpi 是按官方 RPC 协议文档实现的测试替身,不是缩水的 stub——
它能复现协议全部失效模式。

# CTF Agent 参考项目研究

本文记录 2026-08-11 至 2026-08-14 对四个公开仓库的定点审阅。结论只对应下列 commit，不把项目 README 的成绩声明当作玄枢已经复现的结果。

| 项目 | 审阅 commit | 可验证的关键信息 |
| --- | --- | --- |
| [FishCodeTech/muteki](https://github.com/FishCodeTech/muteki) | `a585a2943a15efc4de78b00a385335fc9b1f23f1` | 多引擎 race、共享黑板、dead-end、旁路 review、flag provenance gate 和 winner cancellation。仓库为 AGPL-3.0。 |
| [verialabs/ctf-agent](https://github.com/verialabs/ctf-agent) | `3366d569557c4fda3fd153040632de65e255396d` | README 报告 BSidesSF 2026 取得 52/52；每题由异构模型 swarm 竞速，coordinator 读取工具 trace 并下发针对性纠偏，每个 solver 使用独立工具容器。仓库为 MIT。 |
| [Yeti-791/Tsec-Hackathon](https://github.com/Yeti-791/Tsec-Hackathon) | `7b264c7f20cf11e790855194692a494aedbdb21c` | 赛事材料将第一名概括为 Manager/Solver/Observer、三层上下文压缩、受约束终止和七模型竞争；第三名 Bytex/Cairn 使用平等 worker 与黑板，并被材料称为全场唯一 AK，成本约 7692 元。 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `47f943859bef60e4160492346772ded9b24f765a` | 追加式 SessionEvent、连续序号、surface/log-only 双投影、request header/context、子 Agent 描述、Trajectory 来源视图，以及基于同一日志的 resume/fork/replay。仓库为 MIT。 |

## 成绩声明的边界

- Muteki 的 README 展示 `200/200`，但同一 commit 的 `public_eval/RESULTS.md` 明确写明：200 题中 65 题是 measured，135 题是 projected；measured 部分为 59/59 个可部署题解出。因而 `200/200` 不能作为 200 题逐题实测满分使用。
- ctf-agent 的 `52/52` 是仓库作者对真实比赛成绩的公开声明；本次只做源码和文档审阅，没有比赛环境、ground truth 和同等模型额度，未独立重放 52 题。
- Tsec-Hackathon 同时列出“最终排名第一”和“全场唯一 AK”两种不同维度：唯一 AK 是第三名 Bytex，不应写成第一名必然 AK。
- 模型版本、上下文窗口、并发额度、工具镜像、比赛基础设施和 token 成本都是成绩的一部分。仅复制 prompt、skill 或工具清单不能推出同等分数。

## 真正可迁移的机制

1. **用异构探索覆盖盲区。** 同题多 agent 的价值来自不同模型、推理强度和探索方向的不相关失败，而不是简单重复同一个 prompt。
2. **共享结论，不共享混乱。** 黑板只传递有来源的事实、候选和已证伪路线；worker 仍需独立验证，并保留独立 scratch，避免上下文和文件互相污染。
3. **让监督基于 trace。** coordinator/reviewer 应读取工具调用与直接观察，针对当前卡点给出纠偏；不能依赖模型自述的“已经验证”。
4. **答案必须过 provenance gate。** race 只应在候选答案绑定到可复查证据后结束，并立即取消、等待其他 worker 收尾，控制后台成本和资源泄漏。
5. **工具覆盖决定能力上限。** SageMath、RsaCtfTool、CADO-NFS、flatter、radare2、stegseek、Sleuthkit、Volatility、OCR 和音频工具填补的是确定性的执行缺口；它们不能替代策略和验证。
6. **上下文和停止条件同样重要。** 压缩、dead-end、重复动作检测、checkpoint、finalization reserve 和明确的 blocked 状态共同防止长任务退化。
7. **让会话日志成为唯一事实源。** 恢复、检索、回放、分叉和 UI 不应各维护一份容易漂移的状态；它们应从同一连续事件序列投影，并显式记录来源、关联和继承边界。

## DeepSeek Harness 轨迹设计迁移

- 玄枢沿用已有 `audit.jsonl` 哈希链，不引入另一套 Session 数据库。事件信封增加 `source`、`actor`、`correlationId` 和可选 `parentSequence`，旧日志仍按事件类型推断来源。
- 每次模型调用前记录经过脱敏和限长的 `model.context`：系统提示词、公开消息、工具 schema、数量与 digest。隐藏 reasoning、密钥、Authorization、Cookie 和图片像素仍按项目安全约束禁止持久化。
- `tool.requested -> policy.decision -> tool.result` 使用同一工具调用 ID 和父序号，Trajectory 可以确定地解释动作、策略与结果，而不是按相邻时间猜测。
- 前端从原始事件流派生小白解释、来源筛选、检索和滑杆回放；原始技术事件与证据图保持独立可查。
- `fork` 在指定连续事件序号创建新运行，`resume` 只从父运行最后序号继续。继承内容是公开轨迹投影，并标记为“数据而非指令”；父日志不修改，未知副作用不自动重放。

## Skill 审阅结果

- Muteki 的仓库级 skill 是 `skills/muteki-blackboard/`，提供读事实/dead-end、发布事实、标记死路和协调 intent 等黑板操作。玄枢借鉴的是最小数据协议，并以自己的 TypeBox 工具、内存上限、脱敏、`PolicyEngine` 和审计重新实现；没有复制其 AGPL Python/Markdown 内容。
- ctf-agent 在所审阅 commit 中没有独立 skill 目录。它的主要资产是 solver/coordinator prompt、message bus、逐工具 trace 和 sandbox 工具镜像，不能把这些统称为可直接安装的 skill。
- Tsec-Hackathon 的 `零界论坛工具包/skills/SKILL.md` 绑定特定论坛接口、比赛角色和拿 flag 流程。它适合作为该赛题的接入说明，不适合作为玄枢的通用 skill，因此没有引入。

同样没有照搬 ctf-agent README 所述的“solvers never give up”策略，也没有开放其容器内的任意联网 shell、包管理器或 Podman。玄枢的运行必须受 operator-owned scope、工具/网络/时间预算、finalization reserve 和 `AbortSignal` 约束；需要更多能力时只能在构建期扩充镜像，再由 allowlist 显式开放。

## 已落到玄枢的改动

- 同题 race 使用进程内 `SharedEvidenceBoard`，只保存 `fact`、`candidate`、`dead-end`。默认最多 64 条、64 KiB；文本有长度上限、去重、来源 run、置信度合并、淘汰和敏感文本脱敏。
- `read_shared_evidence`、`publish_shared_evidence` 只在 race run 注册。二者与其他行动一样经过 `PolicyEngine`、工具/动作/重复调用预算、checkpoint、finalization reserve 和审计链；共享内容只是 hint，系统提示要求独立复核。
- checkpoint 中带证据的 hypothesis 和 `record_finding` 会自动发布到证据板。竞速 agent 获得通用探索 lens，winner 仍须通过结构化 submission 与独立验证闸门；其他 run 被取消并等待结束。
- core sandbox 增加可构建 smoke test 的 Crypto/Misc/Forensics 工具；opt-in heavy profile 固定安装 SageMath、RsaCtfTool、CADO-NFS、flatter、radare2、stegseek，以及 angr/qiling/frida/torch/transformers。

这些实现没有复制 Muteki 的 AGPL 源码，也没有引入 Tsec 论坛 skill/MCP 中的目标专属接口、selector、prompt injection 流程或固定答案。所有 sandbox program 仍只能通过 operator allowlist 中的 `run_command` 使用；sidecar 无外网，主动 HTTP/TCP 仍经过配置范围内的 `PolicyEngine`。

## 仍缺少的验证

当前改动提高的是架构和工具覆盖，不构成 AK 保证。下一步应在固定公开集、隔离 validation 集和从未参与调参的 hidden 集上记录：逐题成功率、错误提交率、到首个已验证答案的时间、token/费用、工具失败率和取消延迟。至少比较单 agent、三 agent 无共享、三 agent 有共享三组，才能判断证据板带来的净收益，而不是只看到并发增加后的总成功数。

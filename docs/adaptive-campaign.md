# Adaptive Campaign

Adaptive Campaign 是玄枢面向长任务的受控编排层，吸收 Cruiser-Agent 的调度优点，同时保留玄枢的 `PolicyEngine`、operator scope、沙箱和预算边界。

## 工作方式

每个输入任务会先创建一个或多个独立 lane。worker 使用带 generation 的租约原子认领 work item，并为每个 item 启动一个独立 Run。Run 的 `context.injected` 会包含三类公开上下文：

- `campaign-board`：共享证据的有界快照；
- `campaign-curator`：最近一次确定性整理摘要和后续建议；
- `claimed-investigation`：当前 worker 的层级、lane 和调查焦点。

Run 结束后，curator 只从公开的 findings、hypotheses、verification、summary 和 stop reason 生成 bounded evidence。隐藏思维链、模型凭据、授权头和 cookie 不会进入 Campaign 状态或事件。

失败或受阻的 item 才会进入下一层：广度勘察、重点分析、独立验证、恢复与收敛。提示通过 operator 提供的配置按层延迟注入；默认没有外部提示源，也不会自行联网。

## 安全与资源

- Campaign 不新增网络工具。每个 Run 仍通过 `PolicyEngine`，scope override 只能收窄 operator scope。
- worker、租约、运行时长、item 数和 Run 数都有上限；停止 Campaign 会取消队列并中止活动 Run。
- 共享证据、curation 和 Campaign 事件都做长度、数量和敏感信息边界处理。
- Campaign 的 `completed` 表示其调查队列已收敛；独立验证另由 `verifiedRuns` 计数，平台型场景仍应以平台响应作为最终真值。

## API 与界面

- `GET /v1/campaigns`：列出 Campaign 和 bounded 事件流。
- `POST /v1/campaigns`：创建任务；`tasks` 支持字符串或受控 TaskRequest。
- `GET /v1/campaigns/:id`：读取单个 Campaign。
- `POST /v1/campaigns/:id/stop`：停止并取消未认领任务。

前端“自主编排”页面展示认领、Run、证据整理、层级升级和独立验证；具体 Run 可跳转到完整的只追加轨迹和模型可见上下文。


# 第三阶段 B：Controlled Browser Runtime

Browser 能力以现有 ToolSet 的单一 `browser` 工具提供。调用顺序仍为：

`Browser Role → Planner → WebActionGuard → PolicyEngine → ToolSet → ControlledBrowserRuntime`

Runtime 为每个 Run 创建独立的 Playwright Chromium Context，不持久化 Playwright 对象。逻辑会话只保存受限状态摘要；恢复时必须重新创建物理 Context，并重新通过 NavigationGuard。

默认限制包括：仅 HTTP(S)、仅配置的 `allowedHosts`、禁止任意 JavaScript、禁止下载/上传/弹窗/截图、禁止密码字段填充、限制页面/导航/动作/DOM/网络事件预算，并支持 `AbortSignal`。

DOM Snapshot 只保存交互元素、表单、链接、脚本元数据和哈希；Network Recorder 只保存 URL、方法、状态、Header 名称、请求体形状和摘要，不保存 Cookie、Authorization 或完整响应体。

Chromium 不存在时，能力检查返回不可用，Browser Tool 失败并记录审计事件；任务不会伪造 Browser 结果，Planner 可以回退到现有静态分析和 HTTP 工具。

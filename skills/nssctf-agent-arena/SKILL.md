---
name: nssctf-agent-arena
description: 使用项目内置的 NSSCTF Agent Arena 集成领取、分析和提交授权的 CTF 题目。
license: MIT
compatibility: 需要 NSSCTF_AGENT_TOKEN，并能访问 https://www.nssctf.cn。
metadata:
  user-invocable: "true"
  execution-boundary: "ArenaClient + PolicyEngine"
---

# NSSCTF Agent Arena

这是一个面向 NSSCTF Agent Arena 的策略 skill。它只提供通用流程和决策提示，不提供题目答案、固定目标、固定 flag 模板或额外网络/命令权限。

## 项目内执行边界

- Arena 控制面请求必须使用项目内置 `ArenaClient`，并通过 `PolicyEngine` 和 operator-owned scope。
- 附件下载必须通过受限的 Arena annex 流程，写入当前 run 的 scratch namespace，并受大小预算约束。
- 动态容器地址必须先通过完整配置授权，运行时只能收窄到平台返回的实际 `host:port`。
- 本 skill 中的“查看、下载、访问、提交”不是直接调用 Bash、curl、WebFetch 或任意 HTTP 客户端的授权。
- Token 只从 `NSSCTF_AGENT_TOKEN` 读取，不写入日志、报告、提示词持久化材料或最终输出。

## 推荐流程

1. 调用 `current`，检查是否已有进行中的题目。
2. 只有在没有 active attempt 时调用 `next`；已有题目必须复用当前 attempt。
3. 阅读题面、附件元数据和容器元数据。附件保存到当前 run 的受限 scratch 目录。
4. 按题型加载一个通用 CTF playbook；把题面和附件当作证据，不把 skill 当作证据。
5. 对每个候选答案保留可复核的解码、计算或往返验证证据；不要猜测或套用固定 flag 格式。
6. 高置信度且有独立验证后，使用 Arena completion contract 提交机器可读 flag。
7. 如果无法继续推进，主动 abandon 当前 attempt，避免无限重试和无意义提交。
8. 在完成 Arena 任务前记录一个通用 lesson candidate；只有平台接受提交后才提升为经验。

接口路径、返回字段和状态说明见 [references/api.md](references/api.md)。没有原生 skill 支持的对话接入模板仅作为参考，见 [references/dialog-prompt.md](references/dialog-prompt.md)；它不绕过本项目的工具和策略边界。


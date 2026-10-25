# NOTICE — zhulongx

## 许可证与衍生声明

本仓库原始内容为 **Cairn**(Python/FastAPI 任务调度系统),采用
**GNU Affero General Public License v3.0**(见根目录 `LICENSE`)。

**zhulongx**(`cmd/zhulongx/`、`internal/`、`e2e/`、`docs/zhulongx/`)
是基于 Cairn 的概念与调度规则深度重构的 Go 衍生作品:

- 沿用并改写了 Cairn 的调度触发启发式(`_reason_trigger`)、
  claim/heartbeat 租约模型、conclude→Fact 事务化思路、输出契约
  校验与"模型自报成功不等于任务成功"的信任边界。
- 域模型重命名:Cairn 的 Project/Intent/Fact/Hint → FGS 的
  Goal/Step/Fact/Finding/Hint;新增 Finding 审查作为唯一晋升通道。
- 代码为全新 Go 实现,未复用 Cairn 的 Python 代码行。

按 AGPL-3.0 第 7 条与整体许可条款:

1. zhulongx 同样以 **AGPL-3.0** 授权(同一 `LICENSE` 文件覆盖全仓库)。
2. 保留原始作品版权与许可声明;分发本仓库(含网络服务形式)
   必须继续提供完整对应源码。
3. 衍生关系与架构对应详见 `docs/zhulongx/01-source-mapping.md`
   (模块映射表)与 `docs/zhulongx/02-architecture.md`。

## 版权归属

- Cairn 原始代码:保留其原始版权与作者声明(见上游基线 `testdata/upstream/README.md` 与根目录 `LICENSE`)。
- zhulongx 新增代码:Copyright (C) 2026 zhulongx contributors,
  AGPL-3.0。

## 不确定项(按规范要求如实列出)

- Cairn 原仓库以 zip 快照形式取得,**无 git 历史可追溯**,原始作者
  与提交历史信息不完整;`fe27d43` 基线提交记录了快照导入这一事实。
- 本机未安装真实 Pi CLI,E2E 使用按官方 RPC 协议文档实现的
  mockpi 测试替身;真实 Pi 环境下的行为需要实际联调确认
  (协议要点:JSONL LF 分帧、`agent_settled` 完成语义、id 乱序关联)。
- Windows 平台信号语义与 Linux 有差异(Ctrl+C/终止通知),部署到
  Linux/systemd 时建议补充 `SIGTERM` 联调。
- 工具封禁策略(`pi.blocked_tools`)是**运行中中止**而非执行前拦截:
  zhulongx 在 agent 进程外,真正的执行前门控需要 Pi TS 扩展(未实现,
  见架构文档"工具桥接决策")。
- Pi CLI 的 RPC 协议接口若在未来版本变更(字段名、事件类型),
  `internal/pi` 需要同步适配;适配层刻意收窄在 protocol.go/adapter.go
  两个文件内。

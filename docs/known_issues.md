# Known Issues

- 当前目录可能不是 git 仓库；release check 会跳过 git tracked 文件检查。
- 本机可能存在旧的 CyberPilot 容器，占用默认容器名或端口。决赛建议使用 `COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up`。
- 当前测试机器的 `podman compose` 会调用外部 compose provider，这是本机工具链配置，不影响 compose config 和独立项目启动验证。
- 本机存在 `.DS_Store`、`.env`、`data/cyberpilot.db` 等运行/隐私文件；release check 会提示，package 会排除，不会自动删除用户数据。
- SQLite 适合演示和初审，不适合高并发生产部署。
- 动态重规划为最小可用规则闭环，尚未实现多 run_id 的完整历史隔离。
- LLM JSON 输出稳定性依赖模型质量；当前有规则 fallback。
- `DEV_ALLOW_PRIVATE_TARGETS=true` 仅作为历史兼容开关；决赛访问内网靶场必须使用 `COMPETITION_MODE=true` 和显式 `SCOPE_CIDRS/SCOPE_DOMAINS/SCOPE_PORTS`。
- FinalOps 目前使用本地队员名称字段做协同，不包含复杂账号/权限系统。
- APIRunner 默认只执行 GET 类接口；非 GET 接口仅生成建议，需人工确认后再由 HttpReplayTool 发送。

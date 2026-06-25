# Failure Playbook - FinalOps v4

现场处理原则：先保留证据，再定位原因；先恢复操作流，再考虑代码改动。除非裁判允许，不在比赛现场新增攻击功能或关闭安全边界。

| # | 症状 | 快速检查 | 处理方式 | 不要做 |
|---|------|----------|----------|--------|
| 1 | 页面打不开 | `podman ps`、`curl http://localhost:13000/final-ops` | 使用 `COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up` 重启 | 不切到 Docker |
| 2 | 后端无响应 | `curl http://localhost:18000/api/health` | 看 `make final-logs`，确认后端端口和容器状态 | 不删除数据库 |
| 3 | 端口冲突 | `make doctor` | 改用 13000/18000 或其他未占用端口 | 不 kill 不相关进程 |
| 4 | Podman compose 解析失败 | `podman compose -f podman-compose.yml config` | 检查 `.env` 中端口值是否为空或非法 | 不改 compose 架构 |
| 5 | ScopeGuard 拦截目标 | Settings 粘贴 URL 检查 | 对照 `.env` 的 CIDR、域名、端口和 competition mode | 不绕过 ScopeGuard |
| 6 | 允许目标仍被拦截 | 查看 `matched_rule`、解析 IP、端口 | 把裁判授权范围补到 `.env` 并重启容器 | 不使用 `DEV_ALLOW_PRIVATE_TARGETS` 代替 |
| 7 | LLM 不可用 | Settings 的 LLM 测试 | 保持规则兜底，继续 `Triage` 和人工回填 | 不把真实 Key 写进代码 |
| 8 | Triage 没有候选 | 查看 `latest_summary`、证据数量 | 人工查看附件，使用人工回填和 Candidate | 不盲目提交 |
| 9 | 候选答案错误 | 点击 `Rejected` | 错误候选会降置信，再记录人工原因 | 不直接删证据 |
| 10 | 重复点击 Triage | 看按钮 loading 和任务列表 | 等当前任务完成后刷新 | 不并发刷同一题 |
| 11 | 导入题单失败 | 检查 JSON/CSV/Markdown 格式 | 先导入 1 条样例，确认字段 name/type/description | 不现场写复杂转换脚本 |
| 12 | 备份导出失败 | `curl http://localhost:18000/api/final-ops/export` | 用 `make backup-final` 走后端脚本导出 | 不复制数据库文件当备份 |
| 13 | 备份导入重复 | 看导入返回新增数 | 导入按 name+description 去重，重复为正常现象 | 不清空数据库重导 |
| 14 | Brief 复制为空 | 打开具体 Challenge | 确认候选和证据已生成；没有则先人工回填 | 不提交空答案 |
| 15 | Debrief 数字异常 | `curl /api/final-ops/debrief` | 检查是否只标记 Solved 未记录 Submit/Accepted | 不改统计代码 |
| 16 | 前端 build 失败 | `cd frontend && npm run build` | 按 TypeScript 报错修复 UI 类型或接口字段 | 不跳过 build 打包 |
| 17 | 后端测试失败 | `cd backend && python3 -m pytest -q` | 只修失败用例关联代码，避免大改 | 不忽略测试 |
| 18 | 安全审计失败 | `make safety-audit` | 查看 `safety_audit_report.md`，移除危险实现或敏感文件 | 不白名单真实漏洞能力 |
| 19 | 打包含运行数据 | `make package` 后看 `dist/SHA256SUMS` 和 zip 清单 | 确认 `.env`、`backups/`、db、uploads、reports 被排除 | 不手工拖文件打包 |
| 20 | 裁判问“为什么不全自动” | 展示 `docs/security_boundary.md` 和 `docs/team_sop.md` | 说明授权范围、人工确认、证据复现和安全边界 | 不承诺未实现能力 |

## 常用命令

```bash
make doctor
cd backend && python3 -m pytest -q
cd frontend && npm run build
make demo-smoke
make final-drill
make team-drill
make safety-audit
make release-check
make package
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-down
```

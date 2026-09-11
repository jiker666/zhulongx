# XH-202609 测试报告

| 项目 | 内容 |
| --- | --- |
| 文档编号 | XH-202609-03 |
| 版本 | 1.0 |
| 测试代码基线 | `99ab7d5`（`main`），及本次已实测的 Podman/ARM64 工具链修订 |
| 测试日期 | 2026-08-31（Asia/Shanghai） |
| 后端运行时 | Node.js `v26.3.0` |
| 测试结论 | 当前代码通过静态、确定性回归、前后端生产构建、Compose 解析，以及 Podman ARM64 构建、启动、健康和浏览器冒烟验收 |

## 1. 测试目的与边界

本报告验证本次可交付代码的工程正确性和安全边界，重点覆盖类型、代码规范、策略控制、预算、审计、恢复、运行摘要、前端构建和部署配置。测试使用确定性 faux-CLI（脚本化模型），不发起真实模型请求，不接触真实比赛平台或未授权目标。

本报告**不**以单次演示替代泛化能力评测，不报告未经固定数据集和环境清单支持的成功率，也不将 Compose 配置解析表述为容器镜像构建或 Docker 运行验收。真实模型、真实平台和长期泛化实验应按 [评测协议](../evaluation.md) 在明确授权的 opt-in suite 中单独执行。

## 2. 测试环境

| 维度 | 实际配置 |
| --- | --- |
| 操作系统与时区 | 本地开发环境；Asia/Shanghai |
| Node.js | `v26.3.0`，满足项目要求 `>=22.19.0` |
| 后端构建 | TypeScript ESM，执行仓库 `npm run build` |
| 前端构建 | `frontend/`，React/Vite 生产构建 |
| 测试框架 | Vitest、TypeScript、ESLint |
| 模型依赖 | 确定性 faux-CLI 脚本化模型；无真实模型调用 |
| 容器验证 | 已连接的 rootless Podman machine（ARM64）；以 `podman compose` 调用已配置的外部 Compose provider，未使用 Docker daemon |
| 容器端到端 | core sandbox 与 Web 合并镜像实际构建；以 `XUANSHU_PORT=17318` 启动，`/health`、服务日志、sandbox socket 和浏览器页面均已验证 |

## 3. 验收标准

1. `npm run check` 全部通过。该命令是仓库合并门禁。
2. 所有模型可触发的主动网络能力均需经过 `PolicyEngine` 和 operator-owned scope；per-run scope 不得扩权。
3. 工具必须返回有界结果；可能阻塞的工作可由 `AbortSignal` 取消。
4. 新工具须具备策略、预算、审计与副作用文档测试。
5. 审计、状态、交接和前端投影不记录模型密钥、Authorization、Cookie 或隐藏推理。
6. 前端生产构建和 Compose 配置解析必须成功；交付机容器构建与运行实测另行记录。

## 4. 已执行测试与结果

| 编号 | 测试项 | 命令或方式 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| T-01 | 代码差异检查 | `git diff --check` | 通过 | 无空白或补丁格式问题 |
| T-02 | 类型、规范、确定性测试、后端构建 | `npm run check` | 通过 | 61 个测试文件通过，1 个跳过；387 个用例通过，1 个跳过 |
| T-03 | 前端生产构建 | `npm --prefix frontend run build` | 通过 | TypeScript 检查与 Vite 构建成功 |
| T-04 | Compose 语法与变量解析 | `XUANSHU_SERVER_TOKEN=validation-only docker-compose config`；`XUANSHU_SERVER_TOKEN=validation-only podman compose config` | 通过 | 服务、卷、健康检查和 sandbox 网络配置可解析；rootless Podman machine 已连接，`podman compose` 使用配置的 Compose provider 完成解析 |
| T-05 | 历史运行列表冒烟 | 实际历史运行列表读取 | 通过 | 320 条有效历史运行，`pending=0`，`/v1/runs` 约 79 ms |
| T-06 | Podman ARM64 镜像构建与启动 | `XUANSHU_PORT=17318 XUANSHU_SERVER_TOKEN=validation-only ./start.command` | 通过 | `zhulong-xuanshu-ctf-sandbox` 与 `zhulong-xuanshu-xuanshu` 两张生产镜像均构建完成；sandbox 镜像包含经实际核验的 core 工具链 |
| T-07 | 容器健康与隔离服务 | `curl --fail http://127.0.0.1:17318/health`；`podman compose ps`；`podman compose logs` | 通过 | API 返回 `status=ok`；Web 服务与 `ctf-sandbox` 均处于运行状态，sandbox socket 正常监听；端口 `17318` 用于避让本机已有的开发服务 `7318` |
| T-08 | 容器化前端冒烟 | 实际浏览器访问 `http://127.0.0.1:17318/`，连接临时服务令牌 | 通过 | 页面标题、控制台总览、策略状态和导航均正常；桌面与 `390x844` 移动视口无可见重叠/截断，浏览器控制台无 error |

测试命令使用 `--no-file-parallelism` 顺序执行测试文件。sandbox 相关测试包含受控健康探针；串行执行降低并发启动抖动导致的假超时，同时测试逻辑仍以确定性输入和有界断言验证行为。

## 5. 测试覆盖矩阵

| 测试主题 | 覆盖内容 | 主要风险 | 结果 |
| --- | --- | --- | --- |
| 策略与 scope | 主机、端口、路径、程序、模式、预算、重复动作和收窄 override | 模型扩权、越界执行 | 通过 |
| 运行时状态机 | 计划、checkpoint、完成/阻塞、取消和资源计数 | 非法状态流转、无法收敛 | 通过 |
| 审计与隐私 | 请求-策略-结果关联、哈希链、脱敏、公开上下文投影 | 行为不可追溯、凭据泄露 | 通过 |
| 恢复与 no-replay | 遗留状态结算、恢复事件续链、不重放副作用 | 重启重复执行工具 | 通过 |
| 提交与 WP | 结构化 submission、独立验证、终态生成及格式校验 | 从文本猜 Flag、伪造 WP | 通过 |
| 附件与材料工具 | ZIP 条目/大小限制、路径穿越与链接拒绝、字节搜索上限 | 恶意附件、过量输出 | 通过 |
| Sandbox 工具链 | 固定版本、能力清单、allowlist 和 health 契约 | 未声明程序、不可复现依赖 | 通过 |
| 前端事实投影 | 决策事件合并、策略状态、证据关系、实时去重 | UI 编造状态、重复事件 | 通过 |
| 运行摘要索引 | 摘要优先、旧状态后台回填、详情读取完整状态 | 大量运行导致列表阻塞 | 通过 |
| 前端构建 | React/Vite 生产打包 | 控制台不可交付 | 通过 |
| Compose 与容器 | 回环端口、named volume、服务健康、sandbox 无网络、ARM64 工具链和启动脚本 | 一键部署配置或运行时工具链错误 | 通过（配置解析与实际 Podman 运行） |
| 浏览器控制台 | 服务令牌连接、总览加载、导航可见性、桌面与移动端布局、控制台错误 | 合并前端无法实际使用 | 通过 |

## 6. 关键验证说明

### 6.1 安全与作用域

策略测试验证了 scope 对主机、端口、路径和程序的限制，以及预算、重复动作和 checkpoint 的拦截行为。网络能力不能借由 sandbox、Connector 或单次 override 扩大到 operator 未授予的范围。受控命令由 sidecar 接收程序与参数，而不是 Shell 字符串。

### 6.2 可审计性与恢复

测试覆盖运行事件的顺序、关联、投影和恢复路径。历史恢复为 no-replay：服务启动后只记录并结算不完整运行，而不自动重新执行副作用未知的调用。人工复核作为独立记录存在，不改写原始审计链。

### 6.3 结论、Flag 和 WP

严格提交策略要求候选值出现在成功工具结果中，且由独立验证文本明确引用；不满足时任务不会伪造完成。WP 仅允许终态运行生成，并校验结构、精确 submission、完整脚本代码块、最大长度和重复答案行。生成器的输入已排除隐藏推理和敏感凭据。

### 6.4 历史运行性能

`summary.json` 将运行列表所需字段从完整状态中投影出来，解决大量历史产物需逐个读取 `state.json` 的问题。测试与本次实际运行列表复测验证：已有 320 条有效历史记录时，所有摘要均已就绪，`/v1/runs` 约 79 ms 返回；打开详情时仍从完整状态和审计轨迹加载事实。

## 7. 未执行项与限制

| 项目 | 状态 | 原因与后续要求 |
| --- | --- | --- |
| 真实模型端到端评测 | 未纳入默认测试 | 需要私有模型配置、授权和评测 manifest，不能使用公开仓库密钥 |
| 真实比赛平台验证 | 未纳入默认测试 | 需在主办方授权范围内由操作员执行，保存脱敏证据 |
| 成功率/排名结论 | 不适用 | 当前不存在固定隐藏集、重复次数和环境账本支持的统计结果 |

## 8. 交付机复测清单

```bash
git diff --check
npm run check
npm --prefix frontend run build
XUANSHU_SERVER_TOKEN=validation-only docker-compose config
XUANSHU_SERVER_TOKEN=validation-only podman compose config

# 有可连接的 Podman 或 Docker 容器引擎时
XUANSHU_PORT=17318 XUANSHU_SERVER_TOKEN="<现场随机令牌>" ./start.command
curl --fail http://127.0.0.1:17318/health
XUANSHU_PORT=17318 XUANSHU_SERVER_TOKEN="<现场随机令牌>" podman compose ps
podman compose down
```

若默认端口 `7318` 已被本地开发服务占用，应像本次实测一样指定空闲的回环端口（例如 `17318`），不得停止未知的本地进程。复测记录应另存为脱敏附件，至少固定 commit SHA、依赖 lockfile、Node、Podman 或 Docker 版本、Compose provider、容器镜像摘要、测试人员、授权范围和结果。不得记录模型 Key、服务令牌、Cookie、Authorization、未公开题目材料或真实 Flag。

## 9. 验收结论

静态检查、确定性回归、前后端构建、Compose 配置解析、历史运行列表冒烟，以及 Podman ARM64 的镜像构建、容器启动、健康接口和浏览器冒烟均通过，当前版本满足合并门禁和文档化安全边界。真实模型和真实比赛平台验证仍须在授权环境中按第 8 节完成并以脱敏记录归档。

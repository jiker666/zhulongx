# v0.2.2 能力补强说明

本版本只做本地能力补强与确定性回归，不调用任何外部评测平台，也不产生新的实战准确率结论。

## 模型语义

- 默认示例使用公开的 OpenAI Responses-compatible 配置，也可由 operator 替换为其他兼容服务。
- Agent 不根据路由名称假设供应商专属能力。
- Responses 请求使用 `store: false`，并保留显式推理等级映射。

## 确定性分析能力

- 新增 `inspect_artifact`：在单次有界动作中报告文件大小、魔数、熵、可打印比例、哈希覆盖和字符串证据。
- 新增 `observe_image`：读取单个有界 JPEG/PNG/GIF/WebP 并把实际像素交给模型；工具只读、无网络、无写入，接受 `AbortSignal`，受 `maxImageBytes` 与 `maxImageObservations` 限制，并仅记录不含像素的 `image.observed` 审计事件。
- 最多读取前 8 MiB；完整读取时报告完整 SHA-256，超限时只报告 inspected-prefix SHA-256 并明确 `hashComplete=false`。
- HTTP 观察增加响应体 SHA-256、字节数和耗时，便于比较基线与变体。

## Crypto/Misc 离线工具链

- 修复 `fpylll` 缺少 `cysignals` 导致无法导入的问题，并增加最小 LLL 构建检查。
- 补齐题库公开依赖中的 `mmh3`、`ortools`、`pickora`、`tqdm`；运行时不再尝试联网安装包。
- Crypto 增加 `gp`、`z3`、`factor`、`bc`，继续保留 `ecm`、hashcat、John 和 Python 数学/密码库。
- Misc 增加 `ffprobe`、ImageMagick、SoX、minimodem、multimon-ng、Tesseract、pngcheck、gifsicle、steghide、outguess、stegsnow 与 Pickora。
- 所有新增命令都是离线 sandbox programs，只能通过 `run_command` 使用；它们继承策略白名单、工具调用与重复动作预算、checkpoint、命令超时、AbortSignal、输出上限和统一审计事件。写入副作用仅允许落在 run 级 scratch 命名空间。
- sidecar 会在客户端取消时终止仍在运行的子进程，防止已取消的题目继续占用计算资源或延迟写入文件。

## 自主纠错能力

- 计划中的初始假设进入持久化 hypothesis ledger。
- checkpoint 可以把假设标记为 open、supported、contradicted 或 confirmed，并附证据。
- 工具失败或策略拒绝后，Agent 在继续任何动作前必须完成策略修订 checkpoint。
- 恢复 checkpoint 必须包含失败分类、至少一项计划变化以及下一动作依据；无变化的原样重试会被拒绝。

## 沙箱能力协商

- 每次运行前读取 sandbox health。
- 只向模型暴露“配置允许且 sidecar 实际可用”的程序交集。
- 不可用程序进入审计与系统能力摘要，避免模型在缺失工具上消耗回合。
- 本地 sidecar 运行在只含自身的 Docker internal 网络中，无外网路由；控制端口只映射到宿主 `127.0.0.1`。
- 本机 Agent 配置不向命令沙箱暴露 curl；远程访问继续统一经过 scope 管控的 HTTP/TCP 工具。
- 批量任务启用 `attachments-only` 工作区，避免共享目录中的旧附件污染当前任务；最终收尾预留 `finalizationReserveMs`，防止调查动作耗尽全部运行时间。
- 操作台停止按钮通过 `AbortSignal` 终止当前运行和尚未开始的任务；每项任务仍遵守轮次、工具、时间和网络预算。
- 本地任务集、分类和实例适配由 operator 私有配置提供；公共默认配置不携带数据集路径、题目元数据或平台行为。

## 可视化审计

- hypothesis update 与 strategy revision 作为独立哈希链事件展示。
- 审计台增加假设数和策略修订次数统计。
- 页面显示的是可复核的外显决策、证据和策略变化，不展示模型隐藏思维链。

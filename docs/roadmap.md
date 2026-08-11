# 研发路线图

## v0.1 已完成

- Pi 自主工具循环与显式任务状态机。
- 输入归一化、范围策略、预算、停滞检测、证据发现和哈希链审计。
- OpenAI Chat Completions 兼容模型、CLI、REST API、Docker 和确定性测试。

## v0.2 CTF sandbox 能力层

- Unix socket `ctf-sandbox` sidecar，API/model 进程不直接执行 CTF 命令。
- 只读 challenge input、可写 scratchRoot、结构化命令、输出/超时/scratch/TCP 预算。
- Core CTF profile：web、pwn、crypto、reverse、forensics、malware、misc、OSINT、轻量 AI/ML 常用工具。
- 可选 heavy profile：固定版本的 angr、qiling、frida、torch、transformers、SageMath、RsaCtfTool、CADO-NFS、flatter、radare2、stegseek；Ghidra 和 GPU hashcat 调优保持人工确认。
- 受 scope 管控的扩展 HTTP 方法和 stateful TCP 会话，支持 remote pwn/custom protocol。
- v0.2.1：逐运行 scratch/HOME 命名空间、决策审计台、人工逐步纠错、平台验真经验库与按类别检索注入。
- v0.2.2：运行前 sandbox 能力协商、结构化 artifact 初筛、持久化假设台账、失败分类与强制策略修订轨迹，以及同题竞速的有界共享证据板。

## v0.3 受控网站接入

- 基于 Playwright 的浏览器插件，复用登录会话并记录 DOM/截图证据。
- DNS 解析锁定、出口代理、每目标速率限制和精确 URL 路径范围。
- OpenAPI/HAR 接口建模、请求去重、响应差异比较和敏感字段自动脱敏。
- 主办方测试站点到位后建立 development/validation/hidden 三分评测集。

## v0.4 多场景工具包

- MCP 工具适配层，以及 Web、应急响应、逆向、取证四类可独立安装的插件包。
- 只读容器、临时工作副本、CPU/内存/进程限制和网络命名空间。
- 证据图谱、跨工具实体关联、可恢复会话与上下文压缩。

## v0.5 决赛工程化

- 国内备案模型网关适配、模型降级与重试策略、离线模型目录。
- 三人协同控制台、运行队列、实时审计、人工接管与紧急停止。
- 固定镜像的一键部署、SBOM、签名构建、全量测试文档和演示材料。

任何新增实战能力都先在明确授权、低频、可回滚的环境验证，再进入默认工具集。

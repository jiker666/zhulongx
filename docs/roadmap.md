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

## v0.2.3 持久 Agent Runtime 已完成

- 持久运行恢复、审计链续写、统一 Executor、有序 runtime event、SSE 缺口回放和时间线/模型上下文双投影。
- 参数级权限门、Profile 行为/能力绑定、外部/MCP 工具适配、Provider 错误分类和有界上下文压缩。
- 可寻址 Agent、Task、Result、Mailbox、预算、租约/generation、确认和有界 worker；joined/background await 与 cancel policy 分离。
- 静态及 controller 扩展 Workflow DAG；依赖条件、effect 调度、workspace 写租约、网络/Token/成本/时间预算和副作用 no-replay。
- 来源化 user/project Memory、Knowledge Store、策略受控 Deep Research、反向 Connector、可复现实验账本、步骤级 Model Router 和 HeavyThink 预算协调器。
- DeepSeek Harness 风格的单一追加轨迹：事件来源/执行者/关联 ID、脱敏模型上下文快照、工具调用因果配对、按来源检索、滑杆回放、父子运行血缘，以及从任意序号 fork/从结尾 resume。
- 面向网安初学者的行动解释层：把技术事件翻译为“做什么、为什么、影响、结果、下一步”，同时保留原始事件、哈希链、证据图和人工复核入口。
- Core CTF 镜像补充 GAP、patchelf、scalpel 及 smoke test；许可证或调用契约不完整的研究工具保留为 operator-managed 清单，不宣称默认能力。

## v0.3 受控网站接入

- 已完成基础 Playwright 逐运行浏览器上下文、DOM/网络摘要、导航 scope 和交互预算；持久登录会话与截图证据仍待补全。
- DNS 解析锁定、出口代理、每目标速率限制和精确 URL 路径范围。
- OpenAPI/HAR 接口建模、请求去重、响应差异比较和敏感字段自动脱敏。
- 主办方测试站点到位后建立 development/validation/hidden 三分评测集。

## v0.4 多场景工具包

- 已完成 MCP/外部工具适配层；后续提供 Web、应急响应、逆向、取证四类可独立安装的插件包。
- 只读容器、临时工作副本、CPU/内存/进程限制和网络命名空间。
- 已完成证据图谱、跨工具实体关联、可恢复会话与上下文压缩；后续补齐租户级持久数据库和跨实例事件总线。

## v0.5 决赛工程化

- 国内备案模型网关适配、模型降级与重试策略、离线模型目录。
- 三人协同控制台、运行队列、实时审计、人工接管与紧急停止。
- 固定镜像的一键部署、SBOM、签名构建、全量测试文档和演示材料。

任何新增实战能力都先在明确授权、低频、可回滚的环境验证，再进入默认工具集。

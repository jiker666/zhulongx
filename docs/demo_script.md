# 烛龙·玄枢 ZHULONG-X — 5 分钟演示脚本

> 面向挑战杯评委的现场演示流程。总时长 5 分钟。

---

## 准备（演示前 2 分钟）

```bash
# 终端 1：启动后端（mock 模式，无需 LLM key）
cd cyberpilot/backend
LLM_ENABLED=false APP_ENV=dev \
  python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 终端 2：启动前端
cd cyberpilot/frontend
npm install && npm run dev
```

打开浏览器：`http://localhost:5173`

---

## 0:00 - 0:30 介绍系统

**画外**：
> "这是「烛龙·玄枢 ZHULONG-X」——面向 CTF 实战的自主决策通用安全智能体。
> 它不是工具平台，而是能自动理解题目、生成解题脚本、运行修复、提取 flag、生成中文 WP 的完整闭环。
> 口号：烛照隐微，枢决攻防。"

**屏幕操作**：停留在作战大屏 `/`，指着四个指标卡：
- 已解题数
- 自动解题成功率
- 工具调用总数
- LLM 状态（Mock / Live）

---

## 0:30 - 1:30 创建题目并上传附件

**屏幕操作**：点击左侧导航 `CTF 作战` → 进入 `/ctf`

**画外**：
> "我们内置了 11 个 demo 题，覆盖 crypto / misc / reverse / forensics / web 五大题型。
> 点击任意一个 demo 的『运行』按钮，Agent 会自动开始解题。"

**演示选项**：
- 简单题：点 `crypto_xor`（XOR + base64）
- 中等题：点 `crypto_base_chain`（4 层编码链）
- 取证题：点 `forensics_pcap_http`（pcap 流量分析）

---

## 1:30 - 3:30 Agent 自动解题

**屏幕操作**：点击 `crypto_base_chain` 的『运行』按钮

**画外**：
> "Agent 启动后，会经过完整的状态机：
> INIT → CLASSIFY → PLAN → ANALYZE_FILES → GENERATE_SCRIPT → RUN_SCRIPT → VERIFY_FLAG → GENERATE_WRITEUP → DONE"

**等待 3-5 秒**，期间可以看到：
- demo 卡片显示 `RUNNING...` 状态
- 完成后变绿色，显示 flag

**点击『详情』**进入单题作战页 `/ctf/{taskId}`，展示：

1. **左侧 - 任务信息 + 解题计划**
   - 题型：crypto
   - 置信度：70%
   - 执行计划：4 步
   - 风险：附件可能包含混淆

2. **中间 - Agent 推理时间线**
   - 每一步 evidence：时间戳 + 步骤名 + 成功/失败标记
   - 当前 solve.py 脚本（完整 Python 代码）

3. **右侧 - 候选 flag + 脚本执行记录**
   - 候选 flag：`flag{multi_layer_encoding_chain}` + 置信度
   - Run #1：exit_code=0，stdout 包含 flag

**画外**：
> "每一步都有证据留痕，可审计。
> Agent 不只是调用工具，它会反思修复——如果脚本失败，会读 stderr 自动修复重试。"

---

## 3:30 - 4:30 展示 flag、证据链、WP

**屏幕操作**：

1. **flag 校验**：指着右侧候选 flag 卡片
   > "Agent 从 stdout 中提取出 `flag{multi_layer_encoding_chain}`，
   > 置信度 0.95，自动选为 best_flag。"

2. **证据链**：指着中间时间线
   > "完整 8 步证据链：init → classify → plan → analyze_files → generate_script → run_script → verify_flag → generate_writeup。
   > 每一步都有时间戳、输入输出摘要、成功状态。"

3. **导出 WP**：点击右上角『导出 WP』按钮
   > "基于真实 evidence 自动生成的中文 WP，包含题目信息、解题思路、完整脚本、执行记录、flag 获取过程、坑点总结。
  > 不编造——所有内容来自执行日志。"

**WP Modal 展示**：
- 题目信息表格
- 解题思路（plan + risks）
- 完整 solve.py 代码块
- 脚本执行 stdout/stderr
- flag 候选表
- 证据链表
- 坑点总结

---

## 4:30 - 5:00 展示 benchmark 和创新点

**屏幕操作**：点击左侧导航 `能力评测` → 进入 `/benchmark`

**画外**：
> "能力评测页展示实测数据：
> - 11 个 demo 题
> - 10/11 自动通过（mock 模式）
> - 平均耗时 0.2 秒
> - 按题型分布的成功率"

**指着底部安全声明**：
> "所有能力仅用于授权 CTF / 靶场 / 教学。
> 默认禁止公网，allow_network 必须配合 authorized=true 才放行。
> 沙箱限制 CPU 30s / 内存 1GB / 危险命令黑名单。"

**总结**：
> "烛龙·玄枢 的核心创新：
> 1. 状态机驱动 + 反思修复（不是简单工具调用）
> 2. 完整证据链 + 中文 WP（可审计、不编造）
> 3. 四重安全边界（ScopeGuard + Sandbox + 黑名单 + authorized）
> 4. Mock 模式开箱即用 + 真实 LLM 可选
> 5. 11 个 demo 覆盖 5 大题型，10/11 自动通过"

---

## 备选：接入真实 LLM 演示

如果评委要求看真实 LLM 模式：

```bash
# 1. 配置 .env
cp .env.example .env
# 编辑 .env：
#   LLM_ENABLED=true
#   LLM_API_KEY=sk-your-real-key
#   LLM_MODEL=deepseek-coder  # 或其他

# 2. 验证 LLM 配置
make llm-check

# 3. 跑真实 LLM smoke
make ctf-llm-smoke
```

**预期**：crypto_xor + reverse_py 在真实 LLM 下通过，LLM 生成针对性 solve.py（而非 mock 的通用 solver）。

---

## 应急预案

| 突发情况 | 应对 |
|---------|------|
| 后端启动失败 | `make doctor` 检查依赖 |
| 前端白屏 | F12 看 console；通常是后端未启动 |
| demo 运行超时 | 重启后端，清空 `data/ctf_runs/` |
| LLM 调用失败 | 切换回 mock 模式（`LLM_ENABLED=false`） |
| Web demo 靶场启动失败 | 检查 5001-9999 端口是否被占用 |

---

烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X

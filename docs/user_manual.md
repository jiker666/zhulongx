# 烛龙·玄枢 ZHULONG-X — 用户手册

> 面向**评委 / 用户**的 10 分钟快速上手手册。

## 1. 环境准备

### 1.1 必需

- Python 3.11+
- Node.js 18+ / npm
- macOS 或 Linux（Windows 需 WSL2）

### 1.2 一键安装依赖

```bash
cd cyberpilot
cd backend && python3 -m pip install -r requirements.txt && cd ..
cd frontend && npm install && cd ..
```

## 2. 启动系统

### 2.1 Mock 模式（无需 LLM Key）

打开两个终端：

**终端 1（后端）：**
```bash
cd backend
LLM_ENABLED=false APP_ENV=dev \
  python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

**终端 2（前端）：**
```bash
cd frontend
npm run dev
```

按提示打开浏览器（默认 <http://localhost:5173>）。

### 2.2 真实 LLM 模式（可选）

```bash
cp .env.example .env
# 编辑 .env，填入你的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
# 把 LLM_ENABLED 改为 true
```

支持 OpenAI / DeepSeek / Qwen / GLM / Moonshot / OneAPI / Ollama。

## 3. 使用流程

### 3.1 体验内置 demo（最快）

1. 打开浏览器，进入 **CTF 作战** 页（左侧导航 `CTF 作战`）
2. 在 "内置 Demo 题集" 中点击任意一个 **运行** 按钮
3. 等待 5-15 秒，看到绿色 ✅ 即解题成功
4. 点击 **详情** 进入单题作战页查看完整推理链路
5. 点击 **导出 WP** 查看中文报告

### 3.2 创建自定义 CTF 任务

1. 通过 API（或前端后续版本）创建任务：

```bash
curl -X POST http://localhost:8000/api/ctf/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "我的题目",
    "description": "题面描述",
    "category": "auto",
    "flag_format": null,
    "authorized": true,
    "allow_network": false,
    "max_rounds": 8
  }'
```

2. 上传附件：

```bash
curl -X POST http://localhost:8000/api/ctf/tasks/{task_id}/attachments \
  -F 'file=@./your_attachment.zip'
```

3. 启动解题：

```bash
curl -X POST http://localhost:8000/api/ctf/tasks/{task_id}/solve \
  -H 'Content-Type: application/json' \
  -d '{"mode": "auto", "max_rounds": 8}'
```

4. 查看状态 / 事件流 / WP：

```bash
curl http://localhost:8000/api/ctf/tasks/{task_id}
curl http://localhost:8000/api/ctf/tasks/{task_id}/events
curl http://localhost:8000/api/ctf/tasks/{task_id}/writeup
```

### 3.3 人工接管

当 Agent 状态为 `HUMAN_REQUIRED`（黄色）时，表示已用尽 `max_rounds` 仍未确定 flag。

此时可以：
- 在单题作战页查看完整的 evidence + script_runs，判断 Agent 哪一步出错
- 修改附件或题面后重新运行
- 直接看 stdout / stderr 中的候选 flag，人工确认

## 4. 页面导览

### 4.1 作战大屏 `/`

- **顶部**：烛龙·玄枢 Logo + 口号 + 版本徽章
- **指标卡**：已解题数 / 成功率 / 工具调用数 / LLM 状态
- **左**：当前任务列表（点击进入单题作战页）
- **中**：实时推理流（最近 8 条 evidence）
- **右**：候选 flag 列表
- **底部**：题型分布 + 安全声明

### 4.2 CTF 作战 `/ctf`

- **Demo 题集**：5 个内置 demo，一键运行
- **历史任务**：所有 CTF 任务列表

### 4.3 单题作战页 `/ctf/:taskId`

**三栏布局**：

- **左侧**：任务信息 + 解题计划 + 附件
- **中间**：Agent 推理时间线（每一步 evidence） + 当前 solve.py
- **右侧**：候选 flag + 脚本执行记录 + 错误信息

**底部**：自动每 3 秒刷新（任务运行中）

### 4.4 能力评测 `/benchmark`

- 4 个核心指标卡
- 按题型分布的进度条
- 任务详情表格

## 5. 常见问题

### Q1：Mock 模式下能解哪些题？

Mock 模式内置启发式规则，能处理：
- 简单 XOR / Caesar / base64 编码（crypto_xor）
- 文本中嵌入的 flag（misc_exif / forensics_log）
- Python 脚本里硬编码的 base64 字符串（reverse_py）

无法处理：复杂算法、动态调试、需要交互的 pwn 题。

### Q2：如何切换到真实 LLM？

编辑 `.env`，把 `LLM_ENABLED` 改为 `true`，配置 `LLM_API_KEY`。重启后端即可。

### Q3：为什么我的任务卡在 HUMAN_REQUIRED？

可能原因：
1. 附件里没有可识别的 flag 模式
2. 题目需要复杂交互（pwn 类）
3. Mock LLM 启发式无法处理（建议接入真实 LLM）
4. 达到 `max_rounds` 上限（可在创建任务时调大，最大 16）

### Q4：可以攻击真实目标吗？

**不可以**。默认 `allow_network=false`；即便显式传 `allow_network=true`，也必须同时 `authorized=true` 才会放行。所有 HTTP 工具调用前都要经过 `scope_guard.check()`。

### Q5：API Key 会不会泄露？

不会。Key 在日志中被 `mask_secret` 脱敏（保留首 4 尾 4），不会出现在 WP / 前端 / 报告中。`.env` 已加入 `.gitignore`。

### Q6：如何看完整推理过程？

进入单题作战页，**Agent 推理时间线** 展示了每一步：
- 时间戳
- 步骤名（INIT/CLASSIFY/PLAN/...）
- 成功/失败标记
- 输入摘要

点击 **导出 WP** 可以看到完整 Markdown 报告。

## 6. 评测与验收

```bash
# 后端测试
cd backend && python3 -m pytest -q

# CTF smoke（4 个 demo 端到端）
make ctf-smoke

# 前端构建
cd frontend && npm run build
```

预期：`94 passed` + `4/4 demo passed` + 前端 `built in 1.4s`。

## 7. 进阶用法

### 7.1 调整沙箱限制

编辑 `backend/app/config.py`：

```python
CTF_SANDBOX_TIMEOUT: int = 15        # 单脚本超时秒数
CTF_SANDBOX_MAX_OUTPUT: int = 20000  # 输出截断字符数
CTF_MAX_ROUNDS: int = 8               # 最大推理轮次
```

### 7.2 添加自定义 demo

在 `examples/ctf_demo/` 下新建目录，包含：

```
my_demo/
├── challenge.json     # 元数据
├── attachment/        # 附件
│   └── data.bin
├── expected_flag.txt   # 期望 flag（用于 benchmark）
└── README.md           # 解题思路
```

`challenge.json` 格式：

```json
{
  "title": "My Demo",
  "category": "crypto",
  "difficulty": "easy",
  "description": "题面",
  "flag_format": "flag\\{[^}]+\\}",
  "hint": "提示"
}
```

重启后端，即可在 `/api/ctf/demos` 中看到。

### 7.3 接入 WebSocket 实时推送

当前 `/events` 是同步轮询；要支持 SSE/WebSocket 推送，可参考已有的 `app/api/ws.py` 与 `app/core/ws_manager.py`（用于普通任务的实时日志）。

## 8. 联系与反馈

如发现 bug 或有改进建议，请在内部 issue 系统提交。

烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X

# 烛龙·玄枢 ZHULONG-X

> **烛照隐微，枢决攻防。**
>
> 面向网络安全实战的**自主决策通用安全智能体**。

[![Python](https://img.shields.io/badge/Python-3.11+-blue)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.111-green)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18-blue)](https://react.dev)
[![License](https://img.shields.io/badge/Use-Authorized%20Only-yellow)](#十安全边界)

> ⚠️ 本平台仅用于授权 CTF / 靶场 / 教学 / 合法安全测试。严禁用于非法用途。

---

## 1. 项目简介

「烛龙·玄枢」是一个**人机协同**的自主决策通用安全智能体，面向 CTF 实战解题场景。它能：

- 自动理解 CTF 题目（题面 + 附件）
- 识别题型（web / crypto / reverse / pwn / misc / forensics）
- 生成解题计划与执行步骤
- 静态分析附件（strings / binwalk / exif / ELF...）
- 生成 `solve.py` / `exp.py` / `analysis.py`
- 在隔离沙箱中运行脚本
- 读取 stdout / stderr，**自动反思修复错误**
- 提取并校验候选 flag
- 生成中文 WP（基于真实证据链，不编造）
- 在前端实时展示推理链路、执行证据、候选 flag

### 与"工具平台 / Demo 作战台"的区别

| 维度 | 工具平台 | 烛龙·玄枢 |
|------|---------|----------|
| 决策 | 用户驱动 | LLM 自主状态机 |
| 反思 | 无 | 失败自动修复 + 重试 |
| 证据 | 单次结果 | 完整 evidence chain |
| 输出 | 工具调用记录 | 中文 WP + 候选 flag + 证据链 |
| 安全 | 单点限制 | ScopeGuard + Sandbox + 危险命令黑名单 |

---

## Cost-aware Multi-Agent Solve Loop

ZHULONG-X v6 引入低成本多角色解题闭环：

- **Manager**：保留原有 Orchestrator 状态机，负责全局推进。
- **Blackboard**：沉淀 Fact / Intent / Hint，避免上下文污染。
- **Observer**：旁路监督循环、跑偏、提前终止和预算浪费。
- **ModelRouter**：先静态分析，再便宜模型，最后才升级 GLM-5.2。
- **CostAccounting**：记录每题 token 与成本，支持挑战杯答辩展示。
- **FailureAttributor**：失败归因 L1-L4，L4 信息不足直接转人工，不浪费 token。

默认 mock 模式无需 API key；接入国内 API 后，可使用 DeepSeek / Qwen / GLM / OneAPI 等 OpenAI-compatible 服务。

### v6 新增 API

| 接口 | 用途 |
|------|------|
| `GET /api/ctf/tasks/{task_id}/blackboard` | 获取事实黑板 / 意图 / 提示 |
| `POST /api/ctf/tasks/{task_id}/hints` | 添加人工 / Observer 提示 |
| `PATCH /api/ctf/tasks/{task_id}/intents/{intent_id}` | 更新意图状态 |
| `GET /api/ctf/tasks/{task_id}/cost` | 获取 LLM 调用成本汇总 |
| `GET /api/ctf/tasks/{task_id}/cost/records` | 获取调用明细（脱敏） |
| `GET /api/ctf/llm/router/status` | 获取模型路由状态（脱敏） |

### v6 新增模块

| 模块 | 职责 |
|------|------|
| `backend/app/core/context_compressor.py` | 压缩工具输出 / evidence / 文件分析 |
| `backend/app/core/cost_accounting.py` | LLM 调用成本核算 + prompt 缓存 |
| `backend/app/core/model_router.py` | 模型路由 STATIC_ONLY / CHEAP / EXPERT / STOP |
| `backend/app/core/blackboard.py` | Fact / Intent / Hint 三元组黑板 |
| `backend/app/core/observer.py` | 旁路监督循环 / drift / 预算 |
| `backend/app/core/failure_attributor.py` | 失败归因 L1-L4 |
| `backend/app/skills/` | 题型 Skill 提示词（ctf/web/crypto/reverse/misc/forensics/cost_control） |

### 模型路由配置

在 `.env` 中配置 cheap / expert / fallback 三条 lane：

```dotenv
LLM_ROUTER_ENABLED=true
LLM_BUDGET_PER_TASK_USD=0.05
LLM_BUDGET_DAILY_USD=1.00

# Cheap: 日常分类/计划/短修复
LLM_CHEAP_PROVIDER=deepseek
LLM_CHEAP_BASE_URL=https://api.deepseek.com/v1
LLM_CHEAP_MODEL=deepseek-v4-flash
LLM_CHEAP_API_KEY=sk-your-deepseek-key

# Expert: 复杂/卡住时升级
LLM_EXPERT_PROVIDER=glm
LLM_EXPERT_BASE_URL=https://api.z.ai/api/coding/paas/v4
LLM_EXPERT_MODEL=glm-5.2
LLM_EXPERT_API_KEY=sk-your-glm-key
```

升级 expert 的条件（满足任一）：
- 连续 3 轮无候选 flag
- 同一错误类型重复 2 次
- 附件分析摘要 > 8000 字符（长上下文）
- Observer 判断陷入循环
- 用户手动 `force_expert=true`

---

## 2. 快速启动

### 方式 A：后端单独启动

```bash
cd cyberpilot/backend
python3 -m pip install -r requirements.txt

# Mock 模式（无需任何 LLM key 即可演示）
LLM_ENABLED=false APP_ENV=dev \
  python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

打开 <http://localhost:8000/docs> 查看 API；访问 <http://localhost:8000/api/health> 检查健康。

### 方式 B：前端单独启动

```bash
cd cyberpilot/frontend
npm install
npm run dev
```

打开 Vite 提示的地址（默认 <http://localhost:5173>）。

### 方式 C：一键启动（Makefile）

```bash
cd cyberpilot
make dev          # 启动后端
make dev-frontend # 启动前端（另一个终端）
```

### 接入真实 LLM（可选）

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
LLM_ENABLED=true
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://api.deepseek.com/v1   # 或 OneAPI / 内网网关
LLM_API_KEY=sk-your-real-key
LLM_MODEL=deepseek-coder
LLM_TEMPERATURE=0.2
LLM_MAX_TOKENS=4096
```

支持任何 OpenAI-compatible 网关：OpenAI / DeepSeek / Qwen / GLM / Moonshot / Kimi / OneAPI / Ollama `/v1`。`provider` 会根据模型名自动识别兼容模式。

### 2.4 一键启动（容器）

```bash
make podman-up    # 或 make docker-up
make logs
```

---

## 3. CTF 自动解题流程

### 3.1 内置 Demo 题（开箱即用）

```bash
# 运行所有 demo 的端到端 smoke 测试
make ctf-smoke

# 运行全部 11 个 demo（mock 模式）
make ctf-demo-all

# 或运行单个 demo
make ctf-run-demo DEMO=crypto_xor
```

内置 11 个本地 demo（详见 `examples/ctf_demo/`），覆盖 5 大题型：

| Demo | 题型 | 难度 | Mock LLM 通过 |
|------|------|------|--------------|
| `crypto_xor` | crypto | easy | ✅ |
| `crypto_xor_repeating` | crypto | medium | ✅ |
| `crypto_rsa_small_e` | crypto | medium | ❌（需真实 LLM） |
| `crypto_base_chain` | crypto | medium | ✅ |
| `misc_exif` | misc | easy | ✅ |
| `misc_png_chunks` | misc | medium | ✅ |
| `forensics_log` | forensics | easy | ✅ |
| `forensics_pcap_http` | forensics | medium | ✅ |
| `reverse_py` | reverse | medium | ✅ |
| `reverse_py_bytecode` | reverse | medium | ✅ |
| `reverse_elf_strings_xor` | reverse | hard | ✅ |
| `web_local` | web | easy | ✅（自动启动靶场） |
| `web_local_source_leak` | web | medium | ✅（自动启动靶场） |

Mock 模式下 10/11 自动通过（`crypto_rsa_small_e` 需真实 LLM 理解整数开立方）。

### 3.2 自定义 CTF 任务

通过 API 创建：

```bash
# 1. 创建任务
curl -X POST http://localhost:8000/api/ctf/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "My Challenge",
    "description": "题面描述",
    "category": "auto",
    "flag_format": "flag\\{[^}]+\\}",
    "authorized": true,
    "allow_network": false,
    "max_rounds": 8
  }'
# → {"task_id": "ctf_xxxx", "state": "INIT"}

# 2. 上传附件
curl -X POST http://localhost:8000/api/ctf/tasks/ctf_xxxx/attachments \
  -F 'file=@./attachment.zip'

# 3. 启动解题
curl -X POST http://localhost:8000/api/ctf/tasks/ctf_xxxx/solve \
  -H 'Content-Type: application/json' \
  -d '{"mode": "auto", "max_rounds": 8}'

# 4. 查看事件流
curl http://localhost:8000/api/ctf/tasks/ctf_xxxx/events

# 5. 导出 WP
curl http://localhost:8000/api/ctf/tasks/ctf_xxxx/writeup
```

### 3.3 前端可视化

- **作战大屏**（`/`）：核心指标卡 + 实时推理流 + 候选 flag
- **CTF 作战**（`/ctf`）：demo 题集 + 历史任务
- **单题作战页**（`/ctf/:taskId`）：左侧任务信息 + 中间推理时间线 + 右侧候选 flag，底部脚本与执行记录
- **能力评测**（`/benchmark`）：成功率、题型分布、人工接管次数

---

## 4. 系统架构

详见 [`docs/architecture.md`](docs/architecture.md)。

```
┌──────────────────────────────────────────────────────────┐
│  前端（React + Vite + Tailwind + 玻璃拟态深空主题）          │
│  Dashboard / CtfHub / CtfTaskDetail / Benchmark           │
└────────────────────┬─────────────────────────────────────┘
                     │ HTTP /api/ctf/*
┌────────────────────▼─────────────────────────────────────┐
│  FastAPI 后端                                              │
│  ┌────────────────────────────────────────────────────┐  │
│  │  CTF Orchestrator (状态机)                          │  │
│  │  INIT → CLASSIFY → PLAN → ANALYZE_FILES            │  │
│  │       → GENERATE_SCRIPT → RUN_SCRIPT                │  │
│  │       → REFLECT_ERROR → VERIFY_FLAG                 │  │
│  │       → GENERATE_WRITEUP → DONE / FAILED            │  │
│  └────┬─────────────┬─────────────┬──────────────┬───┘  │
│       │             │             │              │       │
│  ┌────▼────┐ ┌─────▼─────┐ ┌─────▼─────┐ ┌──────▼────┐  │
│  │LLM      │ │File       │ │Code       │ │Flag       │  │
│  │Adapter  │ │Analyzer   │ │Sandbox    │ │Verifier   │  │
│  │(mock/   │ │(strings/  │ │(timeout/  │ │(regex/   │  │
│  │ real)   │ │ binwalk)  │ │ output/   │ │ confidence│  │
│  │         │ │           │ │ rlimit)   │ │)          │  │
│  └─────────┘ └───────────┘ └───────────┘ └───────────┘  │
│                                                           │
│  + ScopeGuard（授权范围、allow_network 强制校验）           │
│  + ToolRegistry（HTTP 指纹 / 目录探测 / JS 提取 / Java 审计）│
└──────────────────────────────────────────────────────────┘
```

---

## 5. 安全边界（关键）

详见 [`docs/architecture.md`](docs/architecture.md#5-安全边界) 与 `safety_audit_report.md`。

1. **默认禁网**：`allow_network=false` 是默认值；CTF 远程题必须 `authorized=true` + `allow_network=true` 同时满足才会放行
2. **沙箱限制**：脚本运行受 `setrlimit`（CPU 30s / 内存 1GB / 文件 100MB / 进程 32）+ Python timeout 双重约束
3. **危险命令黑名单**：`rm -rf /` / `mkfs` / `dd of=/dev/` / `sudo` / fork bomb / `curl | sh` 等会被静默拒绝
4. **API Key 安全**：Key 永不出现在日志 / 报告 / 前端；`Authorization` 头在日志中被 `mask_secret` 脱敏
5. **路径逃逸防护**：所有上传 / 解压 / 脚本写入都会检查 `realpath` 是否落在 workspace 内
6. **ScopeGuard allowlist**：HTTP 工具调用前必须通过 `scope_guard.check(target)`，默认拒绝一切公网

---

## 6. LLM 配置参考

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `LLM_ENABLED` | `false` | 是否启用真实 LLM；关闭后自动进入 mock 模式 |
| `LLM_PROVIDER` | `openai_compatible` | 自动检测；显式可填 `deepseek` / `qwen` / `glm` / `moonshot` / `oneapi` / `openai` / `codex` / `mock` |
| `LLM_BASE_URL` | `http://localhost:11434/v1` | OpenAI 兼容 endpoint |
| `LLM_API_KEY` | `replace_me` | 会被 `mask_secret` 脱敏 |
| `LLM_MODEL` | `qwen2.5-coder` | 模型名 |
| `LLM_TEMPERATURE` | `0.2` | |
| `LLM_MAX_TOKENS` | `4096` | |
| `LLM_TIMEOUT` | `60` | 单次请求超时 |
| `LLM_MAX_RETRIES` | `2` | 失败重试次数（指数退避） |

---

## 7. 验收命令

```bash
# 后端测试（198 个，含 v6 多角色闭环测试）
cd backend && python3 -m pytest -q

# 前端构建
cd frontend && npm ci && npm run build

# CTF smoke（4 个 demo 端到端 + scope_guard + 证据链 + WP）
make ctf-smoke

# 全部 11 个 demo
make ctf-demo-all

# LLM 配置检查（mock 模式会正确报告 disabled）
make llm-check

# 真实 LLM smoke（需配置 .env 中的 LLM_API_KEY）
make ctf-llm-smoke

# 安全审计
make safety-audit
```

预期输出：`198 passed` / `built in 1.6s` / `7 passed` / `10/11 demo passed`。

---

## 8. 文档导航

- [`docs/architecture.md`](docs/architecture.md) — 系统架构 / 状态机 / 沙箱机制
- [`docs/user_manual.md`](docs/user_manual.md) — 用户手册（评委可 10 分钟跑起来）
- [`docs/benchmark_report.md`](docs/benchmark_report.md) — 能力评测报告
- [`docs/challenge_cup_pitch.md`](docs/challenge_cup_pitch.md) — 挑战杯答辩口径

---

## 9. 当前限制

- Mock LLM 仅对常见 crypto/misc/forensics 模式有效；`crypto_rsa_small_e` 等复杂题需接入真实模型
- 沙箱基于 subprocess + rlimit，**非容器级隔离**；高危题目建议用 firejail / nsjail / docker
- 内存态 + DB 双写，并发可能有竞态（单线程演示无问题）
- `/solve` 异步执行中无法取消（未来增强）

### 协作流程

详见 [`docs/team_sop.md`](docs/team_sop.md)。

- `main` 稳定分支、`dev` 集成分支、`feature/*` 开发分支
- PR 必须说明修改点、测试结果、风险
- 禁止提交 `.env` / 数据库 / 运行结果 / node_modules / dist / 密钥
- `expected_flag.txt` 永不进入用户可见链路（反作弊 6 层防护）

---

## 10. License & Use

仅授权使用。详见 `LICENSE`（如缺失则视为内部研究用途）。

烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X

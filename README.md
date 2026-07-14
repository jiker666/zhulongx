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

- 自动理解 CTF 题目（题面 + 附件 + 富文本内容预览）
- 识别题型（web / crypto / reverse / pwn / misc / forensics / hard_ctf）
- 生成解题计划与执行步骤
- **自动搜索 writeup 并提取可执行攻击步骤**（CLASSIFY 后自动注入）
- 静态分析附件（strings / binwalk / exif / ELF...）
- 生成 `solve.py` / `exp.py` / `analysis.py`
- 在隔离沙箱中运行脚本
- 读取 stdout / stderr，**自动反思修复错误**
- **原生 tool_use**：通过 OpenAI function calling 协议让 LLM 直接调用 web_search / web_fetch / run_python / shell 等工具
- **循环检测**：Agent 陷入重复命令时自动搜索替代攻击路径
- 提取并校验候选 flag
- 生成中文 WP（基于真实证据链，不编造）
- 在前端实时展示推理链路、执行证据、候选 flag
- **DASCTF 批量刷题**：一键拉取靶场题目并自动解题

### 与"工具平台 / Demo 作战台"的区别

| 维度 | 工具平台 | 烛龙·玄枢 |
|------|---------|----------|
| 决策 | 用户驱动 | LLM 自主状态机 + 原生 tool_use |
| 反思 | 无 | 失败自动修复 + 重试 + 循环检测 |
| 证据 | 单次结果 | 完整 evidence chain |
| 输出 | 工具调用记录 | 中文 WP + 候选 flag + 证据链 |
| 安全 | 单点限制 | ScopeGuard + Sandbox + 危险命令黑名单 |
| 搜索 | 无 | 自动搜索 writeup + 循环时替代路径 |

---

## 核心架构演进

### v10 关键突破：OpenAI 协议 + 原生 tool_use

之前 wanqing 网关走 Anthropic 协议，API 不接受 `tools` 参数，LLM 只能靠 system prompt 输出文本模拟 JSON 工具调用，极不可靠。**根因修复**：切换到 OpenAI 协议，启用原生 function calling。

```
之前：Anthropic /messages → 无 tools 参数 → LLM 文本模拟工具调用 ❌
现在：OpenAI /chat/completions → tools 参数 → LLM 原生选择工具 ✅
```

验证结果：模型首次调用就能正确选择 `web_search` 工具。

### Cost-aware Multi-Agent Solve Loop

ZHULONG-X v6+ 引入低成本多角色解题闭环：

- **Manager**：保留原有 Orchestrator 状态机，负责全局推进。
- **Blackboard**：沉淀 Fact / Intent / Hint，避免上下文污染。
- **Observer**：旁路监督循环、跑偏、提前终止和预算浪费。
- **ModelRouter**：先静态分析，再便宜模型，最后才升级 GLM-5.2。
- **CostAccounting**：记录每题 token 与成本，支持挑战杯答辩展示。
- **FailureAttributor**：失败归因 L1-L4，L4 信息不足直接转人工，不浪费 token。

### v8 Hard Mode

```dotenv
CTF_HARD_MODE=true          # 困难题型直接升级 expert lane
CTF_MAX_ROUNDS=0            # 0=无限，仅受 max_time_sec 限制
CTF_MAX_TIME_SEC=1800      # 30 分钟
CTF_VERIFY_CONTINUE_ON_NO_FLAG=true  # 无 flag 不放弃，继续尝试
```

### 自动搜索注入

```
CLASSIFY → 自动搜索 writeup（DuckDuckGo + web_fetch）
         → LLM 提取可执行攻击步骤
         → 注入 AgentRuntime 初始上下文
```

Agent 不再依赖 LLM "选择搜索工具"——搜索在 LLM 参与前已完成。

### 循环检测 + 自动搜索

```
Agent 执行 → _detect_command_loop() 检测重复命令
           → _auto_search_on_loop() 搜索替代攻击路径
           → 注入动态上下文，打破循环
```

---

## 2. 快速启动

### 前置条件

- Python 3.11+
- Node.js 18+
- Wanqing API Key（内部网关）

### 方式 A：后端单独启动

```bash
cd backend
pip install -r requirements.txt

# 设置 API Key（推荐方式）
export WQ_API_KEY="your_wanqing_api_key"

python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

打开 <http://localhost:8000/docs> 查看 API；访问 <http://localhost:8000/api/health> 检查健康。

### 方式 B：前端单独启动

```bash
cd frontend
npm install
npm run dev
```

打开 Vite 提示的地址（默认 <http://localhost:5173>）。

### 方式 C：一键启动

```bash
# 后端
cd backend && export WQ_API_KEY="your_key" && \
  python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# 前端（另一终端）
cd frontend && npm run dev
```

### 接入 LLM

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

关键配置（`.env` 或环境变量）：

```dotenv
LLM_ENABLED=true
LLM_PROVIDER=wanqing
LLM_BASE_URL=https://wanqing-api.corp.kuaishou.com/api/gateway/v1
LLM_MODEL=ep-yba64y-1782808149582099879
LLM_MAX_TOKENS=8192
LLM_TIMEOUT=180
LLM_MAX_RETRIES=5

# 统一 API Key（覆盖所有 lane）
WQ_API_KEY=your_wanqing_key
```

**重要**：`CC_RUNTIME_ENABLED` 必须设为 `false`，否则会尝试调用外部 Claude Code 进程。

---

## 3. LLM 协议与工具调用

### 协议选择

`LLMAdapter` 根据 `base_url` 自动选择协议：

| base_url 包含 | 协议 | supports_tools |
|---------------|------|----------------|
| `wanqing` | OpenAI `/chat/completions` | ✅ |
| `anthropic` | Anthropic `/messages` | ❌ |
| 其他 | OpenAI `/chat/completions` | ✅ |

### 原生工具列表

AgentRuntime 向 LLM 暴露以下工具（OpenAI function calling 格式）：

| 工具 | 说明 |
|------|------|
| `web_search` | DuckDuckGo 搜索（优先） |
| `web_fetch` | HTTP 获取页面 + BeautifulSoup 提取正文 |
| `http_request` | 自定义 HTTP 请求（GET/POST/PUT/DELETE） |
| `run_python` | 在沙箱中执行 Python 脚本 |
| `shell` | 执行 shell 命令（受黑名单限制） |
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `list_dir` | 列出目录 |
| `flag_submit` | 提交 flag 候选 |

### 模型路由

```
静态分析找到 flag → STATIC_ONLY（不调 LLM）
普通步骤          → CHEAP lane（max_tokens=4096，节省成本）
卡住/困难题       → EXPERT lane（max_tokens=8192，全量推理）
超预算            → STOP → HUMAN_REQUIRED
```

升级 expert 条件（Hard Mode 下更激进）：
- Hard Mode: 1 次重复错误 或 2 轮无候选 flag → 直接升级
- 普通: 3 轮无候选 flag / 错误重复 2 次 / 长上下文 / Observer 循环 / 用户强制

### v6+ API

| 接口 | 用途 |
|------|------|
| `GET /api/ctf/tasks/{task_id}/blackboard` | 获取事实黑板 / 意图 / 提示 |
| `POST /api/ctf/tasks/{task_id}/hints` | 添加人工 / Observer 提示 |
| `PATCH /api/ctf/tasks/{task_id}/intents/{intent_id}` | 更新意图状态 |
| `GET /api/ctf/tasks/{task_id}/cost` | 获取 LLM 调用成本汇总 |
| `GET /api/ctf/tasks/{task_id}/cost/records` | 获取调用明细（脱敏） |
| `GET /api/ctf/llm/router/status` | 获取模型路由状态（脱敏） |

---

## 4. CTF 自动解题流程

### 4.1 内置 Demo 题（开箱即用）

```bash
# 运行所有 demo 的端到端 smoke 测试
make ctf-smoke

# 运行全部 demo（mock 模式）
make ctf-demo-all

# 或运行单个 demo
make ctf-run-demo DEMO=crypto_xor
```

内置 demo 覆盖 5 大题型，详见 `examples/ctf_demo/`。

### 4.2 自定义 CTF 任务

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
    "allow_network": true,
    "max_rounds": 0
  }'

# 2. 上传附件
curl -X POST http://localhost:8000/api/ctf/tasks/ctf_xxxx/attachments \
  -F 'file=@./attachment.zip'

# 3. 启动解题
curl -X POST http://localhost:8000/api/ctf/tasks/ctf_xxxx/solve \
  -H 'Content-Type: application/json' \
  -d '{"mode": "auto", "max_rounds": 0}'

# 4. 查看事件流
curl http://localhost:8000/api/ctf/tasks/ctf_xxxx/events

# 5. 导出 WP
curl http://localhost:8000/api/ctf/tasks/ctf_xxxx/writeup
```

### 4.3 DASCTF 批量刷题

```bash
cd backend
export WQ_API_KEY="your_key"
export DASCTF_JWT="your_jwt_token"

python3 scripts/dasctf_batch.py --help
```

脚本自动拉取 DASCTF 靶场题目，创建任务并启动解题。

### 4.4 前端可视化

- **作战大屏**（`/`）：核心指标卡 + 实时推理流 + 候选 flag
- **CTF 作战**（`/ctf`）：demo 题集 + 历史任务
- **单题作战页**（`/ctf/:taskId`）：左侧任务信息 + 中间推理时间线 + 右侧候选 flag
- **能力评测**（`/benchmark`）：成功率、题型分布、人工接管次数
- **工具中心**（`/tools`）：工具管理与状态
- **最终作战**（`/final-ops`）：终局作战面板

---

## 5. 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│  前端（React + Vite + Tailwind + 玻璃拟态深空主题）            │
│  Dashboard / CtfHub / CtfTaskDetail / Benchmark / ToolCenter │
└────────────────────┬─────────────────────────────────────────┘
                     │ HTTP /api/ctf/*    WebSocket /ws
┌────────────────────▼─────────────────────────────────────────┐
│  FastAPI 后端                                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  CTF Orchestrator (状态机)                              │  │
│  │  INIT → CLASSIFY → PLAN → ANALYZE_FILES                │  │
│  │       → GENERATE_SCRIPT → RUN_SCRIPT                   │  │
│  │       → REFLECT_ERROR → VERIFY_FLAG                     │  │
│  │       → GENERATE_WRITEUP → DONE / FAILED                │  │
│  │  + _auto_search_writeup()  (CLASSIFY 后自动搜索)       │  │
│  │  + _extract_attack_steps() (LLM 提取攻击步骤)          │  │
│  └────┬─────────────┬──────────────┬──────────────┬───────┘  │
│       │             │              │              │           │
│  ┌────▼────┐ ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼────┐    │
│  │LLM      │ │AgentRuntime │ │Code      │ │Flag       │    │
│  │Adapter  │ │(OpenAI FC)  │ │Sandbox   │ │Verifier   │    │
│  │(wanqing │ │tool_use     │ │(timeout/ │ │(regex/   │    │
│  │ OpenAI) │ │loop detect  │ │ rlimit)  │ │confidence)│    │
│  └─────────┘ └─────────────┘ └──────────┘ └──────────┘    │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  工具层                                                │  │
│  │  web_search | web_fetch | http_request | run_python    │  │
│  │  shell | read_file | write_file | list_dir | flag_submit│
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  + ScopeGuard（授权范围、allow_network 强制校验）             │
│  + ModelRouter（STATIC_ONLY / CHEAP / EXPERT / STOP）        │
│  + Blackboard / Observer / FailureAttributor / CostAccounting │
│  + Skill Prompt（web/crypto/reverse/pwn/misc/forensics/      │
│                 hard_ctf/cost_control）                       │
└──────────────────────────────────────────────────────────────┘
```

### 状态机流程

```
INIT
  │
  ▼
CLASSIFY ──── _auto_search_writeup() ──── _extract_attack_steps()
  │
  ▼
PLAN
  │
  ▼
ANALYZE_FILES ──── (strings / binwalk / exif / ELF / 附件解析)
  │
  ▼
GENERATE_SCRIPT ──── (solve.py / exp.py / analysis.py)
  │
  ▼
RUN_SCRIPT ──── (沙箱执行 + stdout/stderr 捕获)
  │
  ├── 有 flag → VERIFY_FLAG ──── 通过 → GENERATE_WRITEUP → DONE
  │                       └── 失败 → REFLECT_ERROR
  │
  └── 出错 → REFLECT_ERROR ──── 修复 → GENERATE_SCRIPT (循环)
                            └── 超限 → FAILED
```

---

## 6. 安全边界（关键）

1. **默认禁网**：`allow_network=false` 是默认值；CTF 远程题必须 `authorized=true` + `allow_network=true` 同时满足才会放行
2. **沙箱限制**：脚本运行受 `setrlimit`（CPU 60s / 内存 1GB / 文件 100MB / 进程 32）+ Python timeout 双重约束
3. **危险命令黑名单**：`rm -rf /` / `mkfs` / `dd of=/dev/` / `sudo` / fork bomb / `curl | sh` 等会被静默拒绝
4. **API Key 安全**：Key 永不出现在日志 / 报告 / 前端；`Authorization` 头在日志中被 `mask_secret` 脱敏
5. **路径逃逸防护**：所有上传 / 解压 / 脚本写入都会检查 `realpath` 是否落在 workspace 内
6. **ScopeGuard allowlist**：HTTP 工具调用前必须通过 `scope_guard.check(target)`，默认拒绝一切公网

---

## 7. LLM 配置参考

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `LLM_ENABLED` | `false` | 是否启用真实 LLM |
| `LLM_PROVIDER` | `wanqing` | 当前默认走 wanqing 网关 |
| `LLM_BASE_URL` | `https://wanqing-api.corp.kuaishou.com/api/gateway/v1` | Wanqing 网关 |
| `LLM_API_KEY` | `replace_me` | 会被 `WQ_API_KEY` 环境变量覆盖 |
| `LLM_MODEL` | `ep-yba64y-1782808149582099879` | GLM-5.2 |
| `LLM_TEMPERATURE` | `0.15` | |
| `LLM_MAX_TOKENS` | `8192` | |
| `LLM_TIMEOUT` | `180` | 单次请求超时（秒） |
| `LLM_MAX_RETRIES` | `5` | 失败重试次数（指数退避） |
| `LLM_CHEAP_MAX_TOKENS` | `4096` | Cheap lane token 上限 |
| `WQ_API_KEY` | — | 统一 API Key，覆盖所有 lane |
| `CC_RUNTIME_ENABLED` | `false` | **必须为 false** |

---

## 8. 验收命令

```bash
# 后端测试
cd backend && python3 -m pytest -q

# 前端构建
cd frontend && npm ci && npm run build

# CTF smoke
make ctf-smoke

# 全部 demo
make ctf-demo-all

# LLM 配置检查
make llm-check

# 安全审计
make safety-audit

# AgentSession v2 / checkpoint / policy / validator / benchmark tests
cd backend && python3 -m pytest -q tests/test_agent_engine_*.py

# Release hygiene and package manifest
make release-check
python3 scripts/package_release.py
```

---

## Agent Engine v2 Migration Status

The repository now contains a single-session v2 kernel under `backend/app/agent_engine/`. Its `AgentSession` owns lifecycle, append-only events, Tool Registry execution, policy decisions, abort/timeout, checkpoints, progressive skills, and validator-gated completion. The control-plane API is available at `/api/agent/runs`; consumers reconnect to `/events?after_sequence=N` without replaying prior actions.

Migration is not yet a production release:

- Existing `/api/ctf` routes still use the legacy compatibility runtime while the task adapter is completed.
- `ContainerSandbox` now executes through Podman/Docker with no image pulls, no network, a read-only root, dropped capabilities, resource limits, and bounded abort/timeout cleanup. A runtime and the preloaded configured image are deployment prerequisites; `LocalTestSandbox` remains test-only.
- API-created CTF runs have no authoritative evaluator by default and therefore cannot report success from a regex match alone.
- `benchmarks/results/latest.json` is labeled `agent_session_mock`; it validates the formal 10-case/3-repeat harness, not live-model autonomous solve rate.
- The legacy Claude Code bridge is disabled by default and has no silent fallback (`CC_RUNTIME_ENABLED=false`).

Architecture truth and remaining release gates are tracked in `docs/refactor/00-current-architecture.md`, `01-target-architecture.md`, and `02-migration-plan.md`. ScopeGuard remains the compatibility control for legacy tools; v2 network tools additionally require explicit run authorization, host/port allowlists, and validated DNS results.

The release archive is `dist/cyberpilot-finalops-v4-submission.zip`; packaging excludes secrets, `.git`, databases, run data, `node_modules`, recovered vendor code, and vendored skill repositories.

---

## 9. 文档导航

- [`docs/architecture.md`](docs/architecture.md) — 系统架构 / 状态机 / 沙箱机制
- [`docs/user_manual.md`](docs/user_manual.md) — 用户手册（评委可 10 分钟跑起来）
- [`docs/benchmark_report.md`](docs/benchmark_report.md) — 能力评测报告
- [`docs/challenge_cup_pitch.md`](docs/challenge_cup_pitch.md) — 挑战杯答辩口径
- [`docs/refactor/00-current-architecture.md`](docs/refactor/00-current-architecture.md) — 当前代码审计
- [`docs/refactor/01-target-architecture.md`](docs/refactor/01-target-architecture.md) — AgentSession v2 目标架构
- [`docs/refactor/02-migration-plan.md`](docs/refactor/02-migration-plan.md) — 分阶段迁移与验收门槛

---

## 10. 当前限制

- LLM 推理能力受限于模型本身，复杂 pwn / 高难度 web 题可能需要多次尝试
- DASCTF JWT Token 有过期时间，需定期刷新
- 靶场容器有超时销毁机制，长时间解题可能遇到靶机下线
- 旧版兼容沙箱仍基于 subprocess + rlimit，**非容器级隔离**；高危任务应使用 v2 容器沙箱
- v2 需要 Podman/Docker 和预加载的 `AGENT_SANDBOX_IMAGE`；镜像不会自动拉取，运行时不可用时会显式报告阻塞
- 内存态 + DB 双写，并发可能有竞态（单线程演示无问题）

### 协作流程

- `main` 稳定分支、`dev` 集成分支、`feature/*` 开发分支
- PR 必须说明修改点、测试结果、风险
- 禁止提交 `.env` / 数据库 / 运行结果 / node_modules / dist / 密钥
- `expected_flag.txt` 永不进入用户可见链路（反作弊 6 层防护）

---

## 11. 版本历史

| 版本 | 关键变更 |
|------|---------|
| v6.1 | 简化 LLM 配置 — 单卡片 + provider 预设 + 主配置同步 cheap lane |
| v6.2 | CTF 自建题目 + 题面关键词自动识别题型 |
| v6.3 | LLMAdapter 接入 Anthropic Messages API（晚晴网关 / Claude） |
| v6.4 | 附件上传 + 富文本内容预览 — LLM 能看懂附件内容 |
| v8 | Hard Mode：无限轮次 + 困难题自动升级 expert + 继续尝试 |
| v10 | **OpenAI 协议 + 原生 tool_use**；自动搜索注入；循环检测；DASCTF 批量刷题；web_search / web_fetch / shell / python_runner 等原生工具 |

---

## 12. License & Use

仅授权使用。详见 `LICENSE`（如缺失则视为内部研究用途）。

烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X

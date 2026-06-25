# 烛龙·玄枢 ZHULONG-X — 风险控制文档

> 面向**安全审计 / 评委 / 部署运维**的风险控制说明。

---

## 1. 授权边界

### 1.1 使用范围

烛龙·玄枢 仅用于以下场景：
- 授权 CTF 比赛
- 本地靶场训练
- 安全教学演示
- 合法漏洞分析（已获书面授权）

**严禁**用于：
- 未授权攻击真实公网目标
- 实际渗透测试生产系统（除非有明确授权）
- 任何违法用途

### 1.2 授权标志

每个 CTF 任务创建时必须声明：
- `authorized: bool` — 是否已获授权
- `allow_network: bool` — 是否允许联网

**强制规则**：`allow_network=true` 必须配合 `authorized=true`，否则 orchestrator 会强制关闭网络访问并记录 `scope_check` evidence。

### 1.3 竞赛现场受控环境

- 所有 demo 题均为离线本地题，无需公网
- Web demo 靶场仅监听 `127.0.0.1`
- LLM API 走内网网关（如配置中的 `LLM_BASE_URL`）
- 演示网络可与公网物理隔离

---

## 2. ScopeGuard

### 2.1 机制

`app/core/scope_guard.py` 实现 HTTP 工具调用的 allowlist 校验：

```python
scope_guard.check(target) → ScopeCheckResult
```

### 2.2 配置

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `COMPETITION_MODE` | false | 强制 allowlist 校验 |
| `SCOPE_CIDRS` | 空 | 允许的 CIDR 列表 |
| `SCOPE_DOMAINS` | 空 | 允许的域名 |
| `SCOPE_PORTS` | 空 | 允许的端口 |
| `SCOPE_ALLOW_LOCALHOST` | false | 是否允许 127.0.0.1 |
| `SCOPE_ALLOW_PRIVATE_IPS` | false | 是否允许 RFC1918 |
| `MAX_REQUESTS_PER_TASK` | 120 | 单任务最大请求数 |
| `MAX_REQUESTS_PER_TARGET` | 40 | 单目标最大请求数 |
| `DEFAULT_HTTP_TIMEOUT` | 10 | HTTP 超时秒数 |

### 2.3 CTF 任务级校验

CtfOrchestrator 在 `run()` 开头：

```python
if task.allow_network and not task.authorized:
    task.allow_network = False
    self._record_evidence(task, "scope_check",
        "allow_network=true 但 authorized=false，已强制关闭网络访问",
        success=False)
```

这意味着 **未授权任务永远无法访问真实公网**。

### 2.4 Web Demo 特殊处理

Web demo（`web_local` / `web_local_source_leak`）：
- `challenge.json` 声明 `allow_network: true` + `authorized: true`（隐式）
- 靶场仅 `127.0.0.1`，由 `web_target_manager` 自动启动
- 端口随机分配（5001-9999）
- ScopeGuard 仅允许 localhost

---

## 3. 沙箱限制

### 3.1 隔离层级

`app/core/code_execution_sandbox.py` 实现 4 层隔离：

| 层 | 机制 | 限制 |
|---|------|------|
| 1 | 工作目录隔离 | `tempfile.mkdtemp` + realpath 检查 |
| 2 | 环境变量清洗 | 过滤 TOKEN/API_KEY/SECRET；禁网时 HTTP_PROXY=黑洞 |
| 3 | 资源限制（POSIX） | `setrlimit`: CPU 30s / 内存 1GB / 文件 100MB / 进程 32 |
| 4 | 超时 + 输出截断 | `subprocess.timeout=15s` / `max_output=20000` 字符 |

### 3.2 危险命令黑名单

```python
DANGEROUS_PATTERNS = [
    r"\brm\s+-rf\s+/",         # rm -rf /
    r"\bmkfs\b",                # mkfs
    r"\bdd\b.*of=/dev/",        # dd 写磁盘
    r":\(\)\s*\{",              # fork bomb
    r"\bcurl\b.*\|\s*sh",       # curl | sh
    r"\bwget\b.*\|\s*sh",       # wget | sh
    r"169\.254\.169\.254",      # 云 metadata
    r"\.ssh/id_rsa",            # SSH 私钥
    r"/etc/(passwd|shadow)",    # 系统文件
    r"\bsudo\b",                # sudo
    r"\bshutdown\b",            # shutdown
    r"\breboot\b",              # reboot
    # ... 共 20+ 模式
]
```

写入脚本前会扫描这些模式，命中即 `raise ValueError`，整个执行被拒绝。

### 3.3 路径逃逸防护

`write_script` 检查：
```python
if not os.path.abspath(target).startswith(workdir + os.sep):
    raise ValueError("script path escapes sandbox")
```

`basename()` 剥除 `../`，确保脚本文件落在 workspace 内。

### 3.4 局限性

- **非容器级**：subprocess + rlimit 不能防御内核漏洞 / ptrace 逃逸
- **macOS rlimit 部分支持**：`RLIMIT_NPROC` 在 macOS 上语义不同
- **建议**：高危题目用 firejail / nsjail / bubblewrap 或 docker

---

## 4. 网络访问限制

### 4.1 默认禁网

```python
# code_execution_sandbox.py _make_safe_env()
if not self.allow_network:
    safe["HTTP_PROXY"] = "127.0.0.1:9"  # 黑洞
    safe["HTTPS_PROXY"] = "127.0.0.1:9"
    safe["ALL_PROXY"] = "127.0.0.1:9"
```

子进程的 HTTP 请求会被路由到 9 端口（discard），等效于断网。

### 4.2 显式放行

只有以下条件**全部满足**才允许网络：
1. `task.authorized = true`
2. `task.allow_network = true`
3. ScopeGuard allowlist 包含目标

### 4.3 Web Demo 例外

Web demo 靶场在 `127.0.0.1` 上，不走公网，所以即使 `allow_network=false` 也能访问（localhost 不算公网）。

---

## 5. API Key 脱敏

### 5.1 脱敏函数

`app/core/llm_adapter.py`：

```python
def mask_secret(value: Optional[str], keep_head=4, keep_tail=4) -> str:
    if not value or value == "replace_me":
        return "(not configured)"
    if len(value) <= keep_head + keep_tail:
        return "****"
    return value[:keep_head] + "****" + value[-keep_tail:]
```

效果：`sk-abcdefghijklmno` → `sk-a****lmno`

### 5.2 日志脱敏

所有 LLM 调用日志前都会调用 `mask_sensitive_in_text()`：

```python
def mask_sensitive_in_text(text: str) -> str:
    # sk-xxx
    text = re.sub(r"sk-[A-Za-z0-9_\-]{12,}", "sk-****MASKED", text)
    # Bearer xxx
    text = re.sub(r"(?i)bearer\s+[A-Za-z0-9_\-\.]{16,}", "bearer ****MASKED", text)
    # JWT 三段式
    text = re.sub(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", "eyJ****MASKED", text)
    return text
```

### 5.3 API 端点不返回 key

`GET /api/ctf/llm/status` 只返回：
```json
{
  "mode": "mock|live|disabled",
  "provider": "deepseek",
  "model": "deepseek-coder",
  "api_key_configured": true,  // 仅布尔值
  "base_url_host": "api.deepseek.com"
}
```

**永不返回** key 本身。

### 5.4 .env 保护

- `.env` 已加入 `.gitignore`
- `.env.example` 中所有 key 都是 `replace_me`
- 提交前 `make safety-audit` 会扫描敏感字段

---

## 6. 反作弊机制

### 6.1 设计原则

`expected_flag.txt` **只能用于测试断言**，不能被 orchestrator / LLM / sandbox / analyzer 读取。

### 6.2 6 层防护

| 层 | 位置 | 措施 |
|---|------|------|
| 1 | `CtfFileAnalyzer._stage_input()` | 跳过 `expected_flag.txt`，不拷贝到 workspace |
| 2 | `CtfFileAnalyzer._analyze_one()` | 直接返回 blocked 状态 |
| 3 | `CtfOrchestrator._run_script()` | 拷贝附件时排除 |
| 4 | `CtfOrchestrator._verify_flag()` | 从附件列表过滤 |
| 5 | `ctf_persistence.load_task_view()` | API 响应不含 `expected_flag` 字段 |
| 6 | `ctf_api._save_upload()` | 上传 `expected_flag.txt` 时返回 400 拒绝 |

### 6.3 验证

`ctf_llm_smoke.py` 中专门检查：
```python
for e in task.evidence:
    if expected in (e.input_summary + e.output_summary):
        if e.step != "verify_flag":
            print("❌ anti-cheat violation")
            return False
```

---

## 7. 竞赛现场受控环境适配

### 7.1 网络隔离

- 演示网络可与公网物理隔离
- 所有 demo 离线运行
- Web demo 仅 127.0.0.1
- LLM 走内网网关

### 7.2 依赖最小化

后端依赖（`requirements.txt`）：
- fastapi + uvicorn
- sqlalchemy + pydantic-settings
- httpx
- flask（仅 web demo 靶场）

前端依赖：
- react + react-router-dom
- axios + lucide-react + clsx
- tailwindcss

无重型 ML 依赖，无外部二进制。

### 7.3 一键启动

```bash
# 后端
cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# 前端
cd frontend && npm install && npm run dev
```

或容器化：
```bash
make podman-up
```

### 7.4 演示回退

如果真实 LLM 不可用：
- 设置 `LLM_ENABLED=false` → 自动进入 mock 模式
- 10/11 demo 仍可自动通过
- 评委体验不受影响

---

## 8. 审计日志

### 8.1 Evidence Chain

每个 CTF 任务全程记录：
- `ctf_events` 表：每步 evidence（步骤名 / 时间戳 / 输入输出摘要 / 成功状态 / artifacts）
- `ctf_artifacts` 表：每次脚本运行（stdout / stderr / exit_code / duration）
- `ctf_flags` 表：每个候选 flag（含置信度 / 来源 / 行号）

### 8.2 WP 基于真实日志

`WriteupGenerator` 只整理 evidence + script_runs，不编造：
- 题目信息 → 来自 task 字段
- 解题思路 → 来自 task.plan
- 关键分析 → 来自 task.analysis
- 完整脚本 → 来自 task.current_script
- 执行记录 → 来自 task.script_runs
- flag 获取 → 来自 task.candidate_flags
- 证据链 → 来自 task.evidence

### 8.3 重启可查

SQLite 持久化保证进程重启后：
- `GET /api/ctf/tasks/{tid}` 仍可查询
- `GET /api/ctf/tasks/{tid}/events` 仍可查询
- `GET /api/ctf/tasks/{tid}/writeup` 仍可导出

---

## 9. 安全审计命令

```bash
# 后端测试（含沙箱安全测试）
cd backend && python3 -m pytest tests/test_code_sandbox.py tests/test_ctf_orchestrator.py -v

# 安全审计脚本
make safety-audit

# LLM 配置检查（验证 key 脱敏）
make llm-check

# 反作弊验证
make ctf-llm-smoke  # 需真实 LLM
```

---

## 10. 紧急响应

### 10.1 发现异常脚本

如果 Agent 生成了危险脚本：
- 沙箱会自动拒绝（`ValueError: dangerous pattern detected`）
- 任务状态变为 `FAILED`
- evidence 记录拒绝原因

### 10.2 发现越权访问

如果 Agent 尝试访问未授权目标：
- ScopeGuard 返回 `allowed: false`
- HTTP 工具不执行请求
- evidence 记录 `scope_check` 失败

### 10.3 紧急停止

```bash
# 停止所有 Web 靶场
python3 -c "from app.core.web_target_manager import stop_all_targets; stop_all_targets()"

# 清空所有运行中任务
python3 -c "
from app.database import SessionLocal
from app.models.ctf import CtfTask
db = SessionLocal()
db.query(CtfTask).filter(CtfTask.is_running == True).update({'is_running': False, 'state': 'FAILED', 'error': 'manual stop'})
db.commit()
"
```

---

烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X

# 烛龙·玄枢 ZHULONG-X — 系统架构

> 本文档面向**开发者 / 评委 / 安全审计**读者，详细说明各模块的设计与协作方式。

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (React + Vite + Tailwind + 玻璃拟态)             │
│  ┌──────────────┬──────────────┬──────────────┐           │
│  │ Dashboard    │ CtfHub       │ CtfTaskDetail│           │
│  │ (作战大屏)   │ (CTF作战)    │ (单题作战页)  │           │
│  └──────────────┴──────────────┴──────────────┘           │
│  ┌──────────────┐                                         │
│  │ Benchmark    │                                         │
│  └──────────────┘                                         │
└────────────────────┬─────────────────────────────────────┘
                     │  HTTP /api/ctf/*
┌────────────────────▼─────────────────────────────────────┐
│  FastAPI Backend                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  CTF API Router (app/api/ctf.py)                   │  │
│  │  - POST /tasks    - POST /tasks/{id}/attachments    │  │
│  │  - POST /tasks/{id}/solve                          │  │
│  │  - GET  /tasks/{id}/events                         │  │
│  │  - GET  /tasks/{id}/writeup                       │  │
│  │  - GET  /demos     - POST /demos/{id}/run          │  │
│  │  - GET  /benchmark                                 │  │
│  └────────────────────┬───────────────────────────────┘  │
│                       │                                   │
│  ┌────────────────────▼───────────────────────────────┐  │
│  │  CtfOrchestrator (app/core/ctf_agent_orchestrator) │  │
│  │  状态机驱动 + EvidenceChain                        │  │
│  └─┬─────────┬─────────┬─────────┬─────────┬─────────┘  │
│    │         │         │         │         │             │
│  ┌─▼──┐  ┌──▼──┐  ┌───▼───┐ ┌───▼───┐ ┌───▼─────┐       │
│  │LLM │  │File │  │Code   │ │Flag   │ │Writeup │       │
│  │Ada.│  │Anal.│  │Sandbox│ │Verif. │ │Gen.    │       │
│  └────┘  └─────┘  └───────┘ └───────┘ └────────┘       │
│                                                          │
│  ScopeGuard (allowlist + 强制 authorized 校验)            │
└──────────────────────────────────────────────────────────┘
```

## 2. CTF Agent 状态机

`app/core/ctf_agent_orchestrator.py` 实现的核心状态机：

```
INIT
  ↓ (记录初始化证据)
CLASSIFY
  ↓ (LLM 判断题型 web/crypto/reverse/pwn/misc/forensics)
PLAN
  ↓ (LLM 生成解题步骤、风险、fallback)
ANALYZE_FILES
  ↓ (File Analyzer: strings/binwalk/exif → 提取候选 flag)
GENERATE_SCRIPT
  ↓ (LLM 生成 solve.py)
RUN_SCRIPT
  ↓ (Sandbox 执行)
  ├── 成功 → VERIFY_FLAG
  └── 失败 → REFLECT_ERROR
REFLECT_ERROR
  ↓ (LLM 阅读 stderr 修复脚本)
  └── 重试 RUN_SCRIPT (受 max_rounds 限制)
VERIFY_FLAG
  ↓ (FlagVerifier 多源提取 + 排序)
  ├── 找到 flag → GENERATE_WRITEUP
  └── 未找到 → 若有 fallback 重回 GENERATE_SCRIPT，否则 GENERATE_WRITEUP
GENERATE_WRITEUP
  ↓ (基于真实 evidence 生成中文 WP)
DONE  (找到 flag)
HUMAN_REQUIRED (未找到 flag，超出 max_rounds)
FAILED (异常)
```

### 关键设计

1. **状态机而非递归**：避免 LLM 无限循环调用，每轮显式计数
2. **EvidenceChain 全程记录**：每一步都保存输入/输出/耗时/成功状态，用于 WP 生成与可审计
3. **失败可恢复**：脚本失败 → 反思 → 重试；达到 `max_rounds` 后转 `HUMAN_REQUIRED`
4. **ScopeCheck 强制**：`run()` 开头检查 `allow_network + authorized`，不合规直接降级

## 3. LLM Adapter

`app/core/llm_adapter.py`：统一的 OpenAI-compatible 适配层。

### 三种模式

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| `live` | `LLM_ENABLED=true` 且 key 已配置 | 真实 HTTP 请求 |
| `mock` | `LLM_ENABLED=false` 且 `APP_ENV in (dev, demo, test)` | 本地启发式规则返回 |
| `disabled` | `LLM_ENABLED=false` 且 `APP_ENV=prod` | 直接返回错误 |

### 国产模型兼容

`PROVIDER_COMPAT` 表声明每个 provider 是否支持 `developer` role 与 JSON mode：

```python
PROVIDER_COMPAT = {
    "deepseek": {"supports_developer": True,  "supports_json_mode": True},
    "qwen":     {"supports_developer": False, "supports_json_mode": True},  # 合并到 system
    "glm":      {"supports_developer": False, "supports_json_mode": True},
    ...
}
```

`sanitize_messages_for_provider()` 会根据 provider 整理 messages，把不支持的 `developer` 角色合并到 `system`。

### Mock 启发式

Mock 模式根据 prompt 关键词返回不同内容：

- 包含 `solve.py` / `解题脚本` / `修复` → 返回通用 Python solver（自动尝试 base64 / XOR / hex / 常见 flag 正则）
- 包含 `classify` / `题型` → 返回 JSON 分类
- 包含 `解题计划` → 返回 JSON 计划

这套 mock 设计使得 **不配置任何 LLM key 也能演示完整流程**。

### 敏感信息脱敏

- `mask_secret(key)`: 保留首 4 尾 4，中间替换为 `****`
- `mask_sensitive_in_text(text)`: 正则脱敏 `sk-xxx` / `Bearer xxx` / JWT 三段式
- 所有 LLM 日志调用前都会先 `mask_sensitive_in_text`

## 4. Code Execution Sandbox

`app/core/code_execution_sandbox.py`：脚本执行沙箱。

### 隔离层级

1. **工作目录隔离**：每次执行创建 `tempfile.mkdtemp(prefix='ctf_')`，cwd 锁定在该目录
2. **环境变量清洗**：`_make_safe_env()` 仅保留 PATH/HOME/LANG；过滤所有含 TOKEN/API_KEY/SECRET 的环境变量；未启用网络时强制 HTTP_PROXY=127.0.0.1:9 黑洞
3. **资源限制（POSIX）**：`preexec_fn=self._limit_resources` 通过 `setrlimit` 限制：
   - CPU 时间 30s
   - 内存 1GB
   - 文件大小 100MB
   - 子进程数 32
4. **超时**：`subprocess.run(..., timeout=15)`，超时返回 exit_code=124
5. **输出截断**：`max_output=20000` 字符，超出截断并标注
6. **危险命令黑名单**：`DANGEROUS_PATTERNS` 正则匹配 `rm -rf /` / `mkfs` / `dd of=/dev/` / fork bomb / `curl | sh` 等，命中即拒绝写入

### 路径逃逸防护

`write_script` 检查 `os.path.abspath(target).startswith(workdir + os.sep)`，禁止 `../../../etc/passwd` 类逃逸。`basename()` 也会剥除 `../`。

### 局限

- **非容器级**：subprocess + rlimit 不能防御内核漏洞 / ptrace 逃逸。生产部署高危题目建议用 firejail / nsjail / bubblewrap 或 docker
- **macOS rlimit 部分支持**：`RLIMIT_NPROC` 在 macOS 上语义不同，可能不生效

## 5. 安全边界

### 5.1 ScopeGuard（已有，复用）

`app/core/scope_guard.py`：HTTP 工具调用前必须通过 `scope_guard.check(target)`。

- `COMPETITION_MODE=true` 时强制 allowlist 校验
- `SCOPE_CIDRS` / `SCOPE_DOMAINS` / `SCOPE_PORTS` 配置允许范围
- `SCOPE_ALLOW_LOCALHOST` / `SCOPE_ALLOW_PRIVATE_IPS` 控制 RFC1918 私网

### 5.2 CTF 任务级安全

CtfOrchestrator 在 `run()` 开头：

```python
if task.allow_network and not task.authorized:
    task.allow_network = False
    self._record_evidence(task, "scope_check", "强制关闭网络访问", success=False)
```

这意味着 **未授权任务永远无法访问真实公网**，即使 API 显式传 `allow_network=true`。

### 5.3 危险命令防御

```python
DANGEROUS_PATTERNS = [
    r"\brm\s+-rf\s+/",         # rm -rf /
    r"\bmkfs\b",                # mkfs
    r"\bdd\b.*of=/dev/",        # dd 写磁盘
    r":\(\)\s*\{",              # fork bomb :(){ ... }
    r"\bcurl\b.*\|\s*sh",       # curl | sh
    r"169\.254\.169\.254",      # 云 metadata
    r"\.ssh/id_rsa",            # SSH 私钥
    r"/etc/(passwd|shadow)",    # 系统文件
    ...
]
```

写入脚本前会扫描这些模式，命中即 `raise ValueError`，整个执行被拒绝。

### 5.4 上传文件防护

- 大小限制：`MAX_UPLOAD_SIZE=50MB`
- 解压防 zip slip：检查每个 entry 的 realpath 是否在 workspace 内
- 解压文件数限制：`MAX_EXTRACTED_FILES=200`
- 总解压大小：`MAX_EXTRACTED_TOTAL_SIZE=200MB`

## 6. Flag Verifier

`app/core/flag_verifier.py`：从多源（stdout / stderr / 文件 / 日志）提取候选 flag。

### 默认正则

```python
DEFAULT_FLAG_PATTERNS = [
    r"flag\{[^}\s]{1,200}\}",
    r"FLAG\{[^}\s]{1,200}\}",
    r"ctf\{[^}\s]{1,200}\}",
    r"CTF\{[^}\s]{1,200}\}",
    r"sctf\{[^}\s]{1,200}\}",
    r"SCTF\{[^}\s]{1,200}\}",
    r"key\{[^}\s]{1,200}\}",
    ...
]
```

### 置信度评分

每个候选 flag 根据以下因素打分：

- 长度合理（8-100）：+0.15
- 包含数字：+0.10
- 包含下划线/连字符：+0.05
- 多次出现：+0.10 / 次
- 上限 0.99

### 多源合并

`verify(stdout, stderr, files, expected_flag, flag_format_regex)` 会汇总所有来源的候选，按置信度排序，可选与期望 flag 对比验证。

## 7. Writeup Generator

`app/core/writeup_generator.py`：基于真实 EvidenceChain 生成 Markdown WP。

WP 必须包含：
1. 题目信息（标题/描述/附件）
2. 解题思路（plan + risks）
3. 关键分析过程（file analyzer 结果表格）
4. 完整 solve.py 脚本
5. 脚本执行记录（stdout/stderr/exit_code/duration）
6. flag 获取过程（候选列表）
7. 完整证据链（所有 evidence 步骤表格）
8. 坑点与改进

**WP 不允许编造**——所有内容来自 task.evidence 和 task.script_runs，generator 只做整理与表格化。

## 8. 前后端交互

- 前端通过 `axios` 调用 `/api/ctf/*`
- `POST /tasks/{id}/solve` 是**同步**执行（演示用），生产应改为后台任务 + 轮询 `/events`
- `GET /tasks/{id}/events` 返回完整 evidence 列表（演示）；前端 `CtfTaskDetail` 每 3 秒自动刷新直到 state ∈ {DONE, FAILED, HUMAN_REQUIRED}
- `GET /tasks/{id}/writeup` 返回纯文本 Markdown，前端用 modal 展示

## 9. 工具链复用

烛龙·玄枢 复用了原有的安全工具集（`app/tools/`）：

- `HttpFingerprintTool` / `DirectoryProbeTool` / `JSInterfaceExtractorTool`
- `JavaCodeAuditTool` / `LogAnalyzerTool` / `FileParserTool`

这些工具通过 `ToolRegistry` 注册，可被外部任务调用。CTF Orchestrator 当前不直接调用它们（聚焦离线题），但保留接口供未来 web/pwn 题扩展。

## 10. 数据存储

- SQLite (`data/zhulongx.db`)：原有 Task/Step/Report 表
- 内存 (`_TASKS: Dict[str, CtfTask]`)：CTF 任务状态（演示用，重启丢失；生产应迁移到表）
- 文件系统：
  - `app/storage/uploads/{task_id}/` — 上传附件
  - `data/ctf_runs/ctf_*` — 沙箱工作目录
  - `app/storage/reports/` — WP 输出（如需持久化）

# Range Onboarding - FinalOps v4

本文用于决赛靶场接入前检查授权范围。所有网络访问必须先经过 ScopeGuard；本机运行只使用 Podman。

## 1. 收集裁判授权信息

需要从赛题或裁判处确认：

- 允许访问的 CIDR，例如 `10.10.0.0/16`
- 允许访问的域名，例如 `*.arena.local`
- 允许端口，例如 `80,443,8080-8090`
- 是否允许私有地址
- 是否允许 localhost
- 单题和单目标请求预算

没有写入授权范围的信息，一律按禁止处理。

## 2. 写入 `.env`

```env
COMPETITION_MODE=true
SCOPE_CIDRS=10.10.0.0/16
SCOPE_DOMAINS=*.arena.local,target.local
SCOPE_PORTS=80,443,8080-8090
SCOPE_ALLOW_PRIVATE_IPS=true
SCOPE_ALLOW_LOCALHOST=false
SCOPE_MAX_REQUESTS_PER_TASK=30
SCOPE_MAX_REQUESTS_PER_TARGET=60
DEFAULT_HTTP_TIMEOUT=8
```

LLM 配置可以为空；平台会使用规则兜底。不要把真实密钥写入仓库文件或提交包。

## 3. Podman 启动

```bash
cp .env.example .env
make doctor
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up
```

访问：

- FinalOps: `http://localhost:13000/final-ops`
- Settings: `http://localhost:13000/settings`
- Health: `http://localhost:18000/api/health`
- Docs: `http://localhost:18000/docs`

停止：

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-down
```

## 4. Scope 检查

命令行检查：

```bash
curl -s http://localhost:18000/api/scope/check \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://target.arena.local:8080/"}'
```

前端检查：

1. 打开 Settings。
2. 在 ScopeGuard 卡片中粘贴目标 URL。
3. 点击“检查”。
4. 记录 allowed、reason、matched_rule、host、port、resolved IP。

必须做两类检查：

- 一个裁判授权目标，应返回 `allowed=true`。
- 一个明显非授权目标，应返回 `allowed=false`。

## 5. 开赛前最小演练

```bash
make final-drill
make team-drill
make safety-audit
```

合格标准：

- `final-drill` 无 failures。
- `team-drill` 输出 scoreboard、timeline、debrief。
- `safety-audit` 无 failures。
- Settings 中 ScopeGuard 检查器能正确区分允许和禁止目标。

## 6. 现场变更规则

- 若裁判临时增加目标范围，只改 `.env` 范围项并重启 Podman。
- 若 LLM 不通，不阻塞比赛；继续规则兜底和人工回填。
- 若端口冲突，只改 `FRONTEND_PORT`、`BACKEND_PORT`。
- 若 ScopeGuard 拦截未授权目标，保留拦截理由，不尝试绕过。
- 若要导出状态，使用 FinalOps “导出备份”或 `make backup-final`。

## 7. Real CTF Case 接入

本地题包使用以下结构：

```text
ctf_cases/case01/
  challenge.json
  README.md
  attachments/
  scope.env.example
  evaluator/expected_answer.txt
  evaluator/verify.py
```

Agent 解题命令：

```bash
make solve-ctf CASE=ctf_cases/case01
```

训练评估命令：

```bash
make evaluate-ctf CASE=ctf_cases/case01
make solve-and-eval-ctf CASE=ctf_cases/case01
```

安全要求：

- `solve_ctf_case.py` 不读取 `evaluator/`。
- `evaluate_ctf_case.py` 是唯一读取 `evaluator/expected_answer.txt` 的脚本。
- Blind Solve Mode 禁止 RAG、历史题库、历史 run、公开 writeup 搜索和相似题匹配参与解题。
- RAG 只能用于赛后文档检索或复盘整理，不能用于现场求解或生成候选答案。
- 候选答案必须绑定当前题运行产生的 `evidence_id`；缺少证据的候选不得作为 rank1 高置信结论。
- Web 目标必须在 `scope.env.example` 或 `.env` 中显式命中 ScopeGuard。
- POST/PUT/PATCH/DELETE 不自动执行，只生成需要人工确认的动作。
- 输出目录为 `ctf_runs/<case-id>-<timestamp>/`，其中 `brief.md` 可作为提交说明。

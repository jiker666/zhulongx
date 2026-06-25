# 团队协作 SOP — 烛龙·玄枢 ZHULONG-X

> 面向**队友协作开发**的规范文档。clone 后请先读完本文件。

---

## 1. 分支规则

| 分支 | 用途 | 保护规则 |
|------|------|---------|
| `main` | 稳定发布版本 | 禁止直接 push；只能通过 PR 合入；必须通过全部验收 |
| `dev` | 集成分支 | 日常开发合并到这里；PR 合入前需通过 pytest + ctf-smoke + build |
| `feature/*` | 功能开发 | 如 `feature/web-demo-enhance`；从 `dev` 拉出；完成后 PR 回 `dev` |
| `fix/*` | Bug 修复 | 如 `fix/sandbox-timeout`；从 `dev` 拉出；完成后 PR 回 `dev` |
| `release/*` | 发布准备 | 如 `release/v5.1.0`；从 `main` 拉出；仅做版本号 + 文档更新 |

### 工作流

```bash
# 1. clone 后首次设置
git clone <repo-url>
cd cyberpilot
git checkout dev
git pull

# 2. 开始新功能
git checkout -b feature/<your-name>-<task>
# 例如: git checkout -b feature/zhangsan-web-demo

# 3. 开发过程中
git add .
git commit -m "feat: add xxx"
git push -u origin feature/<your-name>-<task>

# 4. 在 GitHub 上向 dev 提 PR
# 5. PR 通过后合并到 dev
# 6. 定期从 dev rebase
git checkout dev
git pull
git checkout feature/<your-name>-<task>
git rebase dev
```

---

## 2. PR 规则

### PR 标题格式

```
<type>: <short description>
```

type 可选：
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `refactor`: 重构（不改变行为）
- `test`: 测试相关
- `chore`: 构建/依赖/配置

### PR 描述模板

见 `.github/pull_request_template.md`，必须包含：
- 修改内容（bullet list）
- 测试结果（勾选验收项）
- 风险说明
- 是否涉及敏感信息

### PR 审查要点

- [ ] 代码风格一致（Python: black/isort；TS: prettier）
- [ ] 无 `print` 调试语句残留
- [ ] 无硬编码密钥/ token
- [ ] 新功能有测试覆盖
- [ ] 文档已更新
- [ ] `expected_flag.txt` 未暴露到 API/前端

---

## 3. 禁止提交清单

以下文件**绝对不能**提交到仓库：

| 类型 | 文件 | 原因 |
|------|------|------|
| 环境配置 | `.env` / `.env.local` | 含真实 key |
| 数据库 | `*.db` / `*.sqlite` | 本地运行状态 |
| 运行产物 | `ctf_runs/` / `data/ctf_runs/` | 任务执行结果 |
| 备份 | `backups/` | 本地备份 |
| 依赖 | `node_modules/` | 用 `npm ci` 重装 |
| 构建产物 | `frontend/dist/` / `dist/` | 用 `npm run build` 重建 |
| Python 缓存 | `__pycache__/` / `*.pyc` | 自动生成 |
| 测试缓存 | `.pytest_cache/` | 自动生成 |
| 日志 | `*.log`（运行时） | 运行时生成 |
| macOS | `.DS_Store` / `__MACOSX/` | 系统垃圾 |
| IDE | `.idea/` / `.vscode/`（个人配置） | 个人偏好 |

`.gitignore` 已配置以上规则。如果误添加，用 `git rm --cached <file>` 移除跟踪。

---

## 4. Demo 修改规则

### 新增 Demo 必须包含

每个 demo 目录（`examples/ctf_demo/<demo_id>/`）必须有以下文件：

```
examples/ctf_demo/<demo_id>/
├── challenge.json          # 题目元数据
├── expected_flag.txt       # 期望 flag（仅 benchmark 用）
├── README.md               # 题目说明 + 解题思路
├── baseline_solve.py       # 基线解题脚本（用于 benchmark 对照）
└── attachment/             # 附件目录
    └── <files>
```

### challenge.json 格式

```json
{
  "title": "题目标题",
  "category": "crypto|misc|forensics|reverse|web|pwn",
  "difficulty": "easy|medium|hard",
  "description": "题面描述",
  "flag_format": "flag\\{[^}]+\\}",
  "hint": "提示（可选）",
  "allow_network": false,
  "target_url_template": "http://127.0.0.1:{port}",
  "needs_llm": false,
  "est_time_sec": 10
}
```

### 反作弊规则（关键）

`expected_flag.txt` **永不进入用户可见链路**：

1. `CtfFileAnalyzer._stage_input()` 跳过该文件
2. `CtfFileAnalyzer._analyze_one()` 返回 blocked 状态
3. `CtfOrchestrator._run_script()` 拷贝附件时排除
4. `CtfOrchestrator._verify_flag()` 从附件列表过滤
5. `ctf_persistence.load_task_view()` API 响应不含该字段
6. `ctf_api._save_upload()` 上传该文件时返回 400 拒绝

**新增 demo 时必须确保**：
- `expected_flag.txt` 放在 demo 根目录，**不放 attachment/**
- baseline_solve.py 可以读取 attachment，但**不能读 expected_flag.txt**
- 验证方式：运行 `make ctf-demo-all`，检查 evidence 中无 expected_flag 明文

---

## 5. 测试规则

### 提交前必须通过

```bash
# 后端测试
cd backend && python3 -m pytest -q

# CTF smoke
make ctf-smoke

# 全部 demo
make ctf-demo-all

# 前端构建
cd frontend && npm ci && npm run build
```

### 新增功能必须加测试

- 后端新模块 → 在 `backend/tests/` 添加对应 test_*.py
- 新 demo → 自动被 `make ctf-demo-all` 覆盖
- 新 API 端点 → 在 `tests/test_ctf_api.py` 添加用例

---

## 6. 代码风格

### Python

- 格式化：`black --line-length 100`
- 排序：`isort --profile black`
- 类型：使用 `from __future__ import annotations` + typing
- 日志：`logging.getLogger(__name__)`，不要 `print`
- 异常：捕获具体异常，不要 bare `except`

### TypeScript / React

- 格式化：`prettier --write`
- Lint：`eslint`
- 组件：函数式 + Hooks，不要 class component
- 类型：严格模式，避免 `any`

---

## 7. LLM 配置协作

### 共享 .env.example

- `.env.example` 是模板，只含占位符
- 每人本地复制为 `.env` 并填入自己的 key
- `.env` 已被 .gitignore 忽略

### Key 安全

- 真实 key **永不**出现在代码/注释/文档中
- 日志中 key 会被 `mask_secret()` 自动脱敏（保留首 4 尾 4）
- 前端 `/api/ctf/llm/status` 只返回 `api_key_configured: bool`

---

## 8. 发布流程

### 版本号

遵循 SemVer：`MAJOR.MINOR.PATCH`

- `main` 分支的 VERSION 文件记录当前版本
- 发布前更新 VERSION + CHANGELOG

### Release 步骤

1. 从 `main` 拉出 `release/vX.Y.Z`
2. 更新 `VERSION`
3. 更新 `docs/final_acceptance_report.md`
4. 跑全部验收
5. PR 合入 `main`
6. 在 GitHub 打 tag `vX.Y.Z`
7. （可选）上传 Release zip

---

## 9. 常见问题

### Q: 我误提交了 .env 怎么办？

```bash
git rm --cached .env
git commit -m "chore: remove accidentally committed .env"
# 如果已经 push，需要 force push 并通知队友轮换 key
```

### Q: demo 运行失败怎么办？

```bash
# 1. 检查后端是否启动
curl http://localhost:8000/api/health

# 2. 清空运行数据
rm -rf data/ctf_runs backend/data/ctf_runs data/*.db

# 3. 重新运行
make ctf-demo-all
```

### Q: 前端白屏怎么办？

```bash
# 1. 检查后端是否启动
# 2. 清空 node_modules 重装
cd frontend && rm -rf node_modules && npm ci && npm run dev
```

### Q: 如何添加新题型？

1. 在 `CtfOrchestrator._default_tools_for()` 添加工具集
2. 在 `CtfOrchestrator._default_plan_for()` 添加默认计划
3. 在 `LLMAdapter._mock_complete()` 添加 mock 启发式
4. 新增 demo 验证
5. 更新 README demo 表格

---

## 10. 联系方式

- 仓库 Issues：用于 bug 报告 / feature request
- 内部沟通：见团队群

---

烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X

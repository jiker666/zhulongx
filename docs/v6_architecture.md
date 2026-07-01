# v6 架构：低成本多角色 CTF 解题闭环

## 设计目标

把 ZHULONG-X 从「单 Agent 状态机」升级为：

> **低成本多角色 CTF 智能体：Manager 编排 + Blackboard 事实黑板 + Observer 旁路监督 + Cost-aware Model Router + Evidence-driven Solve Loop**

### 参考项目与取舍

| 参考项目 | 借鉴 | 不照搬 |
|---------|------|--------|
| BreachWeave | Manager/Observer 三层解耦、旁路监督、外置结束条件 | 7 模型并行竞争、复杂 TS monorepo |
| Cairn | Blackboard 黑板、Fact/Intent/Hint 三元组 | 通用状态空间搜索、Docker worker 集群 |
| LuaN1aoAgent | Planner/Executor/Reflector 认知闭环、L1-L4 失败归因 | 大规模 MCP 工具链、危险工具调用 |
| aide-for-pentest | 通用 Agent Runtime + 场景 Overlay、Skill 提示词 | Kali worker、nuclei 模板依赖 |
| CyberStrikeAI | 工具元数据、审计日志、结果压缩、Web UI 可视化 | C2 / WebShell / 后渗透 / 横向移动 |

## 核心模块

### 1. ModelRouter（成本控制核心）

```
任务状态 → decide() → RouteDecision
                          ↓
         ┌────────────────┴────────────────┐
         │                                 │
   STATIC_ONLY    CHEAP    EXPERT    FALLBACK   STOP
   (不调 LLM)  (DeepSeek) (GLM-5.2)  (Qwen)   (转人工)
```

升级 EXPERT 的条件（满足任一）：
- `rounds_used >= 3` 且无候选 flag
- 同一错误类型重复 2 次
- 附件分析摘要 > 8000 字符
- Observer 判断陷入循环
- 用户手动 `force_expert=true`

### 2. Blackboard（事实黑板）

三元组：
- **Fact**：file / clue / candidate / error / tool_result / constraint
- **Intent**：pending / in_progress / completed / failed / deprecated
- **Hint**：human / observer / system

Orchestrator 每步自动写入事实；发现候选 flag 写 candidate；失败脚本写 error。

### 3. Observer（旁路监督）

规则优先，不直接执行工具：
- 同一脚本 hash 连续运行 2 次 + stderr 类似 → loop
- 连续 2 次观察无新 fact → drift
- 高置信候选 flag 但未进入 verify → should_replan
- 接近轮次上限 + 无候选 + drift → should_stop

### 4. FailureAttributor（失败归因）

| 等级 | 含义 | 处理 |
|------|------|------|
| L1 | 环境/依赖错误 | 最小修复点 |
| L2 | 脚本逻辑错误 | 最小修复，同类重复 2 次升级 expert |
| L3 | 解题方向错误 | 重新规划 + expert |
| L4 | 信息不足/需人工 | 直接转人工，不浪费 token |

### 5. CostAccounting（成本核算）

- 估算 input/output tokens 与 USD 成本
- prompt hash 短期缓存（命中 = 0 成本）
- 单题预算 / 日预算双重约束
- mock 模式 0 成本

### 6. ContextCompressor（上下文压缩）

- `compress_tool_output`：保留 flag + 异常尾部 + 路径线索，去重 + 去 hexdump
- `compress_evidence_chain`：保留最近 N 条 + 失败项
- `compress_file_analysis`：保留 file type/magic/可疑 strings

## Solve Loop 流程

```
每轮 _step() 前：
  1. Observer 旁路检查 → ObserverAdvice
  2. should_stop? → HUMAN_REQUIRED
  3. 预算检查 → 超支转人工

每轮 _step() 后：
  4. 写黑板事实（file/candidate/error）
  5. 同步 DB

GENERATE_SCRIPT:
  - 静态分析已发现高置信候选 → STATIC_ONLY（不调 LLM）
  - 否则 ModelRouter.decide() → CHEAP/EXPERT
  - 记录成本

REFLECT_ERROR:
  - FailureAttributor 归因 L1-L4
  - L4 → HUMAN_REQUIRED（不浪费 token）
  - 压缩 stderr 给 LLM
  - 归因建议升级时 force_expert
```

## 安全边界

- 默认 `allow_network=false`
- `authorized=false` 时即使传 `allow_network=true` 也会被强制关闭
- `expected_flag` 永不出现在 LLM prompt / 报告 / 前端 / 黑板
- API key 永不出现在日志 / 报告 / API 响应（`mask_secret` 脱敏）
- 危险命令黑名单 + sandbox rlimit + ScopeGuard allowlist

## 测试

```bash
cd backend && python3 -m pytest -q
# 198 passed (含 v6 模块单测 + 集成测试)
```

v6 新增测试文件：
- `test_context_compressor.py` (14)
- `test_cost_accounting.py` (14)
- `test_model_router.py` (14)
- `test_blackboard.py` (15)
- `test_observer.py` (16)
- `test_failure_attributor.py` (17)
- `test_v6_api.py` (7)
- `test_ctf_orchestrator_cost_aware.py` (9)

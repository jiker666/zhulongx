# CyberPilot 系统设计文档

## 1. 项目目标

CyberPilot 旨在构建一个面向授权网络安全任务的通用安全智能体可视化平台，体现以下核心能力：

- 任务驱动的安全分析（用户提交任务 → Agent 自主执行）
- 可解释的决策链（每一步记录原因、工具、输入输出、下一步决策）
- 插件化工具架构（工具独立实现、统一注册、按需调用）
- 可视化展示（前端实时呈现执行步骤和报告）
- 容器化部署（Docker + Podman 双支持）

---

## 2. 总体架构

```
用户浏览器
    ↓
React 前端 (Vite + TypeScript + Tailwind)
    ↓ HTTP API
FastAPI 后端
    ├── API Layer (tasks / tools / reports / upload)
    ├── Agent Core Layer
    │   ├── Planner
    │   ├── Executor
    │   ├── ToolRegistry
    │   ├── Memory
    │   ├── Judge
    │   └── Reporter
    ├── Tool Plugins Layer
    │   ├── FileParserTool
    │   ├── HttpFingerprintTool
    │   ├── DirectoryProbeTool
    │   ├── JSInterfaceExtractorTool
    │   ├── JavaCodeAuditTool
    │   └── LogAnalyzerTool
    └── SQLite Database
         ├── tasks
         ├── steps
         ├── reports
         └── tools
```

---

## 3. Agent Core 设计

Agent Core 是平台核心，由六个模块协作完成任务执行：

```
Task Input
    ↓
  Planner (生成执行计划)
    ↓
  Executor (逐步执行)
    ├── ToolRegistry.get(tool_name)
    ├── tool.run(context)
    ├── Memory.add_step_result()
    └── Judge.evaluate() → next_decision
    ↓
  Reporter (汇总生成报告)
    ↓
  SQLite (持久化)
```

---

## 4. Planner 设计

**职责**：识别任务类型，生成 PlanStep 列表。

**分类规则**：
- 描述含 "java/代码/越权/审计" → `code_audit`
- 描述含 "log/日志/应急" → `log_analysis`
- 描述含 "逆向/apk/binary" → `reverse_helper`
- 目标为 URL → `web_scan`
- 默认 → `web_scan`

**预置计划**：
- `web_scan`: 文件解析 → HTTP指纹 → 路径探测 → JS接口提取 → 报告
- `code_audit`: 文件解析 → Controller识别 → 参数识别 → 越权判断 → 报告
- `log_analysis`: 文件解析 → 日志解析 → TopIP → TopPath → 异常状态码 → 可疑路径 → 报告
- `reverse_helper`: 文件解析 → JS接口提取 → 报告

**第二轮预留**：LLM Client 接口，支持 GPT/Qwen 生成动态计划。

---

## 5. Executor 设计

**职责**：按 PlanStep 列表顺序执行工具，记录步骤日志。

**流程**：
1. 更新任务状态为 `running`
2. 遍历 PlanStep
3. 跳过 "Reporter" 伪工具（由报告生成模块处理）
4. 从 ToolRegistry 获取工具实例
5. 构建 context（包含 target, file_path, memory 上下文）
6. 调用 `tool.safe_run(context)`（异常捕获包装）
7. Memory 记录输出
8. Judge 评估结果，生成 next_decision
9. 落库 Step 记录
10. 任务完成后更新状态为 `completed`

---

## 6. ToolRegistry 设计

**职责**：统一管理工具注册与查询。

- 单例模式
- 启动时自动注册全部默认工具
- 提供 `get(name)` / `list_tools()` / `all_names()`
- 工具通过继承 `BaseTool` 实现
- 支持动态扩展（第二轮增加新工具）

---

## 7. Memory 设计

**职责**：存储当前任务执行上下文。

- 每个任务独立 Memory 实例
- key-value 存储当前上下文
- 记录每步工具输出（`_history`）
- 提供 `get_context()` 给后续步骤
- `summarize()` 生成文本摘要，用于 Judge 评估

**第二轮扩展**：支持向量检索记忆、跨任务知识复用。

---

## 8. Reporter 设计

**职责**：汇总任务信息和步骤记录，生成标准 Markdown 报告。

报告结构：
1. 任务概览（基本信息表格）
2. Agent 执行计划
3. 决策过程记录（每步详细表格）
4. 工具调用结果
5. 风险发现
6. 修复建议
7. 总结

报告同时保存到：
- SQLite `reports` 表
- 本地文件 `./backend/app/storage/reports/task_{id}_report.md`

---

## 9. 可解释决策链设计

每个 Step 记录以下字段：

| 字段 | 说明 |
|------|------|
| step_index | 步骤序号 |
| phase | 阶段（planning/execution/reporting） |
| action | 动作名称（中文） |
| reason | 执行原因（为什么做这步） |
| tool_name | 使用的工具 |
| input_summary | 输入摘要 |
| output_summary | 工具输出摘要 |
| next_decision | Judge 评估后的下一步建议 |
| status | 执行状态（success/failed/skipped） |

前端时间线可视化展示，每步可展开查看详情。

---

## 10. 安全边界设计

- 不执行破坏性操作（无 payload 注入、无密码爆破）
- DirectoryProbeTool 只探测固定 7 条安全路径
- 文件上传限制 50MB，只允许白名单扩展名
- 上传文件使用 UUID 重命名，防止路径穿越
- 所有外部 HTTP 请求设置 timeout（8-10秒）
- 报告明确标注"仅用于授权安全测试"
- 不依赖 Docker socket，不读取宿主机敏感文件

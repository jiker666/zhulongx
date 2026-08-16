import type { TrajectorySource } from "../../types/api";
import type { RawTraceEvent, DecisionRecord, DecisionKind, PlainLanguageExplanation } from "./types";

const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token/i;

const sourceLabels: Record<TrajectorySource, string> = {
  operator: "操作员",
  orchestrator: "编排器",
  model: "模型",
  context: "上下文",
  policy: "安全策略",
  tool: "工具",
  agent: "子 Agent",
  system: "系统",
};

const toolGuides: Record<string, { action: string; purpose: string; impact: string }> = {
  list_files: { action: "查看授权目录中的文件清单", purpose: "先确认有哪些材料可分析", impact: "只读取文件名和基础信息，不修改文件" },
  read_file: { action: "读取一个授权文件", purpose: "获得后续判断所需的原始证据", impact: "只读取受限大小的文件内容" },
  inspect_artifact: { action: "识别文件类型和基础特征", purpose: "决定接下来使用哪类分析方法", impact: "只在本地读取材料并计算元数据" },
  observe_image: { action: "观察一张附件图片", purpose: "提取文字或视觉线索", impact: "图片像素只进入当前模型上下文，不写入审计文件" },
  run_command: { action: "在隔离环境执行一条白名单命令", purpose: "用专业工具验证当前判断", impact: "命令、参数和结果都会审计，且只能在授权范围内运行" },
  http_request: { action: "向授权目标发送一个受控 HTTP 请求", purpose: "观察服务响应并验证假设", impact: "请求必须通过目标范围、方法和预算检查" },
  browser: { action: "在受控浏览器中执行一步操作", purpose: "观察网页状态或完成必要交互", impact: "导航目标和动作必须通过安全策略" },
  submit_plan: { action: "提交本次任务的执行计划", purpose: "明确目标、假设和验证步骤", impact: "只更新运行计划，不访问外部目标" },
  checkpoint: { action: "整理当前证据并检查方向", purpose: "避免重复或无依据地继续尝试", impact: "会更新假设和下一步策略" },
  record_finding: { action: "记录一条可复核发现", purpose: "把结论与证据固定下来", impact: "发现会进入最终报告和证据图" },
  record_lesson: { action: "记录一条候选经验", purpose: "为后续相似任务保留可验证策略", impact: "经验仍需后续任务再次验证" },
  finish_task: { action: "结束当前运行并提交结论", purpose: "在证据足够或已无法安全推进时收敛任务", impact: "运行进入完成、阻塞或失败状态" },
};

export function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[nested data omitted]";
  if (typeof value === "string") return value.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]");
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => redactSensitiveFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redactSensitiveFields(item, depth + 1)]));
}

function inferSource(event: RawTraceEvent): TrajectorySource {
  if (event.source) return event.source;
  if (/^(assistant|model)\./i.test(event.type)) return "model";
  if (/^(context|memory|experience)\./i.test(event.type)) return "context";
  if (/^(policy|permission|approval)\./i.test(event.type) || /GUARD_REJECTED/i.test(event.type)) return "policy";
  if (/^(tool|browser|image|command)\./i.test(event.type) || /ACTION_(COMPLETED|FAILED)/i.test(event.type)) return "tool";
  if (/^(agent|workflow|subagent)\./i.test(event.type)) return "agent";
  if (/^(run|turn|session)\./i.test(event.type)) return "orchestrator";
  return "system";
}

function record(
  event: RawTraceEvent,
  kind: DecisionKind,
  title: string,
  summary: string,
  details?: Record<string, unknown>,
  explanation?: Partial<PlainLanguageExplanation>,
): DecisionRecord {
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const confidenceBefore = typeof data.confidenceBefore === "number" ? data.confidenceBefore : typeof data.confidence_before === "number" ? data.confidence_before : undefined;
  const confidenceAfter = typeof data.confidenceAfter === "number" ? data.confidenceAfter : typeof data.confidence_after === "number" ? data.confidence_after : undefined;
  const evidenceIds = Array.isArray(data.evidenceIds) ? data.evidenceIds.filter((id): id is string => typeof id === "string") : undefined;
  const source = inferSource(event);
  return {
    id: `${event.type}:${event.sequence}`,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind,
    title,
    summary,
    sourceEventType: event.type,
    source,
    ...(event.actor ? { actor: event.actor } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.parentSequence !== undefined ? { parentSequence: event.parentSequence } : {}),
    explanation: {
      what: explanation?.what ?? title,
      why: explanation?.why ?? summary,
      impact: explanation?.impact ?? `这一步由${sourceLabels[source]}产生，并已写入只追加审计链。`,
      ...(explanation?.result ? { result: explanation.result } : {}),
      ...(explanation?.next ? { next: explanation.next } : {}),
    },
    ...(confidenceBefore === undefined ? {} : { confidenceBefore }),
    ...(confidenceAfter === undefined ? {} : { confidenceAfter }),
    ...(evidenceIds?.length ? { relatedEvidenceIds: evidenceIds } : {}),
    ...(typeof data.toolCallId === "string" ? { relatedActionId: data.toolCallId } : {}),
    ...(typeof data.candidateId === "string" ? { relatedCandidateId: data.candidateId } : {}),
    ...(typeof data.allowed === "boolean" ? { policyState: data.allowed ? "allowed" : "blocked" } : {}),
    ...(details ? { technicalDetails: redactSensitiveFields(details) as Record<string, unknown> } : {}),
  };
}

function stringField(data: unknown, keys: string[]): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const object = data as Record<string, unknown>;
  return keys.map((key) => object[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function publicAssistantText(data: Record<string, unknown>): string | undefined {
  if (!Array.isArray(data.content)) return undefined;
  const text = data.content.flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []).join(" ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 420) : undefined;
}

function toolGuide(tool: string) {
  return toolGuides[tool] ?? { action: `调用工具 ${tool}`, purpose: "获取推进任务所需的受控观察", impact: "动作会先经过策略检查，结果会写入审计链" };
}

export function projectTraceEvent(event: RawTraceEvent): DecisionRecord {
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const tool = stringField(data, ["toolName", "tool", "program"]) ?? "工具";
  const reason = stringField(data, ["reason", "summary", "message", "nextAction"]);
  const guide = toolGuide(tool);
  switch (event.type) {
    case "run.started": return record(event, "system", "运行环境已建立", "编排器已创建受控任务空间并装载预算", { model: data.model, scope: data.scope, lineage: data.lineage }, { why: "每次任务需要独立的范围、预算和审计身份", impact: "后续所有动作都绑定到这个 Run，并受同一策略约束", next: "整理任务材料并开始第一轮判断" });
    case "session.forked": return record(event, "context", "从历史节点创建了新分支", "新运行继承选定节点之前的公开轨迹", data, { why: "保留已有证据，同时尝试另一条分析路线", impact: "父运行不会被修改，新动作只写入当前分支" });
    case "session.resumed": return record(event, "context", "从历史结尾继续运行", "新运行继承父运行结尾处的公开轨迹", data, { why: "继续未完成工作并避免重复已完成步骤", impact: "恢复上下文来自同一条审计事件流" });
    case "context.injected": {
      const count = Array.isArray(data.sections) ? data.sections.length : 0;
      return record(event, "context", "任务上下文已交给 Agent", `已注入 ${count} 组任务资料、经验或继承轨迹`, { sections: data.sections }, { why: "模型需要明确知道任务、已有证据和可用经验", impact: "这些公开内容会影响下一步判断；隐藏推理和凭据不会写入轨迹", next: "构建本轮模型请求" });
    }
    case "model.context": {
      const messageCount = Number(data.messageCount ?? 0);
      const toolCount = Number(data.toolCount ?? 0);
      return record(event, "context", "已整理模型本轮能看到的信息", `${messageCount} 条公开消息、${toolCount} 个工具进入本轮上下文`, { requestId: data.requestId, model: data.model, messageCount, omittedMessageCount: data.omittedMessageCount, toolCount, digest: data.digest, persistenceNotice: data.persistenceNotice, systemPrompt: data.systemPrompt, messages: data.messages, tools: data.tools }, { why: "让每次模型判断都能追溯到当时实际可见的公开信息", impact: "可按请求回放输入；隐藏思维链、密钥和图片像素明确不持久化", next: "请求模型选择下一步" });
    }
    case "model.request_reserved": return record(event, "system", "模型请求预算已预留", Number(data.waitedMs ?? 0) > 0 ? `为遵守限速等待了 ${data.waitedMs} ms` : "请求预算充足，无需等待", { estimatedTokens: data.estimatedTokens, waitedMs: data.waitedMs }, { why: "控制请求频率和令牌预算，避免运行失控", impact: "不会改变任务证据，只影响何时发起模型请求", next: "发送本轮模型请求" });
    case "turn.started": return record(event, "system", "开始新一轮判断", typeof data.turn === "number" ? `这是第 ${data.turn} 个决策回合` : "Agent 开始重新评估现有证据", undefined, { why: "每轮都会基于最新证据选择一个可验证动作", impact: "新回合不会删除之前的历史", next: "整理上下文并选择动作" });
    case "assistant.message": {
      const publicText = publicAssistantText(data);
      return record(event, "system", "Agent 已给出本轮公开判断", publicText ?? "本轮没有公开文本，可能直接选择了工具动作", { stopReason: data.stopReason, usage: data.usage, publicText, hiddenReasoningOmitted: data.hiddenReasoningOmitted }, { why: "把模型的外显结论与后续动作对应起来", impact: "隐藏思维过程不会保存；只有可复核文本和结构化动作进入轨迹", result: publicText ?? "已进入工具或下一轮处理" });
    }
    case "plan.submitted": return record(event, "system", "执行计划已提交", reason ?? "Agent 明确了目标、假设和验证步骤", { goal: data.goal, steps: data.steps }, { why: "先规划可以减少盲目尝试", impact: "计划本身不操作目标，但后续动作必须围绕计划和证据推进", next: "执行第一个可验证步骤" });
    case "tool.requested": return record(event, "action", guide.action, stringField(data, ["description"]) ?? guide.purpose, { toolName: tool, args: data.args, description: data.description }, { what: guide.action, why: guide.purpose, impact: guide.impact, next: "先交给安全策略检查是否允许执行" });
    case "policy.decision": return record(event, "policy", data.allowed === true ? "安全策略允许执行" : "安全策略阻止了动作", reason ?? "策略引擎完成范围、预算和权限检查", { toolName: tool, allowed: data.allowed, reason: data.reason, signature: data.signature, args: data.args, scope: data.scope, risk: data.risk, ruleId: data.ruleId, approvalState: data.approvalState, checks: data.checks }, { what: `检查“${guide.action}”是否在授权范围内`, why: "任何主动能力都必须先经过策略引擎", impact: data.allowed === true ? "检查通过，工具可以执行" : "动作不会执行，也不会触碰目标", result: data.allowed === true ? "允许" : `已阻止：${reason ?? "不满足策略"}`, next: data.allowed === true ? "执行工具并读取结果" : "调整策略或请求操作员处理" });
    case "permission.request": return record(event, "policy", "动作正在等待人工许可", `${tool} 的风险等级需要操作员确认`, { toolName: tool, risk: data.risk, args: data.args }, { why: "高影响动作不能仅由模型决定", impact: "在许可给出前不会执行工具", next: "等待操作员批准或拒绝" });
    case "permission.resolved": return record(event, "policy", data.decision === "deny" ? "操作员拒绝了动作" : "操作员已处理许可", `许可结果：${String(data.decision ?? "unknown")}`, data, { why: "记录谁对高影响动作作出了决定", impact: data.decision === "deny" ? "工具不会执行" : "动作可继续进入执行阶段", result: String(data.decision ?? "unknown") });
    case "tool.result": {
      const failed = data.isError === true;
      return record(event, failed ? "warning" : "result", failed ? `${tool} 执行失败` : `${tool} 已返回结果`, failed ? "工具返回错误，Agent 需要调整方法" : "工具调用已完成；这不等同于验证成功", { toolName: tool, isError: data.isError, content: data.content, details: data.details }, { what: `接收“${guide.action}”的结果`, why: "Agent 需要真实观察才能确认或推翻假设", impact: failed ? "没有获得预期观察，运行会记录失败并调整策略" : "结果已进入下一轮模型上下文和审计链", result: failed ? "执行失败" : "执行完成，但不自动等于漏洞或结论已验证", next: failed ? "检查错误并更换方法" : "整理证据并决定是否需要进一步验证" });
    }
    case "decision.checkpoint": return record(event, "result", "Agent 正在整理证据", reason ?? "系统记录了当前判断与下一步动作", { assessment: data.assessment, nextAction: data.nextAction }, { why: "定期检查可以避免重复动作和错误假设", impact: "会更新当前结论、假设状态和后续策略", result: stringField(data, ["assessment"]) ?? "检查点已记录", next: stringField(data, ["nextAction"]) });
    case "hypothesis.updated": return record(event, "hypothesis", "假设状态已更新", `根据新证据更新了 ${Array.isArray(data.updates) ? data.updates.length : 0} 项假设`, { updates: data.updates }, { why: "安全分析需要区分猜测、支持证据和已确认事实", impact: "后续动作会优先验证仍未确认的关键假设" });
    case "finding.recorded": return record(event, "evidence", "可复核发现已记录", stringField(data, ["title", "summary", "description"]) ?? "真实发现已写入运行记录", { id: data.id, severity: data.severity, evidence: data.evidence }, { why: "结论必须绑定具体证据才能进入报告", impact: "发现会显示在证据图和最终结果中" });
    case "strategy.revised": return record(event, "warning", "Agent 已调整分析方法", reason ?? "之前的方法没有产生足够证据", { revision: data.revision }, { why: "失败后继续重复同一动作没有意义", impact: "后续会换工具、修正假设或收窄目标", next: stringField(data, ["nextAction"]) });
    case "context.compacted": return record(event, "context", "较早上下文已压缩", reason ?? "保留近期关键信息以控制模型上下文大小", { id: data.id, summary: data.summary, sourceEventCount: data.sourceEventCount }, { why: "长任务需要控制上下文容量", impact: "模型看到摘要，但原始事件仍完整保留在审计链中" });
    case "lesson.captured": return record(event, "system", "候选经验已记录", stringField(data, ["title", "summary"]) ?? "候选经验已写入运行记录", { id: data.id }, { why: "把有效方法留给相似任务复用", impact: "候选经验不会被当作事实，后续仍需再次验证" });
    case "run.finished_by_agent": return record(event, "result", "Agent 已提交运行结论", reason ?? "Agent 认为本轮任务已经收敛", { status: data.status, summary: data.summary }, { why: "证据足够或安全范围内已无法继续", impact: "编排器将检查状态并结算运行", result: stringField(data, ["summary"]) ?? String(data.status ?? "unknown") });
    case "run.settled": return record(event, "result", "运行已经结束", reason ?? "编排器已完成运行结算", { status: data.status, stopReason: data.stopReason }, { why: "运行到达完成、阻塞、失败或中止状态", impact: "轨迹保持只读，可检索、回放或创建分支", result: String(data.status ?? "unknown") });
    case "run.error": return record(event, "warning", "运行发生错误", reason ?? "运行记录了错误", { message: data.message }, { why: "模型、基础设施或配置未能完成请求", impact: "错误已审计，后续可从历史结尾继续", result: reason ?? "unknown error" });
    case "WEB_ACTION_GUARD_REJECTED": return record(event, "policy", "浏览器动作被安全护栏阻止", reason ?? "动作未通过 Web 安全护栏", { toolName: tool, decision: data.decision }, { why: "浏览器动作可能影响真实网页状态", impact: "被拒绝的动作不会执行" });
    case "WEB_ACTION_SKIPPED_DUPLICATE": return record(event, "warning", "重复动作已跳过", "系统检测到同一 Web 动作已经执行过", { toolName: tool, actionId: data.actionId }, { why: "避免重复请求、触发风控或浪费预算", impact: "Agent 需要基于新证据选择不同动作" });
    case "BROWSER_ACTION_COMPLETED": return record(event, "result", "浏览器动作已完成", "受控浏览器返回了新的页面状态", { action: data.action, details: data.details });
    case "BROWSER_ACTION_FAILED": return record(event, "warning", "浏览器动作失败", reason ?? "受控浏览器动作返回失败", { action: data.action, failureSummary: data.failureSummary });
    default: return record(event, "system", `系统事件 · ${event.type}`, "该技术事件尚未配置专用解释，但仍保留完整来源与顺序", data);
  }
}

export function projectTrace(events: RawTraceEvent[]): DecisionRecord[] {
  return [...events].sort((left, right) => left.sequence - right.sequence).map(projectTraceEvent);
}

import type { RawTraceEvent, DecisionRecord, DecisionKind } from "./types";

const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token/i;

export function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[nested data omitted]";
  if (typeof value === "string") return value.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]");
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => redactSensitiveFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redactSensitiveFields(item, depth + 1)]));
}

function record(event: RawTraceEvent, kind: DecisionKind, title: string, summary: string, details?: Record<string, unknown>): DecisionRecord {
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const confidenceBefore = typeof data.confidenceBefore === "number" ? data.confidenceBefore : typeof data.confidence_before === "number" ? data.confidence_before : undefined;
  const confidenceAfter = typeof data.confidenceAfter === "number" ? data.confidenceAfter : typeof data.confidence_after === "number" ? data.confidence_after : undefined;
  const evidenceIds = Array.isArray(data.evidenceIds) ? data.evidenceIds.filter((id): id is string => typeof id === "string") : undefined;
  return {
    id: `${event.type}:${event.sequence}`,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind,
    title,
    summary,
    sourceEventType: event.type,
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

export function projectTraceEvent(event: RawTraceEvent): DecisionRecord {
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const tool = stringField(data, ["toolName", "tool", "program"]) ?? "工具";
  const reason = stringField(data, ["reason", "summary", "message", "nextAction"]);
  switch (event.type) {
    case "run.started": return record(event, "system", "Run 已创建", "任务运行已启动", { model: data.model, scope: data.scope });
    case "plan.submitted": return record(event, "system", "执行计划已提交", reason ?? "系统记录了本轮执行计划", { goal: data.goal, steps: data.steps });
    case "policy.decision": return record(event, "policy", data.allowed === true ? "动作获得策略许可" : "动作被策略阻断", reason ?? "策略引擎返回了动作判定", { toolName: tool, allowed: data.allowed, reason: data.reason, signature: data.signature, args: data.args, scope: data.scope, risk: data.risk, ruleId: data.ruleId, approvalState: data.approvalState, checks: data.checks });
    case "tool.result": return record(event, data.isError === true ? "warning" : "result", data.isError === true ? `${tool} 执行失败` : `${tool} 调用完成`, data.isError === true ? "工具返回错误，需要检查后续策略" : "工具调用已完成；这不等同于验证成功", { toolName: tool, isError: data.isError, details: data.details });
    case "decision.checkpoint": return record(event, "result", "决策检查点", reason ?? "系统记录了当前判断与下一步动作", { assessment: data.assessment, nextAction: data.nextAction });
    case "hypothesis.updated": return record(event, "hypothesis", "假设状态已更新", `真实事件记录了 ${Array.isArray(data.updates) ? data.updates.length : 0} 项假设变化`, { updates: data.updates });
    case "finding.recorded": return record(event, "evidence", "发现已记录", stringField(data, ["title", "summary", "description"]) ?? "真实发现已写入运行记录", { id: data.id, severity: data.severity, evidence: data.evidence });
    case "strategy.revised": return record(event, "warning", "策略已修订", reason ?? "系统记录了策略修订", { revision: data.revision });
    case "lesson.captured": return record(event, "system", "候选经验已记录", stringField(data, ["title", "summary"]) ?? "候选经验已写入运行记录", { id: data.id });
    case "run.finished_by_agent": return record(event, "result", "Agent 已结束运行", reason ?? "Agent 提交了运行结束结果", { status: data.status, summary: data.summary });
    case "run.settled": return record(event, "result", "Run 已收敛", reason ?? "运行已完成结算", { status: data.status, stopReason: data.stopReason });
    case "run.error": return record(event, "warning", "运行发生错误", reason ?? "运行记录了错误", { message: data.message });
    case "turn.started": return record(event, "system", "新一轮决策开始", typeof data.turn === "number" ? `第 ${data.turn} 回合` : "系统开始新一轮决策");
    case "assistant.message": return record(event, "system", "公开消息已记录", "系统记录了一条外显消息；隐藏思维过程不会在此展示");
    case "WEB_ACTION_GUARD_REJECTED": return record(event, "policy", "浏览器动作被安全护栏阻断", reason ?? "动作未通过 Web 安全护栏", { toolName: tool, decision: data.decision });
    case "WEB_ACTION_SKIPPED_DUPLICATE": return record(event, "warning", "重复动作已跳过", "系统检测到重复 Web 动作并跳过执行", { toolName: tool, actionId: data.actionId });
    case "BROWSER_ACTION_COMPLETED": return record(event, "result", "浏览器动作完成", "受控浏览器动作已完成", { action: data.action, details: data.details });
    case "BROWSER_ACTION_FAILED": return record(event, "warning", "浏览器动作失败", reason ?? "受控浏览器动作返回失败", { action: data.action, failureSummary: data.failureSummary });
    default: return record(event, "system", `系统事件 · ${event.type}`, "未注册事件以技术兼容模式展示", data);
  }
}

export function projectTrace(events: RawTraceEvent[]): DecisionRecord[] {
  return [...events].sort((left, right) => left.sequence - right.sequence).map(projectTraceEvent);
}

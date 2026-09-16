import type { DecisionKind } from "./types";
import type { ObserverAnomalyKind, TerminalReason, TokenUsageSummary, VerificationVerdictName } from "../../types/api";

export const kindLabels: Record<DecisionKind, string> = {
  observation: "观察",
  hypothesis: "假设",
  action: "动作",
  evidence: "证据",
  result: "结果",
  policy: "策略",
  context: "上下文",
  system: "系统",
  warning: "警告",
};

export const terminalReasonLabels: Record<TerminalReason, string> = {
  agent_completed: "Agent 完成任务",
  agent_blocked: "Agent 报告阻塞",
  ended_without_finish: "未调用 finish_task 即结束",
  output_limit: "输出上限耗尽",
  model_error: "模型错误",
  operator_abort: "操作员中止",
  infrastructure_error: "基础设施错误",
};

export const verdictLabels: Record<VerificationVerdictName, string> = {
  reproduced: "复放已复现",
  contradicted: "复放矛盾",
  unverifiable: "无法复放验证",
};

export const observerKindLabels: Record<ObserverAnomalyKind, string> = {
  repeated_action: "重复相同动作",
  repeated_failure: "重复相同失败",
  repeated_read: "重复读取同一目标",
  checkpoint_gap: "长期未检查点",
};

type DisclosureReasonName = "hardcoded_solution" | "targeted_method" | "external_memory";

export const disclosureReasonLabels: Record<DisclosureReasonName, string> = {
  hardcoded_solution: "内置赛题信息和解法",
  targeted_method: "非通用定向解法",
  external_memory: "违规使用外部记忆",
};

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Tsecbench-style cache economics: read share of billed input tokens. */
export function cacheReadShare(usage: TokenUsageSummary): number | undefined {
  const inputLike = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  if (inputLike <= 0) return undefined;
  return Math.round((usage.cacheReadTokens / inputLike) * 100);
}

export function formatTimestamp(timestamp?: string): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatDateTime(timestamp?: string): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function formatConfidence(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = value > 1 ? value : value * 100;
  return `${Math.round(normalized)}%`;
}

export function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? "—"; } catch { return "[无法显示技术数据]"; }
}

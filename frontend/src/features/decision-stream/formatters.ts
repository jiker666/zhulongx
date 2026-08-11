import type { DecisionKind } from "./types";

export const kindLabels: Record<DecisionKind, string> = {
  observation: "观察",
  hypothesis: "假设",
  action: "动作",
  evidence: "证据",
  result: "结果",
  policy: "策略",
  system: "系统",
  warning: "警告",
};

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

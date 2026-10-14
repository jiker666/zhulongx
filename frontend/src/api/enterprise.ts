import { request } from "./client";

/**
 * Typed client for the additive enterprise security-ops API (/v1/enterprise/*):
 * asset graph, exploration intents, finding lifecycle with independent
 * retests, operator approval guard, and IM notification channels.
 */

export interface Company { id: string; name: string; createdAt: string; updatedAt: string }
export type AssetType = "root_domain" | "ip" | "subdomain" | "app" | "service" | "endpoint";
export interface SecOpsAsset {
  id: string; type: AssetType; companyId?: string; key: string;
  url?: string; method?: string; domain?: string; port?: number; title?: string;
  technologies: string[]; runIds: string[]; firstSeenAt: string; lastSeenAt: string;
  tested: number; findingCount: number;
}
export interface Exploration { id: string; goal: string; status: string; createdAt: string; updatedAt: string }
export type IntentStatus = "open" | "running" | "paused" | "done" | "blocked" | "deleted";
export interface Intent {
  id: string; explorationId: string; text: string; origin?: string; owner?: string;
  status: IntentStatus; priority: number; note?: string; deleteReason?: string;
  createdAt: string; updatedAt: string; doneAt?: string;
}
export interface FactNode {
  id: string; explorationId: string; text: string; state: string;
  assetIds: string[]; evidence: string; runId?: string; createdAt: string;
}
export type FindingStatus = "pending" | "in_progress" | "confirmed" | "resolved" | "fixed" | "false_positive" | "ignored" | "duplicate" | "risk_accepted";
export interface Finding {
  id: string; name: string; vulnclass: string; severity: "critical" | "high" | "medium" | "low" | "";
  summary: string; evidence: string; assetIds: string[]; status: FindingStatus;
  runId?: string; worker?: string; createdAt: string; updatedAt: string;
}
export interface Retest {
  id: string; findingId: string; runId?: string;
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  verdict: "" | "reproduced" | "fixed" | "inconclusive";
  summary: string; error: string; createdAt: string; finishedAt?: string;
}
export interface GuardRule {
  id: string; name: string; enabled: boolean; priority: number;
  matchTarget: "tool_name" | "tool_input"; matchType: "string" | "regex";
  pattern: string; action: "allow" | "deny" | "ask"; message: string;
}
export interface GuardPending {
  id: string; ruleId?: string; sessionId: string; toolName: string;
  toolInputSummary: string; createdAt: string; expiresAt: string;
}
export interface GuardAuditEntry { id: string; at: string; ruleId?: string; action: string; toolName: string; sessionId: string; message: string }
export interface NotifyChannel {
  id: string; name: string; kind: "feishu" | "wecom" | "dingtalk" | "webhook"; enabled: boolean;
  config: Record<string, unknown>; mode: "realtime" | "digest";
  minSeverity: "" | "low" | "medium" | "high" | "critical"; ratePerMin: number;
}
export interface NotifyEvent { id: string; kind: string; title: string; body: string; severity: string; createdAt: string }
export interface NotifyDelivery { id: string; eventId: string; channelId: string; status: string; attempts: number; lastError?: string; deliveredAt?: string; createdAt: string }
export interface SecOpsOverview {
  updatedAt: string;
  assets: { total: number; byType: Record<string, number>; endpoints: number; testedEndpoints: number; coverage: number };
  explorations: { total: number; openIntents: number };
  findings: { total: number; bySeverity: Record<string, number>; byStatus: Record<string, number>; retests: number };
  evidence: number;
  ingestedRuns: number;
}
export interface SecOpsGuardSummary { rules: number; pending: number }

export const getSecOpsOverview = (signal?: AbortSignal) =>
  request<{ overview: SecOpsOverview; guard: SecOpsGuardSummary }>("/v1/enterprise/overview", { signal });
export const postSecOpsSync = () => request<{ synced: number }>("/v1/enterprise/sync", { method: "POST" });
export const getSecOpsAssets = (signal?: AbortSignal) =>
  request<{ companies: Company[]; assets: SecOpsAsset[]; updatedAt: string }>("/v1/enterprise/assets", { signal });
export const getSecOpsExplorations = (signal?: AbortSignal) =>
  request<{ explorations: Exploration[]; intents: Intent[]; facts: FactNode[] }>("/v1/enterprise/explorations", { signal });
export const postSecOpsIntent = (body: { text: string; priority?: number; goal?: string }) =>
  request<{ intent: Intent }>("/v1/enterprise/intents", { method: "POST", body: JSON.stringify(body) });
export const patchSecOpsIntent = (id: string, body: { status?: IntentStatus; note?: string; priority?: number; deleteReason?: string }) =>
  request<{ intent: Intent }>(`/v1/enterprise/intents/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const getSecOpsFindings = (signal?: AbortSignal) =>
  request<{ findings: Finding[]; retests: Retest[]; evidence: unknown[] }>("/v1/enterprise/findings", { signal });
export const postSecOpsFinding = (body: { name: string; severity?: string; summary?: string; evidence?: string; assetIds?: string[] }) =>
  request<{ finding: Finding }>("/v1/enterprise/findings", { method: "POST", body: JSON.stringify(body) });
export const patchSecOpsFinding = (id: string, body: { status?: FindingStatus; severity?: string }) =>
  request<{ finding: Finding }>(`/v1/enterprise/findings/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const postSecOpsRetest = (id: string) =>
  request<{ retest: Retest; runId?: string; note?: string }>(`/v1/enterprise/findings/${id}/retest`, { method: "POST" });
export const getGuardRules = (signal?: AbortSignal) =>
  request<{ rules: GuardRule[]; pending: GuardPending[] }>("/v1/enterprise/guard/rules", { signal });
export const postGuardRule = (body: Omit<GuardRule, "id">) =>
  request<{ rule: GuardRule }>("/v1/enterprise/guard/rules", { method: "POST", body: JSON.stringify(body) });
export const patchGuardRule = (id: string, body: Partial<GuardRule>) =>
  request<{ rule: GuardRule }>(`/v1/enterprise/guard/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteGuardRule = (id: string) =>
  request<{ removed: boolean }>(`/v1/enterprise/guard/rules/${id}`, { method: "DELETE" });
export const postGuardPending = (id: string, decision: "approve" | "deny") =>
  request<{ resolved: boolean }>(`/v1/enterprise/guard/pending/${id}`, { method: "POST", body: JSON.stringify({ decision }) });
export const getGuardAudit = (signal?: AbortSignal) =>
  request<{ audit: GuardAuditEntry[] }>("/v1/enterprise/guard/audit", { signal });
export const getNotifyChannels = (signal?: AbortSignal) =>
  request<{ channels: NotifyChannel[]; events: NotifyEvent[]; deliveries: NotifyDelivery[] }>("/v1/enterprise/notify/channels", { signal });
export const postNotifyChannel = (body: { name: string; kind: string; config: Record<string, unknown>; minSeverity?: string; enabled?: boolean }) =>
  request<{ channel: NotifyChannel }>("/v1/enterprise/notify/channels", { method: "POST", body: JSON.stringify(body) });
export const deleteNotifyChannel = (id: string) =>
  request<{ removed: boolean }>(`/v1/enterprise/notify/channels/${id}`, { method: "DELETE" });
export const testNotifyChannel = (id: string) =>
  request<{ delivered: boolean; error?: string }>(`/v1/enterprise/notify/channels/${id}/test`, { method: "POST" });

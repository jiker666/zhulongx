import type { DecisionRecord } from "../decision-stream/types";
export type PolicyDecision = "allowed" | "blocked" | "rejected" | "requires_approval" | "unknown";
export interface PolicyCheckViewModel { key: string; value: unknown }
export interface PolicyDecisionViewModel { id: string; actionId?: string; timestamp?: string; decision: PolicyDecision; reason?: string; reasonCode?: string; checks: PolicyCheckViewModel[]; scope?: unknown; risk?: unknown; ruleId?: string; approvalState?: string; sourceEventId?: string; toolName?: string; signature?: string }

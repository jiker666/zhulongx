import type { DecisionRecord } from "../decision-stream/types";
import { policyReasonLabel } from "./reasonRegistry";
import type { PolicyDecision, PolicyDecisionViewModel } from "./types";

export function projectPolicyDecision(record: DecisionRecord): PolicyDecisionViewModel | undefined {
  if (record.kind !== "policy") return undefined;
  const details = record.technicalDetails ?? {};
  const decision: PolicyDecision = details.allowed === true ? "allowed" : details.allowed === false ? "blocked" : "unknown";
  const checks = Array.isArray(details.checks)
    ? details.checks.flatMap((value, index) => value && typeof value === "object" && "key" in value
      ? [{ key: String((value as Record<string, unknown>).key), value: (value as Record<string, unknown>).value }]
      : [{ key: `check-${index + 1}`, value }])
    : [];
  const reason = typeof details.reason === "string" ? policyReasonLabel(details.reason) : record.summary;
  return {
    id: record.id,
    timestamp: record.timestamp,
    decision,
    checks,
    ...(record.relatedActionId ? { actionId: record.relatedActionId } : {}),
    ...(reason ? { reason } : {}),
    ...(typeof details.reasonCode === "string" ? { reasonCode: details.reasonCode } : {}),
    ...(details.scope === undefined ? {} : { scope: details.scope }),
    ...(details.risk === undefined ? {} : { risk: details.risk }),
    ...(typeof details.ruleId === "string" ? { ruleId: details.ruleId } : {}),
    ...(typeof details.approvalState === "string" ? { approvalState: details.approvalState } : {}),
    sourceEventId: record.id,
    ...(typeof details.toolName === "string" ? { toolName: details.toolName } : {}),
    ...(typeof details.signature === "string" ? { signature: details.signature } : {}),
  };
}

export const POLICY_REASON_LABELS: Record<string, string> = {};
export function policyReasonLabel(reason: string | undefined): string { if (!reason) return "未知策略原因"; return POLICY_REASON_LABELS[reason] ?? reason; }

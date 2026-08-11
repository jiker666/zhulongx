import type { DecisionKind } from "./types";
export const EVENT_REGISTRY: Record<string, { kind: DecisionKind; displayName: string }> = {
  "run.started": { kind: "system", displayName: "Run 已创建" },
  "plan.submitted": { kind: "system", displayName: "执行计划已提交" },
  "policy.decision": { kind: "policy", displayName: "策略判定" },
  "tool.result": { kind: "result", displayName: "工具调用结果" },
  "decision.checkpoint": { kind: "result", displayName: "决策检查点" },
  "hypothesis.updated": { kind: "hypothesis", displayName: "假设更新" },
  "finding.recorded": { kind: "evidence", displayName: "发现记录" },
  "strategy.revised": { kind: "warning", displayName: "策略修订" },
  "run.settled": { kind: "result", displayName: "Run 结算" },
};

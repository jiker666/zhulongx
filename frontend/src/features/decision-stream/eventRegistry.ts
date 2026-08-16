import type { DecisionKind } from "./types";
export const EVENT_REGISTRY: Record<string, { kind: DecisionKind; displayName: string }> = {
  "run.started": { kind: "system", displayName: "Run 已创建" },
  "session.forked": { kind: "context", displayName: "运行分支已创建" },
  "session.resumed": { kind: "context", displayName: "运行已继续" },
  "context.injected": { kind: "context", displayName: "上下文已注入" },
  "model.context": { kind: "context", displayName: "模型可见上下文" },
  "tool.requested": { kind: "action", displayName: "工具动作已请求" },
  "plan.submitted": { kind: "system", displayName: "执行计划已提交" },
  "policy.decision": { kind: "policy", displayName: "策略判定" },
  "tool.result": { kind: "result", displayName: "工具调用结果" },
  "artifact.archive_extracted": { kind: "observation", displayName: "归档已提取" },
  "artifact.searched": { kind: "observation", displayName: "二进制检索完成" },
  "decision.checkpoint": { kind: "result", displayName: "决策检查点" },
  "hypothesis.updated": { kind: "hypothesis", displayName: "假设更新" },
  "finding.recorded": { kind: "evidence", displayName: "发现记录" },
  "strategy.revised": { kind: "warning", displayName: "策略修订" },
  "run.settled": { kind: "result", displayName: "Run 结算" },
};

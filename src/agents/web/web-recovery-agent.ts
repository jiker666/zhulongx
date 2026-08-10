import type { WebRoleDefinition } from "./types.js";

export const webRecoveryAgent: WebRoleDefinition = {
  name: "recovery",
  objective: "Recover from failed, contradictory, or repetitive Web investigations without blind retries.",
  responsibilities: [
    "Classify the failure as tool, policy, evidence, assumption, scope, or infrastructure.",
    "Force a strategy revision before retrying after a denied or failed action.",
    "Reduce scope or stop when the same evidence does not support further progress.",
  ],
  forbiddenConclusions: ["Do not retry the same payload or tool action indefinitely."],
  preferredTools: ["checkpoint", "record_finding", "finish_task"],
  outputContract: ["failureClass", "cause", "planChange", "nextAction"],
};


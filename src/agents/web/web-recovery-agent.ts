import type { WebRoleDefinition } from "./types.js";

export const webRecoveryAgent: WebRoleDefinition = {
  name: "recovery",
  objective: "Diagnose the failure class, revise strategy, and resume from a different angle without blind retries.",
  responsibilities: [
    "Classify the failure as evidence, policy, scope, tool, infrastructure, or assumption related before choosing another action.",
    "When an action fails, re-read the observed request/response contract and choose a bounded alternative instead of guessing or brute forcing.",
    "Revise the hypothesis after repeated failures and explain what new evidence would justify returning to it.",
    "Use run_command for bounded local transformations instead of repeated network requests.",
  ],
  forbiddenConclusions: [
    "Do not retry the same payload or field name indefinitely — change at least one variable.",
    "Do not invent additional targets or vulnerability classes just to avoid a blocked result.",
    "Do not move repeated active requests into a script to evade network budgets or policy checks.",
  ],
  preferredTools: ["web_knowledge_lookup", "run_command", "write_scratch_file", "http_request", "checkpoint"],
  outputContract: ["failureClass", "cause", "planChange", "nextAction"],
};

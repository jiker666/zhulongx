import { webExploitAgent } from "./web-exploit-agent.js";
import { webFingerprintAgent } from "./web-fingerprint-agent.js";
import { webPayloadAgent } from "./web-payload-agent.js";
import { webReconAgent } from "./web-recon-agent.js";
import { webRecoveryAgent } from "./web-recovery-agent.js";
import { webVerificationAgent } from "./web-verification-agent.js";
import { webVulnerabilityAgent } from "./web-vulnerability-agent.js";
import { createWebAgentState, normalizeWebAgentState, roleForPhase } from "./web-state-machine.js";
import type { WebAgentState, WebOrchestratorContext, WebPhase, WebRoleDefinition, WebRoleName } from "./types.js";

const ROLES: Record<WebRoleName, WebRoleDefinition> = {
  recon: webReconAgent,
  fingerprint: webFingerprintAgent,
  vulnerability: webVulnerabilityAgent,
  payload: webPayloadAgent,
  exploit: webExploitAgent,
  verification: webVerificationAgent,
  recovery: webRecoveryAgent,
};

export interface WebWorkflow {
  state: WebAgentState;
  role: WebRoleDefinition;
  phase: WebPhase;
  context: string;
}

export class WebOrchestrator {
  createWorkflow(context: WebOrchestratorContext): WebWorkflow {
    // Seed from the persisted phase state so a resumed or progressed run never resets
    // to a fresh INIT/RECON; fall back to a new INIT state only when none exists.
    const state = normalizeWebAgentState(context.run.webAgent, createWebAgentState());
    return this.workflow(context, state);
  }

  workflow(context: WebOrchestratorContext, state: WebAgentState): WebWorkflow {
    const role = ROLES[state.activeRole];
    return { state, role, phase: state.phase, context: this.renderContext(context, state, role) };
  }

  renderContext(context: WebOrchestratorContext, state: WebAgentState, role = ROLES[state.activeRole]): string {
    const recent = (context.recentEvents ?? []).slice(-6).map((event) => `${event.type}: ${JSON.stringify(event.data)}`);
    return [
      "WEB AGENT ORCHESTRATION",
      `Current phase: ${state.phase}`,
      `Active role: ${role.name}`,
      `Objective: ${role.objective}`,
      `Responsibilities: ${role.responsibilities.join(" | ")}`,
      `Forbidden conclusions: ${role.forbiddenConclusions.join(" | ")}`,
      `Preferred registered tools: ${role.preferredTools.join(", ")}`,
      `Required output fields: ${role.outputContract.join(", ")}`,
      `Task category: ${context.task.metadata.category ?? "Web"}`,
      recent.length > 0 ? `Recent runtime events:\n${recent.join("\n")}` : "Recent runtime events: none",
      "Advance phases only when the current phase has evidence-backed completion criteria. All actions remain subject to PolicyEngine, scope, budgets, and registered tools.",
    ].join("\n");
  }

  roleForPhase(phase: WebPhase): WebRoleDefinition {
    return ROLES[roleForPhase(phase)];
  }
}

export function renderWebOrchestrationContext(context: WebOrchestratorContext, nextPhase?: WebPhase): string {
  const workflow = new WebOrchestrator().createWorkflow(context);
  const phaseHistory = workflow.state.history.slice(-3)
    .map((record) => `${record.phase}${record.completedAt ? "" : " (active)"}`)
    .join(" -> ");
  const nextLine = nextPhase
    ? `Next recommended phase: ${nextPhase}`
    : "Next recommended phase: stay in current phase";
  return `${workflow.context}\nPhase history (recent): ${phaseHistory}\n${nextLine}`;
}

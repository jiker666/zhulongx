import { newId } from "./state.js";
import type { WebReasoningState, WebRole, WebRoleCoordinationState, WebRoleObjective, WebRoleResult } from "./types.js";
import type { WebGraphQuery } from "./graph/query.js";

const ROLE_OBJECTIVES: Record<Exclude<WebRole, "coordinator">, { objective: string; expectedOutputs: WebRoleObjective["expectedOutputs"] }> = {
  recon: { objective: "Map authorized Web surface using existing bounded observations", expectedOutputs: ["observation", "action_proposal"] },
  fingerprint: { objective: "Classify technologies only from supported response evidence", expectedOutputs: ["observation", "hypothesis_update"] },
  js_analysis: { objective: "Review supplied JavaScript text for explicit endpoint references", expectedOutputs: ["observation", "action_proposal"] },
  behavior_analysis: { objective: "Compare already collected bounded responses", expectedOutputs: ["observation", "hypothesis_update"] },
  browser: { objective: "Collect controlled DOM and network evidence within the authorized origin scope", expectedOutputs: ["observation", "action_proposal"] },
  verification: { objective: "Trace and verify an existing candidate without new exploration", expectedOutputs: ["verification_result", "blocked"] },
};

export class WebRoleCoordinator {
  constructor(private readonly state: WebReasoningState, private readonly graph: WebGraphQuery) {}
  assign(remainingRounds: number): WebRoleObjective {
    const coordination = this.ensureState(); const role = this.selectRole(remainingRounds); const definition = ROLE_OBJECTIVES[role];
    const nodes = role === "recon" ? this.graph.findUnexploredEndpoints() : role === "fingerprint" ? this.graph.findTechnologies() : [];
    const objective: WebRoleObjective = { id: newId("objective"), role, objective: definition.objective, targetNodeIds: nodes.map((node) => node.id).slice(0, 8), hypothesisIds: this.state.unresolvedHypothesisIds.slice(0, 8), evidenceIds: this.state.observations.flatMap((item) => item.evidenceIds).slice(-8), expectedOutputs: definition.expectedOutputs, prohibitedActions: ["direct tool execution", "direct graph mutation", "unsupported vulnerability conclusion"], priority: role === "verification" ? 100 : 50, ...(remainingRounds <= this.state.budget.finalizationReserve ? { deadlineRound: remainingRounds } : {}) };
    if (!coordination.objectiveQueue.some((item) => item.objective === objective.objective)) coordination.objectiveQueue.push(objective);
    coordination.activeRole = role; coordination.updatedAt = new Date().toISOString(); return objective;
  }
  complete(objective: WebRoleObjective, result: Omit<WebRoleResult, "objectiveId" | "role" | "createdAt">): void { const coordination = this.ensureState(); const completed: WebRoleResult = { ...result, objectiveId: objective.id, role: objective.role, createdAt: new Date().toISOString() }; coordination.results.push(completed); coordination.results = coordination.results.slice(-24); coordination.objectiveQueue = coordination.objectiveQueue.filter((item) => item.id !== objective.id); if (result.status === "completed") coordination.completedObjectiveIds.push(objective.id); if (result.status === "blocked" || result.status === "no_progress") coordination.blockedObjectiveIds.push(objective.id); if (result.status === "no_progress") coordination.noProgressCount += 1; }
  renderObjective(objective: WebRoleObjective): string { return JSON.stringify({ role_coordination: { role: objective.role, objective: objective.objective, target_node_ids: objective.targetNodeIds, expected_outputs: objective.expectedOutputs, prohibited_actions: objective.prohibitedActions } }, null, 2); }
  private ensureState(): WebRoleCoordinationState { this.state.roleCoordination ??= { schemaVersion: 1, activeRole: "coordinator", objectiveQueue: [], completedObjectiveIds: [], blockedObjectiveIds: [], results: [], roleSwitchCount: 0, noProgressCount: 0, updatedAt: new Date().toISOString() }; return this.state.roleCoordination; }
  private selectRole(remainingRounds: number): Exclude<WebRole, "coordinator"> { if (this.state.knowledgeGraph?.nodes.some((node) => node.type === "candidate" && node.status === "active")) return "verification"; if (remainingRounds <= this.state.budget.finalizationReserve) return "verification"; if (this.state.browser?.sessions.length === 0 && this.state.browser?.capability.available !== false) return "browser"; if (this.state.observations.some((item) => item.type === "artifact") && (this.state.webIntelligence?.javascriptAnalysisSummaries.length ?? 0) === 0) return "js_analysis"; if ((this.state.webIntelligence?.responseSnapshots.length ?? 0) >= 2) return "behavior_analysis"; if (this.graph.findUnexploredEndpoints().length > 0) return "recon"; if (this.graph.findTechnologies().length === 0) return "fingerprint"; return "behavior_analysis"; }
}

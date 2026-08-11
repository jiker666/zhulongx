import { newId } from "./state.js";
import type { WebHypothesis, WebHypothesisCategory, WebReasoningState } from "./types.js";

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

export class HypothesisManager {
  constructor(private readonly state: WebReasoningState, private readonly max = 40) {}
  create(input: Pick<WebHypothesis, "category" | "title" | "statement" | "priority" | "requiredEvidence" | "sourceObservationIds">, now = new Date().toISOString()): WebHypothesis {
    const normalized = input.statement.trim().toLowerCase();
    const existing = this.state.hypotheses.find((item) => item.statement.trim().toLowerCase() === normalized && item.status !== "rejected");
    if (existing) return existing;
    const hypothesis: WebHypothesis = { ...input, id: newId("hyp"), status: "created", confidence: 0.2, supportingEvidenceIds: [], contradictingEvidenceIds: [], attemptedActionIds: [], createdAt: now, updatedAt: now };
    this.state.hypotheses.push(hypothesis);
    this.state.unresolvedHypothesisIds.push(hypothesis.id);
    if (this.state.hypotheses.length > this.max) this.state.hypotheses.splice(0, this.state.hypotheses.length - this.max);
    return hypothesis;
  }
  queue(id: string): void { this.updateStatus(id, "queued"); }
  startTesting(id: string, actionId?: string): void { const item = this.updateStatus(id, "testing"); if (item && actionId) item.attemptedActionIds = [...new Set([...item.attemptedActionIds, actionId])]; }
  addSupportingEvidence(id: string, evidenceId: string): void { this.attach(id, evidenceId, true); }
  addContradictingEvidence(id: string, evidenceId: string): void { this.attach(id, evidenceId, false); }
  updateConfidence(id: string, delta: number): void { const item = this.get(id); if (item) { item.confidence = clamp(item.confidence + delta); item.updatedAt = new Date().toISOString(); } }
  confirm(id: string): boolean {
    const item = this.get(id); if (!item || item.supportingEvidenceIds.length === 0 || item.confidence < 0.8) return false;
    item.status = "confirmed"; item.closedAt = new Date().toISOString(); this.state.confirmedHypothesisIds = [...new Set([...this.state.confirmedHypothesisIds, id])]; this.removeUnresolved(id); return true;
  }
  reject(id: string, reason = "Evidence contradicted the hypothesis"): void { const item = this.updateStatus(id, "rejected"); if (item) { item.requiredEvidence = [...item.requiredEvidence, reason.slice(0, 200)]; this.state.rejectedHypothesisIds.push(id); this.removeUnresolved(id); } }
  block(id: string): void { this.updateStatus(id, "blocked"); }
  expire(id: string): void { this.updateStatus(id, "expired"); this.removeUnresolved(id); }
  private get(id: string): WebHypothesis | undefined { return this.state.hypotheses.find((item) => item.id === id); }
  private updateStatus(id: string, status: WebHypothesis["status"]): WebHypothesis | undefined { const item = this.get(id); if (item) { item.status = status; item.updatedAt = new Date().toISOString(); } return item; }
  private attach(id: string, evidenceId: string, supporting: boolean): void { const item = this.get(id); if (!item) return; const target = supporting ? item.supportingEvidenceIds : item.contradictingEvidenceIds; if (!target.includes(evidenceId)) target.push(evidenceId); item.confidence = clamp(item.confidence + (supporting ? 0.15 : -0.2)); item.status = supporting ? "supported" : "weakened"; item.updatedAt = new Date().toISOString(); }
  private removeUnresolved(id: string): void { this.state.unresolvedHypothesisIds = this.state.unresolvedHypothesisIds.filter((item) => item !== id); }
}

export function categoryForObservation(): WebHypothesisCategory { return "surface_mapping"; }

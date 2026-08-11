import { newId } from "./state.js";
import type { WebObservation, WebObservationType, WebReasoningState } from "./types.js";

export class ObservationManager {
  constructor(private readonly state: WebReasoningState, private readonly max = 80) {}

  add(input: Omit<WebObservation, "id" | "createdAt" | "updatedAt">, now = new Date().toISOString()): WebObservation {
    const existing = this.findByNormalizedKey(input.normalizedKey);
    if (existing) {
      existing.summary = input.summary.slice(0, 500);
      existing.confidence = Math.max(existing.confidence, input.confidence);
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...input.evidenceIds])];
      existing.updatedAt = now;
      return existing;
    }
    const observation: WebObservation = { ...input, id: newId("obs"), summary: input.summary.slice(0, 500), createdAt: now, updatedAt: now };
    this.state.observations.push(observation);
    if (this.state.observations.length > this.max) this.state.observations.splice(0, this.state.observations.length - this.max);
    return observation;
  }

  findByNormalizedKey(key: string): WebObservation | undefined { return this.state.observations.find((item) => item.normalizedKey === key); }
  attachEvidence(id: string, evidenceId: string): void {
    const observation = this.state.observations.find((item) => item.id === id);
    if (observation) observation.evidenceIds = [...new Set([...observation.evidenceIds, evidenceId])];
  }
  listRecent(limit = 10): WebObservation[] { return this.state.observations.slice(-Math.max(0, limit)); }
  listByType(type: WebObservationType): WebObservation[] { return this.state.observations.filter((item) => item.type === type); }
}

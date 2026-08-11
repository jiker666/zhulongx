import type { EvidenceRecord } from "../../types.js";
import type { WebObservation, WebReasoningState } from "../types.js";
import { WebKnowledgeGraph } from "./graph.js";

export class WebGraphProjector {
  constructor(private readonly state: WebReasoningState, private readonly graph: WebKnowledgeGraph) {}
  projectObservation(observation: WebObservation, evidence: EvidenceRecord): void {
    const refs = { evidenceIds: [evidence.id], observationIds: [observation.id] };
    if (observation.type === "url" || observation.type === "endpoint" || observation.type === "target") {
      const endpoint = this.graph.upsertNode({ type: observation.type === "target" ? "target" : "endpoint", key: observation.normalizedKey, label: observation.summary, ...refs, confidence: observation.confidence });
      if (endpoint) this.graph.upsertNode({ type: "url", key: observation.normalizedKey, label: observation.summary, ...refs, confidence: observation.confidence });
    } else if (observation.type === "technology") {
      this.graph.upsertNode({ type: "technology", key: observation.normalizedKey, label: observation.summary, ...refs, confidence: observation.confidence });
    } else if (observation.type === "response" || observation.type === "tool_result" || observation.type === "error_signal") {
      this.graph.upsertNode({ type: "response", key: observation.normalizedKey, label: observation.summary, ...refs, confidence: observation.confidence });
    } else if (observation.type === "parameter") {
      this.graph.upsertNode({ type: "parameter", key: observation.normalizedKey, label: observation.summary, ...refs, confidence: observation.confidence });
    }
    this.graph.state.statistics.projectionCount += 1;
  }
  projectCandidate(candidateId: string, evidenceIds: string[]): void {
    const candidate = this.graph.upsertNode({ type: "candidate", key: candidateId, label: "Candidate", evidenceIds, confidence: 0.5 });
    for (const evidenceId of evidenceIds) { const evidenceNode = this.graph.upsertNode({ type: "verification", key: `evidence:${evidenceId}`, label: "Evidence reference", evidenceIds: [evidenceId], confidence: 0.5 }); if (candidate && evidenceNode) this.graph.upsertEdge({ type: "supports", fromNodeId: evidenceNode.id, toNodeId: candidate.id, evidenceIds: [evidenceId] }); }
  }
}

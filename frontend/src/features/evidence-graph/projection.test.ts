import { describe, expect, it } from "vitest";
import { layoutEvidenceGraph } from "./layout";
import { projectEvidenceGraph } from "./projection";
import type { EvidenceGraphInput } from "./types";

const base = (events: EvidenceGraphInput["rawEvents"]): EvidenceGraphInput => ({ state: { id: "r", status: "completed", phase: "done", task: { task: "x", metadata: {}, attachments: [] }, createdAt: "2026-01-01", updatedAt: "2026-01-01", findings: [{ id: "f1", title: "Finding", severity: "info", confidence: 0.8, evidence: ["e1"] }], lessons: [], hypotheses: [{ id: "h1", statement: "Supported", status: "supported", evidence: ["e1"] }], strategyRevisions: [], turns: 1, toolCalls: 1, httpRequests: 0, tcpSessions: 0, evidence: [{ id: "e1", summary: "Response", source: "tool", lifecycle: "evaluated", actionIds: ["a1"], hypothesisIds: ["h1"] }] }, rawEvents: events });

describe("evidence graph projection", () => {
  it("deduplicates stable nodes and edges and lays them out deterministically", () => {
    const events = [{ sequence: 2, timestamp: "2026-01-01", type: "finding.recorded", data: { id: "f1", evidence: ["e1"] } }, { sequence: 1, timestamp: "2026-01-01", type: "policy.decision", data: { toolCallId: "a1", toolName: "http_request", allowed: true } }];
    const first = layoutEvidenceGraph(projectEvidenceGraph(base(events)));
    const second = layoutEvidenceGraph(projectEvidenceGraph(base([...events].reverse())));
    expect(first.nodes.map((node) => node.id)).toEqual(["action:a1", "evidence:e1", "finding:f1", "hypothesis:h1"]);
    expect(first.edges.map((edge) => `${edge.source}->${edge.kind}->${edge.target}`)).toEqual(["action:a1->produced->evidence:e1", "evidence:e1->supports->finding:f1", "evidence:e1->supports->hypothesis:h1"]);
    expect(first.positions).toEqual(second.positions);
  });
  it("does not infer a relation from text without IDs and redacts metadata", () => {
    const graph = projectEvidenceGraph(base([{ sequence: 1, timestamp: "2026-01-01", type: "unknown", data: { message: "same words", authorization: "Bearer secret" } }]));
    expect(graph.edges).toHaveLength(2);
    expect(JSON.stringify(graph)).not.toContain("secret");
  });
  it("skips unsupported web graph node kinds without failing projection", () => {
    const state = base([]).state; state.findings = []; state.evidence = []; state.hypotheses = []; state.webReasoning = { observations: [], hypotheses: [], actions: [], knowledgeGraph: { nodes: [{ id: "n1", type: "unknown", key: "x", label: "x", attributes: {}, evidenceIds: [], observationIds: [], confidence: 0.5, firstSeenAt: "x", lastSeenAt: "x", status: "active" }], edges: [] } };
    expect(projectEvidenceGraph({ state, rawEvents: [] })).toEqual({ nodes: [], edges: [] });
  });
  it("projects candidate and verification IDs only when the evidence carries them", () => {
    const state = base([]).state; state.evidence![0].candidateIds = ["c1"]; state.evidence![0].verificationIds = ["v1"];
    const graph = projectEvidenceGraph({ state, rawEvents: [] });
    expect(graph.nodes.map((node) => node.id)).toContain("candidate:c1");
    expect(graph.nodes.map((node) => node.id)).toContain("verification:v1");
    expect(graph.edges.map((edge) => edge.kind)).toEqual(["supports", "supports", "supports", "validates"]);
  });
});

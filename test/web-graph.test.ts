import { describe, expect, it } from "vitest";
import { WebKnowledgeGraph, normalizeGraphKey } from "../src/web-reasoning/graph/graph.js";
import { WebGraphQuery } from "../src/web-reasoning/graph/query.js";
import { WebGraphProjector } from "../src/web-reasoning/graph/projector.js";
import { checkAndRepairGraph } from "../src/web-reasoning/graph/integrity.js";
import { createInitialWebReasoningState } from "../src/web-reasoning/state.js";
import { WebRoleCoordinator } from "../src/web-reasoning/role-coordinator.js";
import type { EvidenceRecord } from "../src/types.js";

function evidence(id = "ev_1"): EvidenceRecord { const now = new Date().toISOString(); return { id, summary: "bounded response", source: "tool", lifecycle: "created", observationIds: [], hypothesisIds: [], actionIds: [], candidateIds: [], verificationIds: [], createdAt: now, updatedAt: now }; }

describe("Web Knowledge Graph", () => {
  it("normalizes URLs, default ports, fragments, and query order", () => {
    expect(normalizeGraphKey("url", "HTTPS://EXAMPLE.TEST:443/a?z=2&a=1#fragment")).toBe("https://example.test/a?a=1&z=2");
    expect(normalizeGraphKey("endpoint", "http://EXAMPLE.TEST:80/login#x")).toBe("http://example.test/login");
  });

  it("merges duplicate nodes and edges without creating self-loops", () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10).knowledgeGraph!;
    const graph = new WebKnowledgeGraph(state);
    const endpoint = graph.upsertNode({ type: "endpoint", key: "https://lab.test/login?b=2&a=1", label: "login", evidenceIds: ["ev_1"] });
    const same = graph.upsertNode({ type: "endpoint", key: "https://LAB.TEST/login?a=1&b=2#fragment", label: "login again", evidenceIds: ["ev_2"] });
    expect(same.id).toBe(endpoint.id);
    const response = graph.upsertNode({ type: "response", key: "response:1", label: "200", evidenceIds: ["ev_1"] });
    expect(graph.upsertEdge({ type: "returns", fromNodeId: endpoint.id, toNodeId: response.id, evidenceIds: ["ev_1"] })).toBeDefined();
    expect(graph.upsertEdge({ type: "returns", fromNodeId: endpoint.id, toNodeId: response.id, evidenceIds: ["ev_2"] })?.evidenceIds).toEqual(["ev_1", "ev_2"]);
    expect(graph.upsertEdge({ type: "returns", fromNodeId: endpoint.id, toNodeId: endpoint.id })).toBeUndefined();
  });

  it("projects observations and supports graph queries", () => {
    const reasoning = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const graph = new WebKnowledgeGraph(reasoning.knowledgeGraph!);
    const projector = new WebGraphProjector(reasoning, graph);
    const observation = { id: "obs_1", type: "endpoint" as const, summary: "Login endpoint", source: "tool" as const, evidenceIds: ["ev_1"], confidence: 0.9, normalizedKey: "https://lab.test/login", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    projector.projectObservation(observation, evidence());
    const query = new WebGraphQuery(graph.state);
    expect(query.findEndpoints()).toHaveLength(1);
    expect(query.findUnsupportedNodes()).toHaveLength(0);
  });

  it("repairs invalid graph edges and reports integrity warnings", () => {
    const reasoning = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const graph = reasoning.knowledgeGraph!;
    graph.edges.push({ id: "bad", type: "returns", fromNodeId: "missing", toNodeId: "missing2", attributes: {}, evidenceIds: ["missing-evidence"], confidence: 2, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), status: "active" });
    const result = checkAndRepairGraph(graph, reasoning, [evidence()]);
    expect(result.repaired).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("assigns a sequential role objective and keeps role output non-executing", () => {
    const reasoning = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const graph = new WebKnowledgeGraph(reasoning.knowledgeGraph!);
    const endpoint = graph.upsertNode({ type: "endpoint", key: "https://lab.test/", label: "root", evidenceIds: ["ev_1"] });
    const role = new WebRoleCoordinator(reasoning, new WebGraphQuery(graph.state));
    const objective = role.assign(8);
    expect(objective.role).toBe("recon");
    expect(objective.targetNodeIds).toContain(endpoint.id);
    role.complete(objective, { status: "completed", rationaleSummary: "bounded", observationIds: [], evidenceIds: [], proposedActions: [] });
    expect(reasoning.roleCoordination?.completedObjectiveIds).toContain(objective.id);
  });
});

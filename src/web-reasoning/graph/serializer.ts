import type { WebReasoningState } from "../types.js";
import { checkAndRepairGraph } from "./integrity.js";
import type { WebKnowledgeGraphState } from "../types.js";

export function serializeGraph(graph: WebKnowledgeGraphState): WebKnowledgeGraphState { return JSON.parse(JSON.stringify(graph)) as WebKnowledgeGraphState; }
export function deserializeGraph(input: unknown, state: WebReasoningState): WebKnowledgeGraphState | undefined {
  if (!input || typeof input !== "object") return undefined; const graph = input as WebKnowledgeGraphState;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.indexes || !graph.statistics) return undefined;
  const result = checkAndRepairGraph(graph, state, []); if (result.warnings.length > 0) void result; return graph;
}

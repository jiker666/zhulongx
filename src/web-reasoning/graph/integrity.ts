import type { EvidenceRecord } from "../../types.js";
import type { WebReasoningState } from "../types.js";
import type { WebKnowledgeGraphState } from "../types.js";

export interface WebGraphIntegrityResult { valid: boolean; warnings: string[]; repaired: boolean; }
export function checkAndRepairGraph(graph: WebKnowledgeGraphState, state: WebReasoningState, evidence: readonly EvidenceRecord[] = []): WebGraphIntegrityResult {
  const warnings: string[] = []; let repaired = false; const nodeIds = new Set(graph.nodes.map((node) => node.id)); const evidenceIds = new Set(evidence.map((item) => item.id));
  const seenNodes = new Set<string>(); graph.nodes = graph.nodes.filter((node) => { const key = `${node.type}:${node.key}`; if (seenNodes.has(key)) { warnings.push(`duplicate node ${key}`); repaired = true; return false; } seenNodes.add(key); return true; });
  graph.edges = graph.edges.filter((edge) => { if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) { warnings.push(`invalid edge ${edge.id}`); repaired = true; return false; } const missing = edge.evidenceIds.filter((id) => evidence.length > 0 && !evidenceIds.has(id)); if (missing.length > 0) { warnings.push(`missing evidence on edge ${edge.id}`); edge.evidenceIds = edge.evidenceIds.filter((id) => evidenceIds.has(id)); repaired = true; } return true; });
  for (const node of graph.nodes) { if (node.confidence < 0 || node.confidence > 1) { node.confidence = Math.max(0, Math.min(1, node.confidence)); warnings.push(`invalid confidence on node ${node.id}`); repaired = true; } }
  graph.indexes.nodeByKey = Object.fromEntries(graph.nodes.map((node) => [`${node.type}:${node.key}`, node.id])); graph.indexes.edgesByFrom = {}; graph.indexes.edgesByTo = {}; for (const edge of graph.edges) { (graph.indexes.edgesByFrom[edge.fromNodeId] ??= []).push(edge.id); (graph.indexes.edgesByTo[edge.toNodeId] ??= []).push(edge.id); }
  graph.statistics.nodeCount = graph.nodes.length; graph.statistics.edgeCount = graph.edges.length; graph.statistics.integrityWarnings += warnings.length; if (warnings.length > 0) graph.degraded = true; if (state.knowledgeGraph !== graph) state.knowledgeGraph = graph; return { valid: warnings.length === 0, warnings, repaired };
}

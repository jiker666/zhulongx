import type { EvidenceGraph } from "./types";
const layers = { target: 0, service: 0, endpoint: 1, artifact: 1, action: 2, evidence: 3, hypothesis: 4, finding: 5, candidate: 5, verification: 6 } as const;
export interface PositionedGraph extends EvidenceGraph { positions: Record<string, { x: number; y: number }> }
export function layoutEvidenceGraph(graph: EvidenceGraph): PositionedGraph {
  const counters = new Map<number, number>(); const positions: Record<string, { x: number; y: number }> = {};
  for (const node of graph.nodes) { const layer = layers[node.kind]; const index = counters.get(layer) ?? 0; counters.set(layer, index + 1); positions[node.id] = { x: layer * 250, y: index * 138 }; }
  return { ...graph, positions };
}

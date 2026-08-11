import { useCallback, useMemo, useState } from "react";
import { Background, MarkerType, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NODE_REGISTRY } from "./nodeRegistry";
import { layoutEvidenceGraph, type PositionedGraph } from "./layout";
import type { EvidenceGraphNode } from "./types";

interface GraphNodeData extends Record<string, unknown> { graphNode: EvidenceGraphNode; selected: boolean; dimmed: boolean; onSelect: (id: string) => void }
function GraphNodeCard({ data }: NodeProps<Node<GraphNodeData>>) {
  const node = data.graphNode; const registry = NODE_REGISTRY[node.kind];
  return <div className={`evidence-graph-node state-${node.state} ${data.selected ? "selected" : ""} ${data.dimmed ? "dimmed" : ""}`} data-testid="evidence-graph-node" data-node-kind={node.kind} data-entity-id={node.id} role="button" tabIndex={0} onClick={() => data.onSelect(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); data.onSelect(node.id); } }} style={{ "--node-accent": registry.color } as React.CSSProperties}><span className="graph-node-kind">{registry.label}</span><strong title={node.label}>{node.label}</strong><span className="graph-node-state">{node.state.toUpperCase()}</span></div>;
}
const nodeTypes = { evidenceGraphNode: GraphNodeCard };

function GraphCanvas({ model, selectedId, onSelect }: { model: PositionedGraph; selectedId?: string; onSelect: (id: string) => void }) {
  const [instance, setInstance] = useState<ReturnType<typeof useReactFlow>>();
  const neighbors = useMemo(() => { const ids = new Set<string>(); if (selectedId) { ids.add(selectedId); for (const edge of model.edges) if (edge.source === selectedId) ids.add(edge.target); else if (edge.target === selectedId) ids.add(edge.source); } return ids; }, [model.edges, selectedId]);
  const nodes = useMemo<Node<GraphNodeData>[]>(() => model.nodes.map((item) => ({ id: item.id, type: "evidenceGraphNode", position: model.positions[item.id], data: { graphNode: item, selected: item.id === selectedId, dimmed: Boolean(selectedId) && !neighbors.has(item.id), onSelect } })), [model, neighbors, onSelect, selectedId]);
  const edges = useMemo<Edge[]>(() => model.edges.map((item) => ({ id: item.id, source: item.source, target: item.target, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, color: item.kind === "contradicts" ? "#b45151" : "#9d988f" }, style: { stroke: item.kind === "contradicts" ? "#b45151" : "#9d988f", opacity: selectedId && item.source !== selectedId && item.target !== selectedId ? 0.25 : 0.9, strokeDasharray: item.kind === "related_to" ? "5 4" : undefined } })), [model.edges, selectedId]);
  const fit = useCallback(() => instance?.fitView({ padding: 0.2, duration: 250 }), [instance]);
  const reset = useCallback(() => { instance?.setViewport({ x: 40, y: 40, zoom: 0.85 }, { duration: 250 }); }, [instance]);
  return <div className="evidence-graph-shell"><div className="graph-toolbar"><strong>Evidence Graph</strong><span className="graph-count">{model.nodes.length} nodes · {model.edges.length} edges</span><div className="graph-toolbar-actions"><button type="button" onClick={fit}>适应视图</button><button type="button" onClick={reset}>重置视图</button></div></div><div className="evidence-graph-canvas"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setInstance} fitView fitViewOptions={{ padding: 0.18 }} minZoom={0.15} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} elementsSelectable zoomOnDoubleClick={false} aria-label="Evidence Graph"><Background color="#d8d4cb" gap={28} size={1} /></ReactFlow></div></div>;
}

export function EvidenceGraphView({ graph, selectedId, onSelect }: { graph: PositionedGraph; selectedId?: string; onSelect: (id: string) => void }) {
  if (graph.nodes.length === 0) return <div className="graph-empty state-panel"><strong>当前 Run 尚未形成可视化证据关系</strong><span>只有真实实体和明确关联会进入证据图。</span></div>;
  return <GraphCanvas model={graph} selectedId={selectedId} onSelect={onSelect} />;
}

export { layoutEvidenceGraph };

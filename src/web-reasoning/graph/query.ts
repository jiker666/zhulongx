import type { WebGraphEdge, WebGraphEdgeType, WebGraphNode, WebGraphNodeType, WebKnowledgeGraphState } from "../types.js";
import { WebKnowledgeGraph, normalizeGraphKey } from "./graph.js";

export interface WebGraphPath { nodeIds: string[]; edgeIds: string[]; }
export class WebGraphQuery {
  private readonly graph: WebKnowledgeGraph;
  constructor(readonly state: WebKnowledgeGraphState) { this.graph = new WebKnowledgeGraph(state); }
  findNodesByType(type: WebGraphNodeType): WebGraphNode[] { return this.state.nodes.filter((node) => node.type === type && node.status === "active"); }
  findNodeByKey(type: WebGraphNodeType, key: string): WebGraphNode | undefined { const normalized = `${type}:${normalizeGraphKey(type, key)}`; const id = this.state.indexes.nodeByKey[normalized]; return id ? this.graph.getNode(id) : undefined; }
  getOutgoing(nodeId: string, type?: WebGraphEdgeType): WebGraphEdge[] { return this.state.edges.filter((edge) => edge.fromNodeId === nodeId && edge.status === "active" && (!type || edge.type === type)); }
  getIncoming(nodeId: string, type?: WebGraphEdgeType): WebGraphEdge[] { return this.state.edges.filter((edge) => edge.toNodeId === nodeId && edge.status === "active" && (!type || edge.type === type)); }
  getNeighbors(nodeId: string): WebGraphNode[] { const ids = [...this.getOutgoing(nodeId), ...this.getIncoming(nodeId)].map((edge) => edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId); return ids.map((id) => this.graph.getNode(id)).filter((node): node is WebGraphNode => Boolean(node)); }
  findEndpoints(): WebGraphNode[] { return this.findNodesByType("endpoint"); }
  findUnexploredEndpoints(): WebGraphNode[] { return this.findEndpoints().filter((node) => this.getOutgoing(node.id, "returns").length === 0); }
  findParametersForEndpoint(endpointId: string): WebGraphNode[] { return this.getOutgoing(endpointId, "accepts").map((edge) => this.graph.getNode(edge.toNodeId)).filter((node): node is WebGraphNode => Boolean(node)); }
  findTechnologies(): WebGraphNode[] { return this.findNodesByType("technology"); }
  findAuthenticationBoundaries(): WebGraphNode[] { return this.findNodesByType("authentication_boundary"); }
  findCandidateEvidencePaths(candidateId: string): WebGraphPath[] { const candidate = this.graph.getNode(candidateId); if (!candidate) return []; const paths: WebGraphPath[] = []; for (const edge of this.getIncoming(candidateId, "verified_by")) paths.push({ nodeIds: [edge.fromNodeId, edge.toNodeId], edgeIds: [edge.id] }); for (const edge of this.getIncoming(candidateId, "supports")) paths.push({ nodeIds: [edge.fromNodeId, edge.toNodeId], edgeIds: [edge.id] }); return paths; }
  findUnsupportedNodes(): WebGraphNode[] { return this.state.nodes.filter((node) => node.status === "active" && node.evidenceIds.length === 0); }
}

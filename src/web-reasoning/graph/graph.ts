import { newId } from "../state.js";
import type { WebGraphEdge, WebGraphEdgeType, WebGraphNode, WebGraphNodeType, WebKnowledgeGraphState, JsonSafeValue } from "../types.js";

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
export function normalizeGraphKey(type: WebGraphNodeType, key: string): string {
  const value = key.trim();
  if (type !== "url" && type !== "endpoint" && type !== "origin") return value.toLowerCase();
  try {
    const parsed = new URL(value.includes("://") ? value : `http://graph.local${value.startsWith("/") ? value : `/${value}`}`);
    parsed.hostname = parsed.hostname.toLowerCase(); parsed.hash = "";
    if (parsed.port === "80" && parsed.protocol === "http:") parsed.port = "";
    if (parsed.port === "443" && parsed.protocol === "https:") parsed.port = "";
    const entries = [...parsed.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
    parsed.search = ""; for (const [name, item] of entries) parsed.searchParams.append(name, item);
    return type === "endpoint" ? `${parsed.origin}${parsed.pathname}` : parsed.toString();
  } catch { return value.toLowerCase().split("#", 1)[0] ?? value.toLowerCase(); }
}

export class WebKnowledgeGraph {
  constructor(readonly state: WebKnowledgeGraphState, private readonly maxNodes = 250, private readonly maxEdges = 500) {}
  upsertNode(input: { type: WebGraphNodeType; key: string; label: string; attributes?: Record<string, JsonSafeValue>; evidenceIds?: string[]; observationIds?: string[]; confidence?: number }, now = new Date().toISOString()): WebGraphNode {
    const key = normalizeGraphKey(input.type, input.key); const indexKey = `${input.type}:${key}`; const existingId = this.state.indexes.nodeByKey[indexKey]; const existing = existingId ? this.getNode(existingId) : undefined;
    if (existing) { existing.lastSeenAt = now; existing.label = input.label.slice(0, 200); existing.attributes = { ...existing.attributes, ...(input.attributes ?? {}) }; existing.evidenceIds = [...new Set([...existing.evidenceIds, ...(input.evidenceIds ?? [])])].slice(-32); existing.observationIds = [...new Set([...existing.observationIds, ...(input.observationIds ?? [])])].slice(-32); existing.confidence = Math.max(existing.confidence, clamp(input.confidence ?? 0.5)); this.state.statistics.duplicateNodeMerges += 1; this.touch(now); return existing; }
    const node: WebGraphNode = { id: newId("node"), type: input.type, key, label: input.label.slice(0, 200), attributes: input.attributes ?? {}, evidenceIds: [...new Set(input.evidenceIds ?? [])].slice(-32), observationIds: [...new Set(input.observationIds ?? [])].slice(-32), confidence: clamp(input.confidence ?? 0.5), firstSeenAt: now, lastSeenAt: now, status: "active" };
    if (this.state.nodes.length >= this.maxNodes) this.compact();
    if (this.state.nodes.length >= this.maxNodes) { this.state.statistics.integrityWarnings += 1; return node; }
    this.state.nodes.push(node); this.state.indexes.nodeByKey[indexKey] = node.id; this.state.statistics.nodeCount = this.state.nodes.length; this.touch(now); return node;
  }
  upsertEdge(input: { type: WebGraphEdgeType; fromNodeId: string; toNodeId: string; attributes?: Record<string, JsonSafeValue>; evidenceIds?: string[]; confidence?: number }, now = new Date().toISOString()): WebGraphEdge | undefined {
    if (input.fromNodeId === input.toNodeId || !this.getNode(input.fromNodeId) || !this.getNode(input.toNodeId)) { this.state.statistics.integrityWarnings += 1; return undefined; }
    const existing = this.state.edges.find((edge) => edge.type === input.type && edge.fromNodeId === input.fromNodeId && edge.toNodeId === input.toNodeId);
    if (existing) { existing.lastSeenAt = now; existing.attributes = { ...existing.attributes, ...(input.attributes ?? {}) }; existing.evidenceIds = [...new Set([...existing.evidenceIds, ...(input.evidenceIds ?? [])])].slice(-32); existing.confidence = Math.max(existing.confidence, clamp(input.confidence ?? 0.5)); this.state.statistics.duplicateEdgeMerges += 1; this.reindex(); this.touch(now); return existing; }
    if (this.state.edges.length >= this.maxEdges) this.compactEdges();
    if (this.state.edges.length >= this.maxEdges) { this.state.statistics.integrityWarnings += 1; return undefined; }
    const edge: WebGraphEdge = { id: newId("edge"), type: input.type, fromNodeId: input.fromNodeId, toNodeId: input.toNodeId, attributes: input.attributes ?? {}, evidenceIds: [...new Set(input.evidenceIds ?? [])].slice(-32), confidence: clamp(input.confidence ?? 0.5), firstSeenAt: now, lastSeenAt: now, status: "active" };
    this.state.edges.push(edge); this.reindex(); this.touch(now); return edge;
  }
  getNode(id: string): WebGraphNode | undefined { return this.state.nodes.find((node) => node.id === id); }
  getEdge(id: string): WebGraphEdge | undefined { return this.state.edges.find((edge) => edge.id === id); }
  invalidateNode(id: string): void { const node = this.getNode(id); if (!node) return; node.status = "invalidated"; for (const edge of this.state.edges) if (edge.fromNodeId === id || edge.toNodeId === id) edge.status = "invalidated"; this.reindex(); }
  private reindex(): void { this.state.indexes.edgesByFrom = {}; this.state.indexes.edgesByTo = {}; for (const edge of this.state.edges) { (this.state.indexes.edgesByFrom[edge.fromNodeId] ??= []).push(edge.id); (this.state.indexes.edgesByTo[edge.toNodeId] ??= []).push(edge.id); } this.state.statistics.nodeCount = this.state.nodes.length; this.state.statistics.edgeCount = this.state.edges.length; }
  private touch(now: string): void { this.state.updatedAt = now; }
  private compact(): void { const removable = this.state.nodes.findIndex((node) => node.status !== "active" && node.evidenceIds.length === 0); if (removable >= 0) { const [node] = this.state.nodes.splice(removable, 1); if (node) delete this.state.indexes.nodeByKey[`${node.type}:${node.key}`]; this.reindex(); } }
  private compactEdges(): void { const removable = this.state.edges.findIndex((edge) => edge.status !== "active" && edge.evidenceIds.length === 0); if (removable >= 0) this.state.edges.splice(removable, 1); this.reindex(); }
}

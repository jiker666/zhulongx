import type { RunState, TraceEvent } from "../../types/api";
export type GraphNodeKind = "target" | "service" | "endpoint" | "artifact" | "action" | "evidence" | "hypothesis" | "candidate" | "verification" | "finding";
export type GraphNodeState = "unknown" | "observed" | "hypothesized" | "verified" | "rejected" | "blocked" | "failed";
export type GraphEdgeKind = "observed_from" | "produced" | "supports" | "contradicts" | "derived_from" | "validates" | "rejects" | "targets" | "related_to";
export interface EvidenceGraphNode { id: string; kind: GraphNodeKind; label: string; subtitle?: string; state: GraphNodeState; sourceIds: string[]; confidence?: number; metadata?: Record<string, unknown> }
export interface EvidenceGraphEdge { id: string; source: string; target: string; kind: GraphEdgeKind; sourceIds: string[]; confidence?: number }
export interface EvidenceGraph { nodes: EvidenceGraphNode[]; edges: EvidenceGraphEdge[] }
export interface EvidenceGraphInput { state: RunState; rawEvents: Array<{ sequence: number; timestamp: string; type: string; data: unknown }>; timeline?: TraceEvent[] }

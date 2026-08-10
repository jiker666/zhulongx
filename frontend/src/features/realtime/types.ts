import type { RawTraceEvent } from "../decision-stream/types";
export type RunConnectionState = "connecting" | "live" | "reconnecting" | "degraded" | "offline" | "closed";
export interface RealtimeRunEvent { streamVersion: number; runId: string; eventId: string; sequence: number; type: string; timestamp: string; data: unknown }
export interface MergeResult { events: RawTraceEvent[]; gapDetected: boolean; ignored: boolean }

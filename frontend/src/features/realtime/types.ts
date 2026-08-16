import type { RawTraceEvent } from "../decision-stream/types";
import type { TrajectorySource } from "../../types/api";
export type RunConnectionState = "connecting" | "live" | "reconnecting" | "degraded" | "offline" | "closed";
export interface RealtimeRunEvent { streamVersion: number; runId: string; eventId: string; sequence: number; type: string; timestamp: string; source?: TrajectorySource; actor?: string; correlationId?: string; parentSequence?: number; data: unknown }
export interface MergeResult { events: RawTraceEvent[]; gapDetected: boolean; ignored: boolean }

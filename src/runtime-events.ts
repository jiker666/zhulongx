import type { AuditRecord, OrderedRuntimeEvent, RunStatus } from "./types.js";

export interface RuntimeTimelineItem {
  id: string;
  epoch: number;
  seq: number;
  type: string;
  timestamp: string;
  data: unknown;
}

export interface RuntimeEventState {
  sessionId: string;
  lastEpoch: number;
  lastSeq: number;
  status?: RunStatus;
  timeline: RuntimeTimelineItem[];
}

const TERMINAL = new Set<RunStatus>(["completed", "blocked", "failed", "aborted"]);

export function auditRecordToRuntimeEvent(record: AuditRecord, epoch = 1): OrderedRuntimeEvent {
  return {
    sessionId: record.runId,
    runId: record.runId,
    epoch,
    seq: record.sequence,
    type: record.type,
    timestamp: record.timestamp,
    ...(record.source ? { source: record.source } : {}),
    ...(record.actor ? { actor: record.actor } : {}),
    ...(record.correlationId ? { correlationId: record.correlationId } : {}),
    ...(record.parentSequence !== undefined ? { parentSequence: record.parentSequence } : {}),
    data: record.data,
  };
}

function statusFrom(event: OrderedRuntimeEvent, current?: RunStatus): RunStatus | undefined {
  if (event.type === "run.started") return "running";
  if (event.type === "run.error") return "failed";
  if (event.type === "run.recovered_after_restart") return "aborted";
  if (event.type !== "run.settled") return current;
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const status = data.status;
  return typeof status === "string" && ["completed", "blocked", "failed", "aborted"].includes(status)
    ? status as RunStatus
    : current;
}

export function reduceRuntimeEvent(state: RuntimeEventState, event: OrderedRuntimeEvent): RuntimeEventState {
  if (event.sessionId !== state.sessionId || !Number.isSafeInteger(event.epoch) || !Number.isSafeInteger(event.seq) || event.epoch < 1 || event.seq < 1) return state;
  const id = `${event.epoch}:${event.seq}`;
  if (state.timeline.some((item) => item.id === id)) return state;
  const timeline = [...state.timeline, { id, epoch: event.epoch, seq: event.seq, type: event.type, timestamp: event.timestamp, data: event.data }]
    .sort((left, right) => left.epoch - right.epoch || left.seq - right.seq);
  const latest = timeline.at(-1);
  const status = statusFrom(event, state.status);
  return {
    sessionId: state.sessionId,
    lastEpoch: latest?.epoch ?? state.lastEpoch,
    lastSeq: latest?.seq ?? state.lastSeq,
    ...(status ? { status } : {}),
    timeline,
  };
}

export function projectTimeline(events: OrderedRuntimeEvent[]): RuntimeEventState {
  const sessionId = events[0]?.sessionId ?? "";
  return events.reduce(reduceRuntimeEvent, { sessionId, lastEpoch: 0, lastSeq: 0, timeline: [] });
}

export function isSettledRuntimeState(state: RuntimeEventState): boolean {
  return state.status !== undefined && TERMINAL.has(state.status);
}

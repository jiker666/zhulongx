import { describe, expect, it } from "vitest";
import { auditRecordToRuntimeEvent, isSettledRuntimeState, projectTimeline, reduceRuntimeEvent } from "../src/runtime-events.js";
import type { AuditRecord, OrderedRuntimeEvent } from "../src/types.js";

function event(seq: number, type = `event.${seq}`, data: unknown = {}): OrderedRuntimeEvent {
  return { sessionId: "run-1", runId: "run-1", epoch: 1, seq, type, timestamp: `2026-08-12T00:00:0${seq}.000Z`, data };
}

describe("runtime event projection", () => {
  it("orders and deduplicates events deterministically", () => {
    const events = [event(3), event(1, "run.started"), event(2), event(2)];
    const first = projectTimeline(events);
    const second = projectTimeline([...events].reverse());
    expect(first.timeline.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(second.timeline).toEqual(first.timeline);
    expect(first.status).toBe("running");
  });

  it("ignores cross-session delivery and projects terminal status", () => {
    const initial = projectTimeline([event(1, "run.started")]);
    const ignored = reduceRuntimeEvent(initial, { ...event(2), sessionId: "run-other", runId: "run-other" });
    expect(ignored).toBe(initial);
    const settled = reduceRuntimeEvent(initial, event(2, "run.settled", { status: "completed" }));
    expect(settled.status).toBe("completed");
    expect(isSettledRuntimeState(settled)).toBe(true);
  });

  it("converts audit sequence into the shared event contract", () => {
    const record: AuditRecord = { sequence: 7, timestamp: "2026-08-12T00:00:00.000Z", runId: "run-1", type: "tool.result", data: { ok: true }, previousHash: "a", hash: "b" };
    expect(auditRecordToRuntimeEvent(record)).toEqual({ sessionId: "run-1", runId: "run-1", epoch: 1, seq: 7, type: "tool.result", timestamp: record.timestamp, data: { ok: true } });
  });
});

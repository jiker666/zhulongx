import { describe, expect, it } from "vitest";
import { projectTraceEvent } from "./projection";

const event = (type: string, data: unknown, sequence = 1) => ({ sequence, timestamp: "2026-08-10T00:00:00.000Z", type, data });

describe("decision stream semantic projection", () => {
  it("projects known policy events without changing their fact", () => {
    const result = projectTraceEvent(event("policy.decision", { toolName: "http_request", allowed: false, reason: "outside scope" }));
    expect(result).toMatchObject({ kind: "policy", sourceEventType: "policy.decision", policyState: "blocked" });
    expect(result.summary).toContain("outside scope");
  });

  it("keeps tool completion distinct from evidence or verification", () => {
    const result = projectTraceEvent(event("tool.result", { toolName: "http_request", isError: false }));
    expect(result.kind).toBe("result");
    expect(result.summary).toContain("不等同于验证成功");
  });

  it("falls back safely for unknown events", () => {
    const result = projectTraceEvent(event("FUTURE_EVENT", { authorization: "Bearer secret", value: "kept" }));
    expect(result).toMatchObject({ kind: "system", title: "系统事件 · FUTURE_EVENT" });
    expect(result.technicalDetails).toEqual({ authorization: "[redacted]", value: "kept" });
  });

  it("maps confidence values without inventing confidence", () => {
    const result = projectTraceEvent(event("hypothesis.updated", { updates: [], confidenceAfter: 0.78 }));
    expect(result.confidenceAfter).toBe(0.78);
    expect(projectTraceEvent(event("hypothesis.updated", { updates: [] })).confidenceAfter).toBeUndefined();
  });
});

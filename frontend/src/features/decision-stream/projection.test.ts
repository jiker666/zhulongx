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

  it("projects plan step updates with unmet dependency gates", () => {
    const gated = projectTraceEvent(event("plan.steps_updated", { updates: [{ id: "map" }], unmetDependencies: ["map waits on extract (in_progress)"] }));
    expect(gated.kind).toBe("system");
    expect(gated.explanation?.result).toContain("map waits on extract");
    const clear = projectTraceEvent(event("plan.steps_updated", { updates: [{ id: "extract", status: "completed" }] }));
    expect(clear.explanation?.result).toBe("依赖门校验通过");
  });

  it("projects replay verifier verdicts with distinct severity", () => {
    const contradicted = projectTraceEvent(event("verifier.replay", { verdict: "contradicted", replayed: 2, evidence: [] }));
    expect(contradicted.kind).toBe("warning");
    expect(contradicted.title).toBe("复放验证与结论矛盾");
    const reproduced = projectTraceEvent(event("verifier.replay", { verdict: "reproduced", replayed: 1, evidence: [] }));
    expect(reproduced.kind).toBe("result");
    expect(reproduced.explanation?.impact).toContain("复放支撑");
  });

  it("projects observer anomalies as record-only warnings", () => {
    const result = projectTraceEvent(event("observer.anomaly", { kind: "repeated_action", detail: "run_command zsteg a.png", occurrences: 4 }));
    expect(result.kind).toBe("warning");
    expect(result.summary).toContain("×4");
    expect(result.summary).toContain("run_command zsteg a.png");
  });

  it("projects deterministic triage as engine-side observation", () => {
    const result = projectTraceEvent(event("context.triage", { files: 3 }));
    expect(result.kind).toBe("observation");
    expect(result.summary).toContain("3 个附件");
  });
});

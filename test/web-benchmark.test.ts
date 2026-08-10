import { describe, expect, it } from "vitest";
import { buildWebBenchmarkCases, summarizeWebBenchmark } from "../src/agents/web/web-benchmark.js";
import { createWebAgentState, transitionWebPhase } from "../src/agents/web/web-state-machine.js";
import { renderWebOrchestrationContext } from "../src/agents/web/web-orchestrator.js";
import type { NormalizedTask, RunState } from "../src/types.js";

function fakeRun(): RunState {
  const now = new Date().toISOString();
  const task: NormalizedTask = { task: "authorized Web benchmark case", attachments: [], metadata: { category: "Web" } };
  return {
    id: "benchmark-run",
    status: "running",
    phase: "planning",
    task,
    createdAt: now,
    updatedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "benchmark-run",
    scratchRoot: "/tmp/benchmark",
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

describe("Web benchmark", () => {
  it("contains 50 deterministic cases with required category coverage", () => {
    const cases = buildWebBenchmarkCases();
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((item) => item.category))).toEqual(new Set([
      "sql_injection", "file_upload", "ssti", "ssrf", "jwt", "lfi_path_traversal",
      "rce", "node_prototype_pollution", "php_logic", "java_deserialization",
    ]));
    expect(cases.every((item) => item.requiredContracts.includes("web_collect_baseline"))).toBe(true);
  });

  it("accepts the evidence-first Web state path and rejects skipped exploitation", () => {
    let state = createWebAgentState("2026-01-01T00:00:00.000Z");
    for (const phase of ["RECON", "ENUMERATION", "FINGERPRINT", "VULNERABILITY_ANALYSIS", "EXPLOITATION", "FLAG_SEARCH", "VERIFICATION", "COMPLETE"] as const) {
      state = transitionWebPhase(state, phase, `completed ${phase}`, "2026-01-01T00:00:01.000Z");
    }
    expect(state.phase).toBe("COMPLETE");
    expect(() => transitionWebPhase(createWebAgentState(), "EXPLOITATION", "skip recon")).toThrow("Invalid Web phase transition");
  });

  it("renders role contracts into the Web prompt context", () => {
    const context = renderWebOrchestrationContext({ task: fakeRun().task, run: fakeRun() });
    expect(context).toContain("WEB AGENT ORCHESTRATION");
    expect(context).toContain("Current phase: INIT");
    expect(context).toContain("web_collect_baseline");
    expect(context).toContain("PolicyEngine");
  });

  it("reports benchmark metrics and failure reasons deterministically", () => {
    const report = summarizeWebBenchmark([
      { caseId: "web-001", success: true, steps: 8, toolCalls: 10 },
      { caseId: "web-002", success: false, steps: 5, toolCalls: 6, failureReason: "no evidence" },
    ]);
    expect(report).toEqual({
      total: 2,
      successful: 1,
      successRate: 0.5,
      averageSteps: 6.5,
      averageToolCalls: 8,
      failureReasons: { "no evidence": 1 },
    });
  });

  it("aggregates optional runtime reasoning metrics from measured results", () => {
    const report = summarizeWebBenchmark([
      { caseId: "web-001", success: true, steps: 3, toolCalls: 2, webTaskDetected: true, observationsCreated: 2, stateRecoverySuccess: true },
      { caseId: "web-002", success: false, steps: 4, toolCalls: 3, webTaskDetected: false, observationsCreated: 0, stateRecoverySuccess: false },
    ]);
    expect(report.reasoningMetrics).toMatchObject({ webTaskDetectionAccuracy: 0.5, observationsCreated: 1, stateRecoverySuccess: 0.5 });
  });
});

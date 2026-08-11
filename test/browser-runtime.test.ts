import { describe, expect, it } from "vitest";
import { createInitialWebReasoningState } from "../src/web-reasoning/state.js";
import { evaluateNavigation } from "../src/web-reasoning/browser/navigation-guard.js";
import { ControlledBrowserRuntime } from "../src/web-reasoning/browser/runtime.js";
import { defaultBrowserRuntimeConfig } from "../src/web-reasoning/browser/config.js";
import { PolicyEngine } from "../src/policy.js";
import type { RunState } from "../src/types.js";

function fakeRun(): RunState {
  const now = new Date().toISOString();
  return { id: "browser-policy", status: "running", phase: "planning", task: { task: "authorized browser task", attachments: [], metadata: { category: "Web" } }, createdAt: now, updatedAt: now, findings: [], lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false, sandboxNamespace: "browser-policy", scratchRoot: process.cwd(), workspaceMode: "configured", appliedExperienceIds: [], turns: 0, toolCalls: 0, imageObservations: 0, httpRequests: 0, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {}, plan: { goal: "browser", assumptions: [], hypotheses: [], steps: [{ id: "one", objective: "observe", successCriteria: ["evidence"], tools: ["browser"] }] } };
}

describe("controlled browser runtime boundaries", () => {
  it("allows only explicitly scoped HTTP origins and rejects unsafe schemes", () => {
    const scope = { mode: "controlled" as const, workspaceRoot: process.cwd(), allowedHosts: ["127.0.0.1:3000"], allowedPrograms: [] };
    expect(evaluateNavigation({ targetUrl: "http://127.0.0.1:3000/", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("allow");
    expect(evaluateNavigation({ targetUrl: "javascript:alert(1)", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("reject_scheme");
    expect(evaluateNavigation({ targetUrl: "http://127.0.0.1:4000/", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("reject_out_of_scope");
  });

  it("degrades safely when Chromium is unavailable without fabricating a result", async () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 5);
    const scope = { mode: "controlled" as const, workspaceRoot: process.cwd(), allowedHosts: ["127.0.0.1:3000"], allowedPrograms: [] };
    const runtime = new ControlledBrowserRuntime({ runId: "run-test", scope, state: state.browser!, config: { ...defaultBrowserRuntimeConfig, enabled: true } });
    if (!runtime.capability.available) await expect(runtime.execute({ action: "create_session" })).rejects.toThrow("Chromium");
    await runtime.cleanup();
    expect(state.browser?.sessions.every((session) => session.status !== "active")).toBe(true);
  });

  it("keeps browser authorization in PolicyEngine and blocks unsafe browser actions", () => {
    const scope = { mode: "controlled" as const, workspaceRoot: process.cwd(), allowedHosts: ["127.0.0.1:3000"], allowedPrograms: [] };
    const policy = new PolicyEngine(scope, { maxToolCalls: 10, maxActionsWithoutCheckpoint: 5, maxRepeatedAction: 2 } as never);
    expect(policy.evaluate("browser", { action: "capture_dom" }, fakeRun()).allowed).toBe(true);
    expect(policy.evaluate("browser", { action: "assert_state", expectedText: "done" }, fakeRun()).allowed).toBe(true);
    expect(policy.evaluate("browser", { action: "evaluate" }, fakeRun()).allowed).toBe(false);
  });
});

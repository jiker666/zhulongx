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
  it("allows any HTTP(S) origin and rejects only unsafe schemes or malformed URLs", () => {
    const scope = { mode: "controlled" as const, workspaceRoot: process.cwd(), allowedHosts: ["127.0.0.1:3000"], allowedPrograms: [] };
    expect(evaluateNavigation({ targetUrl: "http://127.0.0.1:3000/", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("allow");
    expect(evaluateNavigation({ targetUrl: "http://127.0.0.1:4000/", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("allow");
    expect(evaluateNavigation({ targetUrl: "http://10.0.0.5:8080/", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("allow");
    expect(evaluateNavigation({ targetUrl: "javascript:alert(1)", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("reject_scheme");
    expect(evaluateNavigation({ targetUrl: "::not a url", allowedOrigins: scope.allowedHosts, taskScope: scope, redirectDepth: 0 }).decision).toBe("reject_invalid_url");
  });

  it("degrades safely when Chromium is unavailable without fabricating a result", async () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 5);
    const scope = { mode: "controlled" as const, workspaceRoot: process.cwd(), allowedHosts: ["127.0.0.1:3000"], allowedPrograms: [] };
    const runtime = new ControlledBrowserRuntime({ runId: "run-test", scope, state: state.browser!, config: { ...defaultBrowserRuntimeConfig, enabled: true } });
    if (!runtime.capability.available) await expect(runtime.execute({ action: "create_session" })).rejects.toThrow("Chromium");
    await runtime.cleanup();
    expect(state.browser?.sessions.every((session) => session.status !== "active")).toBe(true);
  });

  it("keeps browser argument validation in PolicyEngine with every known action allowed", () => {
    const scope = { mode: "controlled" as const, workspaceRoot: process.cwd(), allowedHosts: ["127.0.0.1:3000"], allowedPrograms: [] };
    const policy = new PolicyEngine(scope, { maxToolCalls: 10, maxActionsWithoutCheckpoint: 5, maxRepeatedAction: 2 } as never);
    expect(policy.evaluate("browser", { action: "capture_dom" }, fakeRun()).allowed).toBe(true);
    expect(policy.evaluate("browser", { action: "assert_state", expectedText: "done" }, fakeRun()).allowed).toBe(true);
    // Operator enabled CTF-oriented browser actions: evaluate, upload, download, screenshot.
    expect(policy.evaluate("browser", { action: "evaluate" }, fakeRun()).allowed).toBe(true);
    expect(policy.evaluate("browser", { action: "upload", path: "shell.png" }, fakeRun()).allowed).toBe(true);
    expect(policy.evaluate("browser", { action: "download" }, fakeRun()).allowed).toBe(true);
    expect(policy.evaluate("browser", { action: "capture_screenshot" }, fakeRun()).allowed).toBe(true);
    // Permissive mode: popup passes policy; unsupported actions fail at the runtime instead.
    expect(policy.evaluate("browser", { action: "popup" }, fakeRun()).allowed).toBe(true);
    expect(policy.evaluate("browser", { action: "exfiltrate_dom" }, fakeRun()).allowed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { hostMatches, PolicyEngine } from "../src/policy.js";
import type { RunState } from "../src/types.js";
import { testConfig } from "./helpers.js";

function state(): RunState {
  const now = new Date().toISOString();
  return {
    id: "test",
    status: "running",
    phase: "planning",
    task: { task: "test", attachments: [], metadata: {} },
    createdAt: now,
    updatedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "test",
    scratchRoot: "/tmp/xuan-policy/scratch/runs/test",
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

const plan = { goal: "inspect", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "read", successCriteria: [], tools: ["read_file"] }] };

describe("PolicyEngine (permissive mode)", () => {
  it("allows actions without a plan and ignores path-shape restrictions", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();

    expect(policy.evaluate("read_file", { path: "notes.txt" }, run).allowed).toBe(true);
    expect(policy.evaluate("run_command", { program: "rg", args: ["secret", "../outside"] }, run).allowed).toBe(true);
    expect(policy.evaluate("write_scratch_file", { path: "../escape", content: "x" }, run).allowed).toBe(true);
    expect(policy.evaluate("inspect_artifact", { source: "scratch", path: "../escape" }, run).allowed).toBe(true);
    expect(policy.evaluate("extract_archive", { source: "workspace", path: "input.zip", destination: "../escape" }, run).allowed).toBe(true);
    expect(policy.evaluate("unknown_tool", {}, run).allowed).toBe(false);
  });

  it("does not enforce tool-call, checkpoint, or repeated-action budgets", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = plan;
    run.toolCalls = config.runtime.maxToolCalls + 10;
    run.actionsSinceCheckpoint = config.runtime.maxActionsWithoutCheckpoint + 10;
    run.repeatedActions["x"] = config.runtime.maxRepeatedAction + 10;

    expect(policy.evaluate("run_command", { program: "rg", args: ["pattern"] }, run).allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "GET", url: "https://example.com" }, run).allowed).toBe(true);
    expect(policy.evaluate("observe_image", { source: "workspace", path: "shot.png" }, run).allowed).toBe(true);
    expect(policy.evaluate("checkpoint", { observations: [], assessment: "x", planChanges: [], nextAction: "y", failureClassification: "none" }, run).allowed).toBe(true);
  });

  it("allows any program, host, and network tool regardless of configured allowlists", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = plan;

    expect(policy.evaluate("run_command", { program: "curl", args: ["https://example.com"] }, run).allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "GET", url: "https://not-in-allowlist.invalid/path" }, run).allowed).toBe(true);
    expect(policy.evaluate("tcp_open", { host: "10.0.0.1", port: 1234 }, run).allowed).toBe(true);
    expect(policy.evaluate("tcp_send", { sessionId: "s1", data: "x" }, run).allowed).toBe(true);
    expect(policy.evaluate("web_collect_baseline", { url: "http://anywhere.invalid/" }, run).allowed).toBe(true);
  });

  it("still rejects malformed network arguments and unknown browser actions", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = plan;

    expect(policy.evaluate("http_request", { method: "GET", url: "ftp://example.com" }, run).allowed).toBe(false);
    expect(policy.evaluate("http_request", { method: "GET", url: "not a url" }, run).allowed).toBe(false);
    expect(policy.evaluate("tcp_open", { host: "h", port: 0 }, run).allowed).toBe(false);
    expect(policy.evaluate("tcp_open", { host: "h", port: 70000 }, run).allowed).toBe(false);
    expect(policy.evaluate("browser", { action: "exfiltrate_dom" }, run).allowed).toBe(false);
    expect(policy.evaluate("run_command", { program: "cat", args: ["a\u0000b"] }, run).allowed).toBe(false);
    expect(PolicyEngine.evaluateScopedTcpTarget(config.scope, "any.host.invalid", 4444).allowed).toBe(true);
    expect(PolicyEngine.evaluateScopedTcpTarget(config.scope, "any.host.invalid", 0).allowed).toBe(false);
  });

  it("records telemetry counters for allowed actions", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = plan;

    const decision = policy.evaluate("http_request", { method: "GET", url: "https://example.com" }, run);
    policy.recordAllowed("http_request", decision, run);
    policy.recordAllowed("tcp_open", policy.evaluate("tcp_open", { host: "h.invalid", port: 80 }, run), run);
    policy.recordAllowed("observe_image", policy.evaluate("observe_image", { source: "workspace", path: "a.png" }, run), run);
    policy.recordAllowed("checkpoint", policy.evaluate("checkpoint", { observations: [], assessment: "x", planChanges: [], nextAction: "y" }, run), run);

    expect(run.httpRequests).toBe(1);
    expect(run.tcpSessions).toBe(1);
    expect(run.imageObservations).toBe(1);
    expect(run.actionsSinceCheckpoint).toBe(0);
  });

  it("keeps host matching semantics for config validation and redirect helpers", () => {
    expect(hostMatches("abc.sandbox.invalid:31001", "*.sandbox.invalid:*")).toBe(true);
    expect(hostMatches("abc.sandbox.invalid:31001", "*.sandbox.invalid:31001")).toBe(true);
    expect(hostMatches("abc.sandbox.invalid:31001", "*.sandbox.invalid:31002")).toBe(false);
    expect(hostMatches("sandbox.invalid:31001", "*.sandbox.invalid:*")).toBe(false);
  });
});

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
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

describe("PolicyEngine", () => {
  it("requires a plan, rejects path escapes, and denies network by default", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();

    expect(policy.evaluate("read_file", { path: "notes.txt" }, run).allowed).toBe(false);
    run.plan = { goal: "inspect", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "read", successCriteria: [], tools: ["read_file"] }] };
    expect(policy.evaluate("read_file", { path: "notes.txt" }, run).allowed).toBe(true);
    expect(policy.evaluate("run_command", { program: "rg", args: ["secret", "../outside"] }, run).allowed).toBe(false);
    expect(policy.evaluate("run_command", { program: "curl", args: ["https://example.com"] }, run).allowed).toBe(false);
    expect(policy.evaluate("write_scratch_file", { path: "../escape", content: "x" }, run).allowed).toBe(false);
    expect(policy.evaluate("inspect_artifact", { source: "workspace", path: "notes.txt" }, run).allowed).toBe(true);
    expect(policy.evaluate("inspect_artifact", { source: "scratch", path: "../escape" }, run).allowed).toBe(false);
    expect(policy.evaluate("http_request", { method: "GET", url: "https://example.com" }, run).allowed).toBe(false);
  });

  it("enforces authorized hosts and checkpoint cadence", () => {
    const config = testConfig("/tmp/xuan-policy");
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["lab.example.invalid", "*.sandbox.invalid", "pwn.example.invalid:31337"];
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = { goal: "inspect", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "request", successCriteria: [], tools: ["http_request"] }] };

    expect(policy.evaluate("http_request", { method: "GET", url: "https://lab.example.invalid/a" }, run).allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "PATCH", url: "https://lab.example.invalid/a" }, run).allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "GET", url: "https://evil.invalid/a" }, run).allowed).toBe(false);
    expect(policy.evaluate("tcp_open", { host: "pwn.example.invalid", port: 31337 }, run).allowed).toBe(true);
    expect(policy.evaluate("tcp_open", { host: "pwn.example.invalid", port: 31338 }, run).allowed).toBe(false);
    run.actionsSinceCheckpoint = config.runtime.maxActionsWithoutCheckpoint;
    expect(policy.evaluate("read_file", { path: "a" }, run).reason).toContain("Checkpoint");
    expect(policy.evaluate("checkpoint", { observations: ["x"] }, run).allowed).toBe(true);
  });

  it("supports operator-owned wildcard port narrowing for dynamic challenge containers", () => {
    expect(hostMatches("abc.sandbox.invalid:31001", "*.sandbox.invalid:*")).toBe(true);
    expect(hostMatches("abc.sandbox.invalid:31001", "*.sandbox.invalid:31001")).toBe(true);
    expect(hostMatches("abc.sandbox.invalid:31001", "*.sandbox.invalid:31002")).toBe(false);
    expect(hostMatches("sandbox.invalid:31001", "*.sandbox.invalid:*")).toBe(false);

    const config = testConfig("/tmp/xuan-policy");
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["*.sandbox.invalid:*"];
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = { goal: "inspect", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "request", successCriteria: [], tools: ["http_request"] }] };

    expect(policy.evaluate("http_request", { method: "GET", url: "http://case.sandbox.invalid:31001/" }, run).allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "GET", url: "http://sandbox.invalid:31001/" }, run).allowed).toBe(false);
  });

  it("keeps Arena control-plane requests on the configured API prefix", () => {
    const config = testConfig("/tmp/xuan-policy");
    expect(
      PolicyEngine.evaluateArenaRequest(
        config.arena,
        "POST",
        "https://www.nssctf.cn/api/skill/agent/arena/next/",
      ).allowed,
    ).toBe(true);
    expect(
      PolicyEngine.evaluateArenaRequest(config.arena, "POST", "https://www.nssctf.cn/api/other/").allowed,
    ).toBe(false);
    expect(
      PolicyEngine.evaluateArenaRequest(config.arena, "POST", "https://example.invalid/api/skill/agent/arena/next/")
        .allowed,
    ).toBe(false);

    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["assets.nssctf.invalid"];
    expect(
      PolicyEngine.evaluateArenaAnnexRequest(config.arena, config.scope, "https://www.nssctf.cn/media/challenge.zip")
        .allowed,
    ).toBe(true);
    expect(
      PolicyEngine.evaluateArenaAnnexRequest(config.arena, config.scope, "https://assets.nssctf.invalid/challenge.zip")
        .allowed,
    ).toBe(true);
    expect(
      PolicyEngine.evaluateArenaAnnexRequest(config.arena, config.scope, "https://outside.invalid/challenge.zip").allowed,
    ).toBe(false);
  });

  it("requires a reusable lesson candidate before an Arena completion", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.task.metadata.source = "nssctf-agent-arena";
    run.plan = { goal: "solve", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "verify", successCriteria: [], tools: [] }] };

    const finish = {
      status: "completed",
      summary: "done",
      submission: "dynamic-answer",
      confidence: 0.9,
      verification: ["independent check"],
      independentlyVerified: true,
    };
    expect(policy.evaluate("finish_task", { ...finish, independentlyVerified: false }, run).reason).toContain(
      "independent verification",
    );
    expect(policy.evaluate("finish_task", finish, run).reason).toContain(
      "record_lesson",
    );
    run.lessons.push({
      id: "lesson",
      title: "Generic verification",
      applicableWhen: ["Evidence is ambiguous"],
      strategy: ["Use an independent observation"],
      verification: ["Compare both observations"],
      pitfalls: [],
      tools: [],
    });
    expect(policy.evaluate("finish_task", finish, run).allowed).toBe(true);
  });

  it("requires a concrete strategy revision after a failed or denied action", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = { goal: "inspect", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "read", successCriteria: [], tools: [] }] };
    run.strategyRevisionRequired = true;

    expect(policy.evaluate("finish_task", { status: "blocked" }, run).reason).toContain("strategy-revision checkpoint");
    expect(
      policy.evaluate("checkpoint", {
        observations: ["command failed"],
        assessment: "tool unavailable",
        planChanges: [],
        nextAction: "try something else",
        failureClassification: "tool",
        nextActionRationale: "use an available tool",
      }, run).reason,
    ).toContain("plan change");
    expect(
      policy.evaluate("checkpoint", {
        observations: ["command failed"],
        assessment: "tool unavailable",
        planChanges: ["Replace the unavailable command with inspect_artifact"],
        nextAction: "inspect the artifact deterministically",
        failureClassification: "tool",
        nextActionRationale: "The replacement is available and tests the same hypothesis",
      }, run).allowed,
    ).toBe(true);
  });
});

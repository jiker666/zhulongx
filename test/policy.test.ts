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
    expect(policy.evaluate("search_artifact", { source: "workspace", path: "firmware.bin", pattern: "MZ" }, run).allowed).toBe(true);
    expect(policy.evaluate("search_artifact", { source: "workspace", path: "../firmware.bin", pattern: "MZ" }, run).allowed).toBe(false);
    expect(policy.evaluate("extract_archive", { source: "workspace", path: "input.zip", destination: "extracted" }, run).allowed).toBe(true);
    expect(policy.evaluate("extract_archive", { source: "workspace", path: "input.zip", destination: "../escape" }, run).allowed).toBe(false);
    expect(policy.evaluate("http_request", { method: "GET", url: "https://example.com" }, run).allowed).toBe(false);
  });

  it("charges artifact actions to the standard tool and checkpoint budgets", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = { goal: "inspect an archive", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "extract and search", successCriteria: [], tools: ["extract_archive", "search_artifact"] }] };

    const extraction = policy.evaluate("extract_archive", { source: "workspace", path: "input.zip", destination: "extracted" }, run);
    expect(extraction.allowed).toBe(true);
    policy.recordAllowed("extract_archive", extraction, run);
    expect(run.toolCalls).toBe(1);
    expect(run.actionsSinceCheckpoint).toBe(1);

    run.actionsSinceCheckpoint = config.runtime.maxActionsWithoutCheckpoint;
    expect(policy.evaluate("search_artifact", { source: "scratch", path: "extracted/a.bin", pattern: "7f454c46", encoding: "hex" }, run).reason).toContain("Checkpoint");
  });

  it("allows operator-owned offline Crypto/Misc programs while preserving the global tool budget", () => {
    const config = testConfig("/tmp/xuan-policy");
    const offlinePrograms = [
      "base32",
      "bc",
      "convert",
      "ecm",
      "factor",
      "ffprobe",
      "gifsicle",
      "gp",
      "identify",
      "minimodem",
      "multimon-ng",
      "outguess",
      "pickora",
      "pngcheck",
      "sox",
      "soxi",
      "steghide",
      "stegsnow",
      "tesseract",
      "z3",
    ];
    config.scope.allowedPrograms = offlinePrograms;
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = { goal: "perform offline analysis", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "run bounded Crypto/Misc tools", successCriteria: ["evidence produced or budget exhausted"], tools: ["run_command"] }] };

    for (const program of offlinePrograms) {
      expect(policy.evaluate("run_command", { program, args: [] }, run).allowed).toBe(true);
    }

    const decision = policy.evaluate("run_command", { program: "ecm", args: ["50000", "1000000"] }, run);
    expect(decision.allowed).toBe(true);
    policy.recordAllowed("run_command", decision, run);
    expect(run.toolCalls).toBe(1);

    run.toolCalls = config.runtime.maxToolCalls;
    expect(policy.evaluate("run_command", { program: "ecm", args: ["250000"] }, run).reason).toContain("budget");
    expect(policy.evaluate("run_command", { program: "openssl", args: ["s_client"] }, { ...run, toolCalls: 0 }).reason).toContain("allowlist");
  });

  it("enforces authorized hosts and checkpoint cadence", () => {
    const config = testConfig("/tmp/xuan-policy");
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["lab.example.invalid", "*.sandbox.invalid", "pwn.example.invalid:31337"];
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = { goal: "inspect", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "request", successCriteria: [], tools: ["http_request"] }] };

    expect(policy.evaluate("http_request", { method: "GET", url: "https://lab.example.invalid/a" }, run).allowed).toBe(true);
    expect(policy.evaluate("web_collect_baseline", { url: "https://lab.example.invalid/a" }, run).allowed).toBe(true);
    expect(policy.evaluate("web_collect_baseline", { url: "https://evil.invalid/a" }, run).allowed).toBe(false);
    expect(policy.evaluate("web_knowledge_lookup", { query: "upload" }, run).allowed).toBe(true);
    expect(policy.evaluate("web_compare_responses", { baseline: "a", candidate: "b" }, run).allowed).toBe(true);
    expect(policy.evaluate("web_timing_stats", { samples: [10, 11] }, run).allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "PATCH", url: "https://lab.example.invalid/a" }, run).allowed).toBe(true);
    expect(policy.evaluate("http_request", { method: "GET", url: "https://evil.invalid/a" }, run).allowed).toBe(false);
    expect(policy.evaluate("tcp_open", { host: "pwn.example.invalid", port: 31337 }, run).allowed).toBe(true);
    expect(policy.evaluate("tcp_open", { host: "pwn.example.invalid", port: 31338 }, run).allowed).toBe(false);
    run.actionsSinceCheckpoint = config.runtime.maxActionsWithoutCheckpoint;
    expect(policy.evaluate("read_file", { path: "a" }, run).reason).toContain("Checkpoint");
    expect(policy.evaluate("checkpoint", { observations: ["x"] }, run).allowed).toBe(true);
  });

  it("budgets shared evidence tools as policy-controlled actions", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    const args = { kinds: ["fact"], limit: 10 };

    expect(policy.evaluate("read_shared_evidence", args, run).reason).toContain("plan");
    run.plan = {
      goal: "coordinate bounded evidence",
      assumptions: [],
      hypotheses: [],
      steps: [{ id: "1", objective: "read the race board", successCriteria: [], tools: ["read_shared_evidence"] }],
    };
    const decision = policy.evaluate("read_shared_evidence", args, run);
    expect(decision.allowed).toBe(true);
    policy.recordAllowed("read_shared_evidence", decision, run);
    policy.recordAllowed("read_shared_evidence", decision, run);
    expect(run).toMatchObject({ toolCalls: 2, actionsSinceCheckpoint: 2 });

    run.actionsSinceCheckpoint = 0;
    expect(policy.evaluate("read_shared_evidence", args, run).reason).toContain("Repeated-action");
    run.toolCalls = config.runtime.maxToolCalls;
    expect(policy.evaluate("publish_shared_evidence", {
      kind: "fact",
      claim: "bounded claim",
      evidence: ["bounded evidence"],
      confidence: 0.9,
    }, run).reason).toContain("budget");
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
    expect(PolicyEngine.evaluateScopedTcpTarget(config.scope, "case.sandbox.invalid", 31001).allowed).toBe(true);
    expect(PolicyEngine.evaluateScopedTcpTarget(config.scope, "outside.invalid", 31001).allowed).toBe(false);
  });

  it("gates image observations and the finalization reserve (attachments-only commands are permitted)", () => {
    const config = testConfig("/tmp/xuan-policy");
    const policy = new PolicyEngine(config.scope, config.runtime);
    const run = state();
    run.plan = { goal: "inspect", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "observe", successCriteria: [], tools: ["observe_image"] }] };

    expect(policy.evaluate("observe_image", { source: "workspace", path: "clue.jpg" }, run).allowed).toBe(true);
    expect(policy.evaluate("observe_image", { source: "workspace", path: "../clue.jpg" }, run).allowed).toBe(false);
    policy.recordAllowed("observe_image", policy.evaluate("observe_image", { source: "workspace", path: "clue.jpg" }, run), run);
    run.imageObservations = config.runtime.maxImageObservations;
    expect(policy.evaluate("observe_image", { source: "workspace", path: "other.jpg" }, run).reason).toContain("budget");

    // Operator relaxed the attachments-only workspace command gate so CTF extraction
    // workflows (file/strings/python/gdb over attachments) keep working.
    run.workspaceMode = "attachments-only";
    expect(policy.evaluate("run_command", { program: "rg", args: [], cwd: "workspace" }, run).allowed).toBe(true);

    run.workspaceMode = "configured";
    run.startedAt = new Date(Date.now() - config.runtime.maxRuntimeMs + config.runtime.finalizationReserveMs).toISOString();
    expect(policy.evaluate("read_file", { path: "notes.txt" }, run).reason).toContain("Finalization reserve");
    expect(policy.evaluate("finish_task", { status: "blocked" }, run).allowed).toBe(true);
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

    run.strategyRevisionRequired = true;
    run.lastFailure = { classification: "policy", toolName: "run_command", reason: "repeated action", createdAt: new Date().toISOString() };
    expect(
      policy.evaluate("checkpoint", {
        observations: ["The previous action was denied"],
        assessment: "Use a different bounded observation",
        planChanges: ["Switch to a narrow artifact read"],
        nextAction: "Read the relevant offset",
        nextActionRationale: "The persisted failure already identifies the recovery class",
      }, run).allowed,
    ).toBe(true);
  });
});

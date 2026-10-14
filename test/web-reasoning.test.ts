import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit.js";
import { ActionDeduplicator, isMutatingToolCall } from "../src/web-reasoning/action-deduplicator.js";
import { evaluateProgress } from "../src/web-reasoning/evaluator.js";
import { HypothesisManager } from "../src/web-reasoning/hypothesis-manager.js";
import { ObservationManager } from "../src/web-reasoning/observation-manager.js";
import { planNext } from "../src/web-reasoning/planner.js";
import { createReflection } from "../src/web-reasoning/reflection-manager.js";
import { createInitialWebReasoningState } from "../src/web-reasoning/state.js";
import { detectWebTask } from "../src/web-reasoning/task-detector.js";
import type { RunState } from "../src/types.js";
import { XuanShuRuntime } from "../src/runtime.js";
import { testConfig } from "./helpers.js";
import { agentToolStep, registerFauxCli, successResult } from "./faux-cli.js";
import { sanitizeSecrets } from "../src/sanitize.js";
import { WebActionGuard } from "../src/web-reasoning/action-guard.js";
import { createWebReasoningController } from "../src/web-reasoning/controller.js";

function run(): RunState {
  const now = new Date().toISOString();
  return { id: "00000000-0000-4000-8000-000000000000", status: "running", phase: "planning", task: { task: "authorized task", attachments: [], metadata: {} }, createdAt: now, updatedAt: now, findings: [], lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false, sandboxNamespace: "test", scratchRoot: "/tmp/test", workspaceMode: "configured", appliedExperienceIds: [], turns: 0, toolCalls: 0, imageObservations: 0, httpRequests: 0, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {} };
}

describe("Web Reasoning Engine", () => {
  beforeAll(() => {
    // The integration test drives the embedded runtime, which requires a model
    // credential even when every model turn is scripted through the faux CLI.
    process.env.XUANSHU_TEST_API_KEY = "unit-test-faux-key";
  });

  afterAll(() => {
    delete process.env.XUANSHU_TEST_API_KEY;
  });

  it("detects explicit and URL Web tasks without false-positive weak words", () => {
    expect(detectWebTask({ task: "web", attachments: [], metadata: { category: "Crypto" } }).isWeb).toBe(false);
    expect(detectWebTask({ task: "inspect http://lab.example.invalid/", attachments: [], metadata: {} }).isWeb).toBe(true);
    expect(detectWebTask({ task: "the web is complex", attachments: [], metadata: {} }).isWeb).toBe(false);
  });

  it("does not retain inline authorization or cookie values in reasoning material", () => {
    const sanitized = String(sanitizeSecrets("Authorization: Bearer real-secret Cookie: session=real-cookie"));
    expect(sanitized).not.toContain("real-secret");
    expect(sanitized).not.toContain("real-cookie");
  });

  it("guards unknown tools and blocks new exploration during finalization", () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const guard = new WebActionGuard();
    expect(guard.validate(undefined, { toolName: "unknown_tool", args: {} }, state, ["finish_task"]).decision).toBe("reject_unknown_tool");
    state.phase = "completing";
    expect(guard.validate(undefined, { toolName: "web_collect_baseline", args: {} }, state, ["web_collect_baseline"]).decision).toBe("reject_finalization_mode");
  });

  it("creates, merges, bounds observations, and associates Evidence", () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const manager = new ObservationManager(state, 1);
    const first = manager.add({ type: "url", summary: "http://lab/", source: "task", evidenceIds: ["ev_1"], confidence: 0.5, normalizedKey: "url:lab" });
    const merged = manager.add({ type: "url", summary: "same URL", source: "task", evidenceIds: ["ev_2"], confidence: 0.9, normalizedKey: "url:lab" });
    expect(merged.id).toBe(first.id);
    expect(merged.evidenceIds).toEqual(["ev_1", "ev_2"]);
  });

  it("enforces hypothesis evidence before confirmation and supports rejection", () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const manager = new HypothesisManager(state);
    const hypothesis = manager.create({ category: "input_handling", title: "Compare input", statement: "The parameter changes the response", priority: 5, requiredEvidence: ["controlled comparison"], sourceObservationIds: [] });
    expect(manager.confirm(hypothesis.id)).toBe(false);
    manager.addSupportingEvidence(hypothesis.id, "ev_1");
    manager.updateConfidence(hypothesis.id, 0.7);
    expect(manager.confirm(hypothesis.id)).toBe(true);
    const rejected = manager.create({ category: "unknown", title: "Other", statement: "A separate fact", priority: 1, requiredEvidence: [], sourceObservationIds: [] });
    manager.reject(rejected.id, "not supported");
    expect(state.rejectedHypothesisIds).toContain(rejected.id);
  });

  it("deduplicates normalized URL actions and lets timeout actions retry", () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    state.actions.push({ id: "a1", proposalId: "p1", kind: "invoke_tool", objective: "baseline", rationaleSummary: "test", toolName: "web_collect_baseline", argumentsFingerprint: "x", deduplicationKey: new ActionDeduplicator(state).key({ kind: "invoke_tool", requestedTool: "web_collect_baseline", requestedArguments: { url: "HTTP://LAB/a#x" } }), status: "succeeded", evidenceIds: [] });
    const dedup = new ActionDeduplicator(state);
    expect(dedup.shouldSkip({ kind: "invoke_tool", requestedTool: "web_collect_baseline", requestedArguments: { url: "http://lab/a" } })).toBe(true);
    state.actions[0]!.status = "timed_out";
    expect(dedup.shouldSkip({ kind: "invoke_tool", requestedTool: "web_collect_baseline", requestedArguments: { url: "http://lab/a" } })).toBe(false);
  });

  it("re-allows identical reads after a mutating call bumps the epoch (R17 stateful no-dedup)", () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const key = new ActionDeduplicator(state).key({ kind: "invoke_tool", requestedTool: "http_request", requestedArguments: { url: "http://lab/profile" } });
    state.actions.push({ id: "r1", proposalId: "p1", kind: "invoke_tool", objective: "pre-login read", rationaleSummary: "test", toolName: "http_request", argumentsFingerprint: "x", deduplicationKey: key, status: "succeeded", evidenceIds: [], stateEpoch: 0 });
    const dedup = new ActionDeduplicator(state);
    // Same epoch: the identical GET stays deduplicated (static class).
    expect(dedup.shouldSkip({ kind: "invoke_tool", requestedTool: "http_request", requestedArguments: { url: "http://lab/profile" } })).toBe(true);
    // A login POST bumps the mutation epoch: the post-login GET is a NEW read.
    state.mutationEpoch = 1;
    expect(dedup.shouldSkip({ kind: "invoke_tool", requestedTool: "http_request", requestedArguments: { url: "http://lab/profile" } })).toBe(false);
    // Mutation classifier: write-shaped HTTP and browser interactions.
    expect(isMutatingToolCall("http_request", { url: "http://lab/login", method: "POST", body: "a=b" })).toBe(true);
    expect(isMutatingToolCall("http_request", { url: "http://lab/login", method: "get" })).toBe(false);
    expect(isMutatingToolCall("browser", { action: "submit_form" })).toBe(true);
    expect(isMutatingToolCall("browser", { action: "capture_dom" })).toBe(false);
  });

  it("plans verification/finalization, evaluates stagnation, and records reflection", () => {
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const context = { state, availableTools: ["web_collect_baseline"], remainingRounds: 1, remainingToolBudget: 1, run: run() };
    expect(planNext(context).kind).toBe("complete");
    for (let index = 0; index < 3; index += 1) evaluateProgress(state, { newEvidenceIds: [], isError: false });
    expect(state.stagnation.detected).toBe(true);
    const reflection = createReflection(state);
    expect(reflection.id).toMatch(/^reflection_/);
  });

  it("persists and restores through the existing audit/run shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-web-reasoning-"));
    try {
      await mkdir(root, { recursive: true });
      const state = run();
      state.webReasoning = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 5);
      state.webReasoning.phase = "planning";
      const audit = new AuditChain(join(root, "audit.jsonl"), state.id);
      await audit.append("WEB_REASONING_INITIALIZED", { schemaVersion: state.webReasoning.schemaVersion });
      const restored = JSON.parse(JSON.stringify(state)) as RunState;
      expect(restored.webReasoning?.phase).toBe("planning");
      expect(restored.webReasoning?.schemaVersion).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("integrates detection, policy-gated tool execution, evidence, persistence, and finalization", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-web-runtime-"));
    const faux = await registerFauxCli([
      agentToolStep("plan-web", "submit_plan", { goal: "Inspect the authorized Web target", assumptions: [], hypotheses: [], steps: [{ id: "web", objective: "Read bounded Web knowledge", successCriteria: ["Knowledge is returned"], tools: ["web_knowledge_lookup"] }] }),
      agentToolStep("knowledge-web", "web_knowledge_lookup", { query: "response comparison" }),
      agentToolStep("finish-web", "finish_task", { status: "blocked", summary: "No candidate was produced by the bounded integration fixture", evidence: [], remainingRisks: ["A live target was not contacted"], nextSteps: ["Supply an authorized target response"], confidence: 0.2, verification: ["The fixture only verified tool orchestration"], independentlyVerified: true }),
      successResult("done"),
    ]);
    try {
      const config = testConfig(root);
      config.runtime.maxRuntimeMs = 30_000;
      await mkdir(root, { recursive: true });
      const runtime = new XuanShuRuntime(config, { sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: faux.env } });
      const state = await runtime.run({ task: "Authorized Web CTF target: https://lab.example.invalid/" });
      expect(state.webReasoning?.taskClassification.isWeb).toBe(true);
      expect(state.evidence?.length).toBeGreaterThan(0);
      expect(state.webReasoning?.observations.length).toBeGreaterThan(0);
      expect(state.webReasoning?.evaluations.length).toBeGreaterThan(0);
      expect(state.status).toBe("blocked");
      expect(state.webReasoning?.phase).toBe("blocked");
    } finally {
      await faux.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("syncs confirmed web hypotheses into the run hypothesis ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-hyp-merge-"));
    try {
      const now = new Date().toISOString();
      const runState = run();
      runState.task = { task: "Authorized Web CTF target: https://lab.example.invalid/", attachments: [], metadata: {} };
      const audit = new AuditChain(join(root, "audit.jsonl"), runState.id);
      const controller = createWebReasoningController(runState, audit);
      expect(controller.enabled).toBe(true);
      const state = runState.webReasoning!;
      state.hypotheses.push({
        id: "hyp_confirmed", category: "input_handling", title: "Reflection", statement: "The id parameter reflects input", status: "confirmed",
        confidence: 0.85, priority: 5, supportingEvidenceIds: ["ev_1"], contradictingEvidenceIds: [], sourceObservationIds: [],
        requiredEvidence: ["controlled comparison"], attemptedActionIds: [], createdAt: now, updatedAt: now, closedAt: now,
      });
      state.confirmedHypothesisIds.push("hyp_confirmed");
      await controller.afterToolResult({ toolName: "checkpoint", toolCallId: "tool_1", args: {}, result: { content: "ok" }, isError: false });
      const record = runState.hypotheses.find((item) => item.statement === "The id parameter reflects input");
      expect(record?.status).toBe("confirmed");
      expect(record?.evidence).toEqual(["ev_1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks rejected web hypotheses as contradicted in the run ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-hyp-reject-"));
    try {
      const now = new Date().toISOString();
      const runState = run();
      runState.task = { task: "Authorized Web CTF target: https://lab.example.invalid/", attachments: [], metadata: {} };
      const audit = new AuditChain(join(root, "audit.jsonl"), runState.id);
      const controller = createWebReasoningController(runState, audit);
      const state = runState.webReasoning!;
      state.hypotheses.push({
        id: "hyp_rejected", category: "input_handling", title: "XSS", statement: "The comment field allows script injection", status: "rejected",
        confidence: 0.1, priority: 3, supportingEvidenceIds: [], contradictingEvidenceIds: ["ev_2"], sourceObservationIds: [],
        requiredEvidence: ["controlled comparison"], attemptedActionIds: [], createdAt: now, updatedAt: now, closedAt: now,
      });
      state.rejectedHypothesisIds.push("hyp_rejected");
      await controller.afterToolResult({ toolName: "checkpoint", toolCallId: "tool_2", args: {}, result: { content: "ok" }, isError: false });
      const record = runState.hypotheses.find((item) => item.statement === "The comment field allows script injection");
      expect(record?.status).toBe("contradicted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not duplicate a hypothesis record across repeated sync rounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-hyp-idem-"));
    try {
      const now = new Date().toISOString();
      const runState = run();
      runState.task = { task: "Authorized Web CTF target: https://lab.example.invalid/", attachments: [], metadata: {} };
      const audit = new AuditChain(join(root, "audit.jsonl"), runState.id);
      const controller = createWebReasoningController(runState, audit);
      const state = runState.webReasoning!;
      state.hypotheses.push({
        id: "hyp_confirmed", category: "input_handling", title: "Reflection", statement: "The id parameter reflects input", status: "confirmed",
        confidence: 0.85, priority: 5, supportingEvidenceIds: ["ev_1"], contradictingEvidenceIds: [], sourceObservationIds: [],
        requiredEvidence: ["controlled comparison"], attemptedActionIds: [], createdAt: now, updatedAt: now, closedAt: now,
      });
      state.confirmedHypothesisIds.push("hyp_confirmed");
      // Two sync rounds with distinct evidence; the same hypothesis must not duplicate.
      await controller.afterToolResult({ toolName: "checkpoint", toolCallId: "tool_1", args: {}, result: { content: "first round" }, isError: false });
      await controller.afterToolResult({ toolName: "checkpoint", toolCallId: "tool_2", args: {}, result: { content: "second round" }, isError: false });
      const matches = runState.hypotheses.filter((item) => item.statement === "The id parameter reflects input");
      expect(matches.length).toBe(1);
      expect(matches[0]!.status).toBe("confirmed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

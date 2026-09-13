import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "../src/audit.js";
import { KnowledgeStore } from "../src/knowledge-store.js";
import { startModelGateway } from "../src/model-gateway.js";
import { XuanShuRuntime } from "../src/runtime.js";
import { startSandboxServer } from "../src/sandbox.js";
import { SharedEvidenceBoard } from "../src/shared-evidence.js";
import { readAuditRecords } from "../src/trace.js";
import { agentToolStep, assistantStep, registerFauxCli, successResult, textBlock, type FauxCliHandle } from "./faux-cli.js";
import { testConfig } from "./helpers.js";
import type { AppConfig } from "../src/types.js";

const roots: string[] = [];

function sdkOverrides(faux: FauxCliHandle): { sdk: { pathToClaudeCodeExecutable: string; env: Record<string, string> } } {
  return { sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: faux.env } };
}

async function runtimeFixture(prefix: string): Promise<{ config: AppConfig; root: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const config = testConfig(root);
  await mkdir(config.scope.workspaceRoot, { recursive: true });
  // Agent sessions run in a spawned CLI subprocess; give them more wall-clock
  // than the in-process default budget.
  config.runtime.maxRuntimeMs = 30_000;
  return { config, root };
}

beforeAll(() => {
  process.env.XUANSHU_TEST_API_KEY = "unit-test-faux-key";
});

afterAll(() => {
  delete process.env.XUANSHU_TEST_API_KEY;
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("XuanShuRuntime", () => {
  it("retrieves relevant knowledge before the first planning prompt", { timeout: 30_000 }, async () => {
    const { config, root } = await runtimeFixture("xuan-runtime-knowledge-");
    const knowledgeStore = new KnowledgeStore(join(root, "knowledge"));
    await knowledgeStore.ingest({
      docId: "ssrf-guide",
      sourceUrl: "https://docs.example.invalid/ssrf",
      title: "SSRF guide",
      mediaType: "text/markdown",
      trust: "community",
      source: "SSRF gopher reference",
      markdown: "# SSRF\nUse this reference to identify gopher-related verification ideas.",
      summary: "SSRF and gopher reference for authorized CTF analysis",
      keyParameters: ["gopher", "authorized challenge"],
    });
    const faux = await registerFauxCli([
      agentToolStep("knowledge-plan", "submit_plan", {
        goal: "Use the authorized challenge evidence",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "inspect", objective: "Inspect the supplied evidence", successCriteria: ["Evidence is reviewed"], tools: ["list_files"] }],
      }),
      agentToolStep("knowledge-finish", "finish_task", {
        status: "completed",
        summary: "Completed the bounded authorized analysis.",
        evidence: ["knowledge context was available before planning"],
        remainingRisks: [],
        nextSteps: [],
        confidence: 0.9,
        verification: ["retrieval was recorded in the audit trail"],
        independentlyVerified: true,
      }),
      successResult("done"),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, { ...sdkOverrides(faux), knowledgeStore });
      const state = await runtime.run({ task: "Solve this authorized SSRF gopher challenge" });
      const records = await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"));
      const retrieval = records.find((record) => record.type === "knowledge.retrieved");
      const context = records.find((record) => record.type === "context.injected");

      expect(state.status).toBe("completed");
      expect(retrieval).toMatchObject({ source: "context", actor: "knowledge-retriever", data: { resultCount: 1, documents: [{ docId: "ssrf-guide" }] } });
      expect(JSON.stringify(context)).toContain("UNTRUSTED KNOWLEDGE RETRIEVAL");
      expect(JSON.stringify(context)).toContain("SSRF guide");
    } finally {
      await faux.cleanup();
    }
  });

  it("redacts sensitive text from every persisted run artifact", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-redaction-");
    const faux = await registerFauxCli([
      assistantStep([textBlock("Cookie: session=assistant-sensitive-cookie")]),
      successResult("done"),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Authorization: Bearer task-sensitive-value" });
      const runDirectory = join(config.runtime.artifactRoot, state.id);
      const persisted = (await Promise.all([
        readFile(join(runDirectory, "state.json"), "utf8"),
        readFile(join(runDirectory, "findings.json"), "utf8"),
        readFile(join(runDirectory, "transcript.json"), "utf8"),
        readFile(join(runDirectory, "audit.jsonl"), "utf8"),
        readFile(join(runDirectory, "summary.json"), "utf8"),
      ])).join("\n");

      expect(persisted).not.toContain("task-sensitive-value");
      expect(persisted).not.toContain("assistant-sensitive-cookie");
      expect(persisted).toContain("[redacted]");
      expect(await verifyAuditChain(join(runDirectory, "audit.jsonl"))).toMatchObject({ valid: true });
    } finally {
      await faux.cleanup();
    }
  });

  it("generates and persists a dedicated writeup after a verified completion", { timeout: 45_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-writeup-");
    // The writeup runs in a second single-shot subprocess; the shared cursor
    // lets it continue the script after the session consumed the run steps.
    config.runtime.finalizationReserveMs = 20_000;
    const markdown = ["---", "title: \"Demo\"", "ctf: \"Demo\"", "date: 2026-08-26", "category: crypto", "difficulty: easy", "points: 1", "flag_format: \"flag{...}\"", "author: \"Team\"", "---", "", "# Demo", "", "## Summary", "", "Solved the challenge.", "", "## Solution", "", "### Step 1: Solve", "", "```python", "print(\"flag{writer}\")", "```", "", "## Flag", "", "```", "flag{writer}", "```"].join("\n");
    const faux = await registerFauxCli([
      agentToolStep("finish-writeup", "finish_task", {
        status: "completed",
        summary: "The challenge was solved from deterministic evidence.",
        submission: "flag{writer}",
        evidence: ["verified"],
        remainingRisks: [],
        nextSteps: [],
        confidence: 1,
        verification: ["independent replay"],
        independentlyVerified: true,
      }),
      successResult("done"),
      assistantStep([textBlock(markdown)]),
      successResult(markdown),
    ], { cursor: true });
    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Demo challenge", metadata: { category: "crypto" } }, { writeup: true });
      expect(state.status).toBe("completed");
      expect(state.writeup).toContain("## Solution");
      expect(state.writeup).toContain("```python");
      expect(JSON.parse(await readFile(join(config.runtime.artifactRoot, state.id, "state.json"), "utf8")).writeup).toContain("flag{writer}");
      expect(await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))).toContainEqual(expect.objectContaining({ type: "writeup.generated" }));
    } finally {
      await faux.cleanup();
    }
  });

  it("shares bounded race evidence through policy-controlled audited tools", { timeout: 45_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-shared-evidence-");
    // One shared cursor: run 1 consumes the publish half, run 2 the read half.
    const faux = await registerFauxCli([
      agentToolStep("shared-plan-1", "submit_plan", {
        goal: "Publish one direct observation",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "share", objective: "Share evidence", successCriteria: ["Entry published"], tools: ["publish_shared_evidence"] }],
      }),
      agentToolStep("shared-publish", "publish_shared_evidence", {
        kind: "fact",
        claim: "The deterministic artifact begins with an ELF magic",
        evidence: ["inspect_artifact reported magic=elf"],
        confidence: 0.95,
      }),
      agentToolStep("shared-finish-1", "finish_task", {
        status: "blocked",
        summary: "Published a useful observation for the race.",
        evidence: ["shared board accepted the entry"],
        remainingRisks: ["No final answer"],
        nextSteps: [],
        confidence: 0.4,
        verification: ["The publish tool returned an entry id"],
        independentlyVerified: false,
      }),
      successResult("done"),
      agentToolStep("shared-plan-2", "submit_plan", {
        goal: "Read teammate observations",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "read", objective: "Read evidence", successCriteria: ["Entry received"], tools: ["read_shared_evidence"] }],
      }),
      agentToolStep("shared-read", "read_shared_evidence", { kinds: ["fact"], limit: 10 }),
      agentToolStep("shared-finish-2", "finish_task", {
        status: "blocked",
        summary: "Read the shared observation but did not treat it as independently verified.",
        evidence: ["shared board returned the ELF observation"],
        remainingRisks: ["Independent reproduction remains"],
        nextSteps: [],
        confidence: 0.4,
        verification: ["The read tool returned one bounded entry"],
        independentlyVerified: false,
      }),
      successResult("done"),
    ], { cursor: true });

    try {
      const board = new SharedEvidenceBoard();
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const first = await runtime.run({ task: "First race worker" }, { sharedEvidence: board });
      const second = await runtime.run({ task: "Second race worker" }, { sharedEvidence: board });
      const firstAudit = await readAuditRecords(join(config.runtime.artifactRoot, first.id, "audit.jsonl"));
      const secondAudit = await readAuditRecords(join(config.runtime.artifactRoot, second.id, "audit.jsonl"));

      expect(board.snapshot().entries).toMatchObject([{
        kind: "fact",
        claim: "The deterministic artifact begins with an ELF magic",
        sourceRunIds: [first.id],
      }]);
      expect(firstAudit).toContainEqual(expect.objectContaining({
        type: "policy.decision",
        data: expect.objectContaining({ toolName: "publish_shared_evidence", allowed: true }),
      }));
      expect(firstAudit).toContainEqual(expect.objectContaining({ type: "collaboration.evidence_published" }));
      expect(secondAudit).toContainEqual(expect.objectContaining({ type: "collaboration.evidence_read" }));
      expect(await verifyAuditChain(join(config.runtime.artifactRoot, first.id, "audit.jsonl"))).toMatchObject({ valid: true });
      expect(await verifyAuditChain(join(config.runtime.artifactRoot, second.id, "audit.jsonl"))).toMatchObject({ valid: true });
    } finally {
      await faux.cleanup();
    }
  });

  it("serializes initial model requests across runtime instances sharing one gateway without throttling", { timeout: 45_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-rate-gate-");
    config.runtime.modelMinIntervalMs = 100;
    // A shared process-level gateway owns the request gate; each scripted
    // assistant step POSTs through it, so the reservations below are real.
    const gateway = await startModelGateway();
    // The wait_log step converges the two independently spawned CLI subprocesses
    // before their first model request so the second one provably queues.
    const faux = await registerFauxCli([
      { type: "wait_log", dir: "out", msgType: "system", subtype: "init", count: 2 },
      assistantStep([textBlock("first")]),
      successResult("first"),
    ], { gateway: true });

    try {
      const overrides = { gateway, ...sdkOverrides(faux) };
      const first = new XuanShuRuntime(config, overrides);
      const second = new XuanShuRuntime(config, overrides);

      const states = await Promise.all([
        first.run({ task: "first rate-limited run" }),
        second.run({ task: "second rate-limited run" }),
      ]);

      const reservations = (await Promise.all(states.map((state) =>
        readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))
      ))).flat().filter((record) => record.type === "model.request_reserved");
      expect(reservations).toHaveLength(2);
      // Rate limiting is disabled: requests serialize (tail chaining) but never wait.
      expect(reservations.every((record) => Number((record.data as { waitedMs?: number }).waitedMs) === 0)).toBe(true);
    } finally {
      await faux.cleanup();
      await gateway.stop();
    }
  });

  it("recovers an output-limit response without misclassifying it as a blocked task", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-length-recovery-");
    config.runtime.thinkingLevel = "medium";
    const faux = await registerFauxCli([
      assistantStep([], { stopReason: "max_tokens" }),
      { type: "result", subtype: "success", result: "", stopReason: "max_tokens" },
      agentToolStep("finish-after-length", "finish_task", {
        status: "completed",
        summary: "Recovered after a bounded output-limit continuation.",
        submission: "verified-answer",
        evidence: ["deterministic faux response"],
        remainingRisks: [],
        nextSteps: [],
        confidence: 0.95,
        verification: ["the continuation issued finish_task"],
        independentlyVerified: true,
      }),
      successResult("done"),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Recover a truncated model turn" });

      expect(state).toMatchObject({ status: "completed", submission: "verified-answer", turns: 2 });
      expect(await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))).toContainEqual(expect.objectContaining({
        type: "model.length_recovery",
        data: expect.objectContaining({ attempt: 1, thinkingLevel: "low" }),
      }));
    } finally {
      await faux.cleanup();
    }
  });

  it("classifies exhausted output-limit recovery as a model failure", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-length-failure-");
    const faux = await registerFauxCli(
      Array.from({ length: 3 }, () => [
        assistantStep([], { stopReason: "max_tokens" }),
        { type: "result", subtype: "success", result: "", stopReason: "max_tokens" },
      ]).flat(),
    );

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Exhaust bounded output recovery" });

      expect(state).toMatchObject({ status: "failed", turns: 3 });
      expect(state.stopReason).toContain("output token limit after 2 recovery attempt(s)");
    } finally {
      await faux.cleanup();
    }
  });

  it("recovers a gateway turn that stops without a tool call", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-no-action-recovery-");
    const faux = await registerFauxCli([
      assistantStep([]),
      successResult("done"),
      agentToolStep("finish-after-no-action", "finish_task", {
        status: "completed",
        summary: "Recovered after an empty gateway turn.",
        submission: "verified-answer",
        evidence: ["deterministic faux response"],
        remainingRisks: [],
        nextSteps: [],
        confidence: 0.95,
        verification: ["the continuation issued finish_task"],
        independentlyVerified: true,
      }),
      successResult("done"),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Recover an empty model turn" });

      expect(state).toMatchObject({ status: "completed", submission: "verified-answer", turns: 2 });
      expect(await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))).toContainEqual(expect.objectContaining({
        type: "model.no_action_recovery",
        data: expect.objectContaining({ attempt: 1, maximumAttempts: 2, hadVisibleText: false }),
      }));
    } finally {
      await faux.cleanup();
    }
  });

  it("blocks an ungrounded strict submission and lets the agent settle as blocked", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-strict-submission-");
    const faux = await registerFauxCli([
      agentToolStep("strict-plan", "submit_plan", {
        goal: "Verify a candidate from an authorized observation",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "observe", objective: "Collect evidence", successCriteria: ["Candidate appears in a successful tool result"], tools: ["read_file"] }],
      }),
      agentToolStep("strict-unguarded-finish", "finish_task", {
        status: "completed",
        summary: "A candidate was proposed without a successful observation.",
        submission: "flag{invented}",
        evidence: ["model assertion"],
        remainingRisks: [],
        nextSteps: [],
        confidence: 1,
        verification: ["model assertion mentioned flag{invented}"],
        independentlyVerified: true,
      }),
      agentToolStep("strict-blocked-finish", "finish_task", {
        status: "blocked",
        summary: "The candidate was rejected because no successful tool result contained it.",
        evidence: ["submission gate audit"],
        remainingRisks: ["No grounded candidate"],
        nextSteps: ["Collect a successful authorized observation"],
        confidence: 0.1,
        verification: ["The runtime submission gate rejected the ungrounded candidate"],
        independentlyVerified: false,
      }),
      successResult("done"),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Strictly verify the final result", metadata: { submissionPolicy: "strict" } });
      const records = await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"));

      expect(state.status).toBe("blocked");
      expect(state.submission).toBeUndefined();
      expect(state.submissionValidation?.status).toBe("accepted");
      expect(records).toContainEqual(expect.objectContaining({
        type: "submission.validation",
        data: expect.objectContaining({ status: "pending", grounded: false }),
      }));
    } finally {
      await faux.cleanup();
    }
  });

  it("runs a deterministic plan-observe-reflect-report loop through the embedded agent", { timeout: 45_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-");
    await writeFile(join(config.scope.workspaceRoot, "sample.txt"), "service=demo\nstatus=healthy\n", "utf8");

    // Gateway probes make every scripted turn a real gateway request, so
    // model.context records (message count + digest) exist in the audit chain.
    const faux = await registerFauxCli([
      agentToolStep("plan-1", "submit_plan", {
        goal: "Inspect the supplied workspace without assumptions",
        assumptions: ["The workspace is authorized"],
        hypotheses: ["The sample contains useful service metadata"],
        steps: [
          {
            id: "inspect",
            objective: "Triage the supplied artifact",
            successCriteria: ["Artifact properties observed"],
            tools: ["inspect_artifact"],
          },
        ],
      }),
      agentToolStep("inspect-1", "inspect_artifact", { source: "workspace", path: "sample.txt" }),
      agentToolStep("checkpoint-1", "checkpoint", {
        observations: ["sample.txt exists"],
        assessment: "The input is available for bounded inspection",
        planChanges: [],
        nextAction: "Record the verified operational observation",
        hypotheses: [{
          hypothesis: "The sample contains useful service metadata",
          status: "supported",
          evidence: ["inspect_artifact recovered printable service metadata"],
        }],
      }),
      agentToolStep("finding-1", "record_finding", {
        title: "Sample evidence discovered",
        severity: "info",
        confidence: 0.95,
        description: "The authorized workspace contains sample.txt.",
        evidence: ["list_files returned sample.txt"],
        remediation: "No remediation required",
      }),
      agentToolStep("finish-1", "finish_task", {
        status: "completed",
        summary: "已完成授权工作区的证据驱动检查。",
        evidence: ["sample.txt"],
        remainingRisks: ["未执行网络操作"],
        nextSteps: [],
        confidence: 0.95,
        verification: ["list_files independently confirmed sample.txt"],
        independentlyVerified: true,
      }),
      successResult("done"),
    ], { gateway: true });

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "独立检查工作区并给出有证据的结论" });

      expect(state.status).toBe("completed");
      expect(state.plan?.steps).toHaveLength(1);
      expect(state.findings).toHaveLength(1);
      expect(state.lessons).toEqual([]);
      expect(state.hypotheses).toMatchObject([{
        statement: "The sample contains useful service metadata",
        status: "supported",
      }]);
      expect(state.scratchRoot).toBe(join(config.runtime.scratchRoot, "runs", state.id));
      expect(state.sandboxNamespace).toBe(state.id);
      expect(state.toolCalls).toBe(5);
      expect(state.summary).toContain("证据驱动检查");
      const auditPath = join(config.runtime.artifactRoot, state.id, "audit.jsonl");
      expect(await verifyAuditChain(auditPath)).toMatchObject({
        valid: true,
      });
      const records = await readAuditRecords(auditPath);
      expect(JSON.stringify(records)).toContain("printableRatio");
      expect(records).toContainEqual(expect.objectContaining({ type: "context.injected", source: "context" }));
      expect(records).toContainEqual(expect.objectContaining({ type: "model.context", source: "context", data: expect.objectContaining({ messageCount: expect.any(Number), digest: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
      const requested = records.find((record) => record.type === "tool.requested" && (record.data as { toolCallId?: string }).toolCallId === "inspect-1");
      const policy = records.find((record) => record.type === "policy.decision" && record.correlationId === "inspect-1");
      const result = records.find((record) => record.type === "tool.result" && record.correlationId === "inspect-1");
      expect(requested).toMatchObject({ source: "model", correlationId: "inspect-1" });
      expect(policy).toMatchObject({ source: "policy", parentSequence: requested?.sequence });
      expect(result).toMatchObject({ source: "tool", parentSequence: requested?.sequence });
    } finally {
      await faux.cleanup();
    }
  });

  it("records bounded binary searches as auditable local observations", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-artifact-search-");
    await writeFile(join(config.scope.workspaceRoot, "firmware.bin"), Buffer.from([0x00, 0x41, 0x44, 0x4d, 0x49, 0x4e, 0x00]));
    const faux = await registerFauxCli([
      agentToolStep("search-plan", "submit_plan", {
        goal: "Search the supplied binary without executing it",
        assumptions: [],
        hypotheses: ["The binary contains the requested marker"],
        steps: [{ id: "search", objective: "Search a bounded byte prefix", successCriteria: ["Offsets returned"], tools: ["search_artifact"] }],
      }),
      agentToolStep("search-artifact", "search_artifact", { source: "workspace", path: "firmware.bin", pattern: "ADMIN", encoding: "utf8" }),
      agentToolStep("search-finish", "finish_task", {
        status: "blocked",
        summary: "The marker was observed, but no final task answer was requested.",
        evidence: ["search_artifact reported one ADMIN offset"],
        remainingRisks: ["No solve objective"],
        nextSteps: [],
        confidence: 0.4,
        verification: ["The bounded byte search returned the requested marker"],
        independentlyVerified: false,
      }),
      successResult("done"),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Search the supplied firmware marker" });
      const records = await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"));

      expect(state.status).toBe("blocked");
      expect(state.toolCalls).toBe(3);
      expect(records).toContainEqual(expect.objectContaining({
        type: "artifact.searched",
        source: "tool",
        data: expect.objectContaining({ path: "firmware.bin", matches: 1, inspectedBytes: 7 }),
      }));
      expect(await verifyAuditChain(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))).toMatchObject({ valid: true });
    } finally {
      await faux.cleanup();
    }
  });

  it("audits an allowlisted sandbox program through the generic run_command tool", { timeout: 45_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-command-audit-");
    config.scope.allowedPrograms = ["node"];
    const sandbox = await startSandboxServer({
      socketPath: config.runtime.sandbox.socketPath,
      workspaceRoot: config.scope.workspaceRoot,
      scratchRoot: config.runtime.scratchRoot,
      allowedPrograms: ["node"],
      defaultTimeoutMs: config.runtime.commandTimeoutMs,
      maxOutputBytes: config.runtime.maxOutputBytes,
      network: "none",
    });
    const faux = await registerFauxCli([
      agentToolStep("command-plan", "submit_plan", {
        goal: "Run one bounded offline command",
        assumptions: ["The negotiated sandbox exposes node"],
        hypotheses: ["The command returns deterministic output"],
        steps: [{
          id: "command",
          objective: "Execute the allowlisted program",
          successCriteria: ["The expected output is returned"],
          tools: ["run_command"],
        }],
      }),
      agentToolStep("command-run", "run_command", {
        program: "node",
        args: ["-e", "process.stdout.write('offline-ok')"],
      }),
      agentToolStep("command-checkpoint", "checkpoint", {
        observations: ["The allowlisted command returned offline-ok"],
        assessment: "The sandbox command completed within its bounds",
        planChanges: [],
        nextAction: "Finish with the audited command evidence",
      }),
      agentToolStep("command-finish", "finish_task", {
        status: "completed",
        summary: "The bounded offline command completed.",
        evidence: ["run_command returned offline-ok"],
        remainingRisks: [],
        nextSteps: [],
        confidence: 1,
        verification: ["The sandbox returned exitCode=0 and offline-ok"],
        independentlyVerified: true,
      }),
      successResult("done"),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Audit one offline analysis command" });
      const records = await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"));

      expect(state.status).toBe("completed");
      expect(records).toContainEqual(expect.objectContaining({
        type: "policy.decision",
        data: expect.objectContaining({ toolName: "run_command", allowed: true }),
      }));
      expect(records).toContainEqual(expect.objectContaining({
        type: "tool.result",
        data: expect.objectContaining({ toolName: "run_command", isError: false }),
      }));
    } finally {
      await faux.cleanup();
      await sandbox.close();
    }
  });

  it("resets repeated-action signatures after an explicit strategy checkpoint", { timeout: 45_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-checkpoint-repeat-");
    config.scope.allowedPrograms = ["node"];
    const sandbox = await startSandboxServer({
      socketPath: config.runtime.sandbox.socketPath,
      workspaceRoot: config.scope.workspaceRoot,
      scratchRoot: config.runtime.scratchRoot,
      allowedPrograms: ["node"],
      defaultTimeoutMs: config.runtime.commandTimeoutMs,
      maxOutputBytes: config.runtime.maxOutputBytes,
      network: "none",
    });
    const command = { program: "node", args: ["-e", "process.stdout.write('repeat-ok')"] };
    const faux = await registerFauxCli([
      agentToolStep("repeat-plan", "submit_plan", {
        goal: "Verify a bounded command can be retried after a strategy change",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "command", objective: "Run the command", successCriteria: ["repeat-ok"], tools: ["run_command"] }],
      }),
      agentToolStep("repeat-1", "run_command", command),
      agentToolStep("repeat-2", "run_command", command),
      agentToolStep("repeat-checkpoint", "checkpoint", {
        observations: ["The same command was run twice with deterministic output"],
        assessment: "A revised verification phase is required",
        planChanges: ["Repeat the exact command once after the checkpoint"],
        nextAction: "Run the command again",
        failureClassification: "evidence",
        nextActionRationale: "The checkpoint defines a new verification phase",
      }),
      agentToolStep("repeat-3", "run_command", command),
      agentToolStep("repeat-finish", "finish_task", {
        status: "completed",
        summary: "The command was independently replayed after a strategy checkpoint.",
        evidence: ["repeat-ok"],
        remainingRisks: [],
        nextSteps: [],
        confidence: 1,
        verification: ["The post-checkpoint replay returned exitCode=0"],
        independentlyVerified: true,
      }),
      successResult("done"),
    ]);
    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "Replay one bounded offline command after a strategy checkpoint" });
      expect(state.status).toBe("completed");
      expect(state.toolCalls).toBe(6);
    } finally {
      await faux.cleanup();
      await sandbox.close();
    }
  });

  it("returns image pixels to the model but redacts them from persisted artifacts", { timeout: 30_000 }, async () => {
    const { config, root } = await runtimeFixture("xuan-runtime-image-");
    config.runtime.maxImageBytes = 1024;
    const image = join(root, "clue.jpg");
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x43, 0x4c, 0x55, 0x45]);
    await writeFile(image, imageBytes);

    const faux = await registerFauxCli([
      agentToolStep("plan-image", "submit_plan", {
        goal: "Inspect the supplied image",
        assumptions: [],
        hypotheses: ["The image contains visual evidence"],
        steps: [{ id: "observe", objective: "Observe pixels", successCriteria: ["Pixels received"], tools: ["observe_image"] }],
      }),
      agentToolStep("image-1", "observe_image", { source: "workspace", path: "01-clue.jpg" }),
      agentToolStep("checkpoint-image", "checkpoint", {
        observations: ["The image was returned to the model"],
        assessment: "Visual evidence is available",
        planChanges: [],
        nextAction: "Finish with the bounded observation",
      }),
      agentToolStep("finish-image", "finish_task", {
        status: "blocked",
        summary: "Image observed but no answer can be confirmed.",
        evidence: ["bounded image observation"],
        remainingRisks: ["No candidate"],
        nextSteps: [],
        confidence: 0.2,
        verification: ["The image tool returned a bounded result"],
        independentlyVerified: false,
      }),
      successResult("done"),
    ]);

    let cliLog = "";
    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "观察附件图片", attachments: [image] }, { workspaceMode: "attachments-only" });
      // The image must have crossed into the CLI subprocess as tool-result
      // content — read the log before cleanup deletes it.
      cliLog = JSON.stringify(await faux.readLog());
      const encoded = imageBytes.toString("base64");
      expect(cliLog).toContain(encoded);
      expect(state.imageObservations).toBe(1);
      const runDirectory = join(config.runtime.artifactRoot, state.id);
      const auditText = await readFile(join(runDirectory, "audit.jsonl"), "utf8");
      const transcriptText = await readFile(join(runDirectory, "transcript.json"), "utf8");
      expect(auditText).not.toContain(encoded);
      expect(transcriptText).not.toContain(encoded);
      expect(auditText).toContain("image.observed");
    } finally {
      await faux.cleanup();
    }
  });

  it("isolates attachments-only runs from stale shared workspace files", { timeout: 30_000 }, async () => {
    const { config, root } = await runtimeFixture("xuan-runtime-isolation-");
    await writeFile(join(config.scope.workspaceRoot, "stale.txt"), "old task", "utf8");
    const current = join(root, "current.txt");
    await writeFile(current, "current task", "utf8");
    const faux = await registerFauxCli([
      agentToolStep("plan-isolation", "submit_plan", {
        goal: "List only current attachments",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "list", objective: "List inputs", successCriteria: ["Only current input appears"], tools: ["list_files"] }],
      }),
      agentToolStep("list-isolation", "list_files", { path: ".", depth: 2 }),
      agentToolStep("finish-isolation", "finish_task", {
        status: "blocked",
        summary: "Inputs listed.",
        evidence: ["Current attachment only"],
        remainingRisks: ["No solve"],
        nextSteps: [],
        confidence: 0.2,
        verification: ["Bounded listing"],
        independentlyVerified: false,
      }),
      successResult("done"),
    ]);
    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run({ task: "仅列出当前附件", attachments: [current] }, { workspaceMode: "attachments-only" });
      const auditText = await readFile(join(config.runtime.artifactRoot, state.id, "audit.jsonl"), "utf8");
      expect(auditText).toContain("01-current.txt");
      expect(auditText).not.toContain("stale.txt");
    } finally {
      await faux.cleanup();
    }
  });

  it("inherits a bounded copy of the parent scratch namespace on continuation", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-inherit-");
    const parentRunId = "11111111-2222-4333-8444-555555555555";
    const parentScratch = join(config.runtime.scratchRoot, "runs", parentRunId);
    await mkdir(join(parentScratch, "work"), { recursive: true });
    await mkdir(join(parentScratch, "inputs"), { recursive: true });
    await writeFile(join(parentScratch, "solver.py"), "print('parent solver')\n");
    await writeFile(join(parentScratch, "work", "out.bin"), Buffer.from([1, 2, 3]));
    await writeFile(join(parentScratch, "inputs", "01-challenge.zip"), "re-staged-by-child");

    const faux = await registerFauxCli([
      assistantStep([textBlock("Reusing inherited parent work.")]),
      successResult("done"),
    ]);
    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run(
        { task: "Continue the parent analysis" },
        {
          lineage: {
            parentRunId,
            boundarySequence: 1,
            mode: "resume",
            inheritedEventCount: 1,
            context: "Parent run trajectory reference",
          },
        },
      );
      const childScratch = join(config.runtime.scratchRoot, "runs", state.id);
      await expect(readFile(join(childScratch, "solver.py"), "utf8")).resolves.toBe("print('parent solver')\n");
      await expect(readFile(join(childScratch, "work", "out.bin"))).resolves.toEqual(Buffer.from([1, 2, 3]));
      await expect(readFile(join(childScratch, "inputs", "01-challenge.zip"), "utf8")).rejects.toThrow();
      const records = await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"));
      const inherited = records.find((record) => record.type === "scratch.inherited");
      expect(inherited).toMatchObject({
        source: "orchestrator",
        actor: "run-manager",
        data: { parentRunId, files: 2 },
      });
      const context = records.find((record) => record.type === "context.injected");
      expect(JSON.stringify(context)).toContain("inherited-scratch");
    } finally {
      await faux.cleanup();
    }
  });

  it("runs normally when a continuation parent has no scratch directory", { timeout: 30_000 }, async () => {
    const { config } = await runtimeFixture("xuan-runtime-inherit-missing-");
    const faux = await registerFauxCli([
      assistantStep([textBlock("No parent scratch to reuse.")]),
      successResult("done"),
    ]);
    try {
      const runtime = new XuanShuRuntime(config, sdkOverrides(faux));
      const state = await runtime.run(
        { task: "Continue an old run" },
        {
          lineage: {
            parentRunId: "99999999-8888-4777-8666-555555555555",
            boundarySequence: 1,
            mode: "resume",
            inheritedEventCount: 1,
            context: "Parent run trajectory reference",
          },
        },
      );
      const records = await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"));
      expect(records.find((record) => record.type === "scratch.inherited")).toBeUndefined();
      expect(JSON.stringify(records.find((record) => record.type === "context.injected"))).not.toContain("inherited-scratch");
    } finally {
      await faux.cleanup();
    }
  });
});

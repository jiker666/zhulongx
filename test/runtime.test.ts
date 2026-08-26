import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
  type FauxProviderRegistration,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAuditChain } from "../src/audit.js";
import { createModel, XuanShuRuntime } from "../src/runtime.js";
import { startSandboxServer } from "../src/sandbox.js";
import { SharedEvidenceBoard } from "../src/shared-evidence.js";
import { readAuditRecords } from "../src/trace.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];
const registrations: FauxProviderRegistration[] = [];

afterEach(async () => {
  while (registrations.length > 0) registrations.pop()?.unregister();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("XuanShuRuntime", () => {
  it("redacts sensitive text from every persisted run artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-redaction-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const faux = registerFauxProvider();
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("Cookie: session=assistant-sensitive-cookie", { stopReason: "stop" }),
    ]);

    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
    const state = await runtime.run({ task: "Authorization: Bearer task-sensitive-value" });
    const runDirectory = join(config.runtime.artifactRoot, state.id);
    const persisted = (await Promise.all([
      readFile(join(runDirectory, "state.json"), "utf8"),
      readFile(join(runDirectory, "findings.json"), "utf8"),
      readFile(join(runDirectory, "transcript.json"), "utf8"),
      readFile(join(runDirectory, "audit.jsonl"), "utf8"),
    ])).join("\n");

    expect(persisted).not.toContain("task-sensitive-value");
    expect(persisted).not.toContain("assistant-sensitive-cookie");
    expect(persisted).toContain("[redacted]");
    expect(await verifyAuditChain(join(runDirectory, "audit.jsonl"))).toMatchObject({ valid: true });
  });

  it("generates and persists a dedicated writeup after a verified completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-writeup-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const faux = registerFauxProvider();
    registrations.push(faux);
    const markdown = ["---", "title: \"Demo\"", "ctf: \"Demo\"", "date: 2026-08-26", "category: crypto", "difficulty: easy", "points: 1", "flag_format: \"flag{...}\"", "author: \"Team\"", "---", "", "# Demo", "", "## Summary", "", "Solved the challenge.", "", "## Solution", "", "### Step 1: Solve", "", "```python", "print(\"flag{writer}\")", "```", "", "## Flag", "", "```", "flag{writer}", "```"].join("\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("finish_task", { status: "completed", summary: "The challenge was solved from deterministic evidence.", submission: "flag{writer}", evidence: ["verified"], remainingRisks: [], nextSteps: [], confidence: 1, verification: ["independent replay"], independentlyVerified: true }, { id: "finish-writeup" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(markdown, { stopReason: "stop" }),
    ]);
    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
    const state = await runtime.run({ task: "Demo challenge", metadata: { category: "crypto" } }, { writeup: true });
    expect(state.status).toBe("completed");
    expect(state.writeup).toContain("## Solution");
    expect(state.writeup).toContain("```python");
    expect(JSON.parse(await readFile(join(config.runtime.artifactRoot, state.id, "state.json"), "utf8")).writeup).toContain("flag{writer}");
    expect(await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))).toContainEqual(expect.objectContaining({ type: "writeup.generated" }));
  });

  it("shares bounded race evidence through policy-controlled audited tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-shared-evidence-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const faux = registerFauxProvider();
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_plan", {
        goal: "Publish one direct observation",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "share", objective: "Share evidence", successCriteria: ["Entry published"], tools: ["publish_shared_evidence"] }],
      }, { id: "shared-plan-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("publish_shared_evidence", {
        kind: "fact",
        claim: "The deterministic artifact begins with an ELF magic",
        evidence: ["inspect_artifact reported magic=elf"],
        confidence: 0.95,
      }, { id: "shared-publish" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("finish_task", {
        status: "blocked",
        summary: "Published a useful observation for the race.",
        evidence: ["shared board accepted the entry"],
        remainingRisks: ["No final answer"],
        nextSteps: [],
        confidence: 0.4,
        verification: ["The publish tool returned an entry id"],
        independentlyVerified: false,
      }, { id: "shared-finish-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("submit_plan", {
        goal: "Read teammate observations",
        assumptions: [],
        hypotheses: [],
        steps: [{ id: "read", objective: "Read evidence", successCriteria: ["Entry received"], tools: ["read_shared_evidence"] }],
      }, { id: "shared-plan-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_shared_evidence", { kinds: ["fact"], limit: 10 }, { id: "shared-read" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("finish_task", {
        status: "blocked",
        summary: "Read the shared observation but did not treat it as independently verified.",
        evidence: ["shared board returned the ELF observation"],
        remainingRisks: ["Independent reproduction remains"],
        nextSteps: [],
        confidence: 0.4,
        verification: ["The read tool returned one bounded entry"],
        independentlyVerified: false,
      }, { id: "shared-finish-2" }), { stopReason: "toolUse" }),
    ]);

    const board = new SharedEvidenceBoard();
    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
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
  });

  it("serializes initial model requests across runtime instances sharing one config", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-rate-gate-"));
    roots.push(root);
    const config = testConfig(root);
    config.runtime.modelMinIntervalMs = 50;
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const faux = registerFauxProvider({ models: [{ id: "faux-rate-gate" }] });
    registrations.push(faux);
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    const starts: number[] = [];
    const observedStream: StreamFn = (model, context, options) => {
      starts.push(Date.now());
      return streamSimple(model, context, options);
    };
    const first = new XuanShuRuntime(config, { streamFn: observedStream, model: faux.getModel() });
    const second = new XuanShuRuntime(config, { streamFn: observedStream, model: faux.getModel() });

    const states = await Promise.all([
      first.run({ task: "first rate-limited run" }),
      second.run({ task: "second rate-limited run" }),
    ]);

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(40);
    const reservations = (await Promise.all(states.map((state) =>
      readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))
    ))).flat().filter((record) => record.type === "model.request_reserved");
    expect(reservations).toHaveLength(2);
    expect(reservations.some((record) => Number((record.data as { waitedMs?: number }).waitedMs) >= 40)).toBe(true);
  });

  it("recovers an output-limit response without misclassifying it as a blocked task", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-length-recovery-"));
    roots.push(root);
    const config = testConfig(root);
    config.runtime.thinkingLevel = "medium";
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const faux = registerFauxProvider({ models: [{ id: "faux-length", reasoning: true }] });
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "length" }),
      () => fauxAssistantMessage(
          fauxToolCall("finish_task", {
            status: "completed",
            summary: "Recovered after a bounded output-limit continuation.",
            submission: "verified-answer",
            evidence: ["deterministic faux response"],
            remainingRisks: [],
            nextSteps: [],
            confidence: 0.95,
            verification: ["the continuation issued finish_task"],
            independentlyVerified: true,
          }, { id: "finish-after-length" }),
          { stopReason: "toolUse" },
        ),
    ]);

    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
    const state = await runtime.run({ task: "Recover a truncated model turn" });

    expect(state).toMatchObject({ status: "completed", submission: "verified-answer", turns: 2 });
    expect(await readAuditRecords(join(config.runtime.artifactRoot, state.id, "audit.jsonl"))).toContainEqual(expect.objectContaining({
      type: "model.length_recovery",
      data: expect.objectContaining({ attempt: 1, thinkingLevel: "low" }),
    }));
  });

  it("classifies exhausted output-limit recovery as a model failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-length-failure-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const faux = registerFauxProvider({ models: [{ id: "faux-length-failure", reasoning: true }] });
    registrations.push(faux);
    faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage([], { stopReason: "length" })));

    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
    const state = await runtime.run({ task: "Exhaust bounded output recovery" });

    expect(state).toMatchObject({ status: "failed", turns: 3 });
    expect(state.stopReason).toContain("output token limit after 2 recovery attempt(s)");
  });

  it("preserves xhigh reasoning for Responses-compatible models", () => {
    const config = testConfig("/tmp/xuan-responses-model");
    config.model.api = "openai-responses";
    config.model.reasoning = true;

    const model = createModel(config.model);

    expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(getSupportedThinkingLevels(model)).toContain("xhigh");
  });

  it("builds a model for an operator-managed Anthropic-compatible gateway", () => {
    const config = testConfig("/tmp/xuan-anthropic-model");
    config.model = {
      ...config.model,
      provider: "anthropic-compatible",
      id: "gateway-model",
      api: "anthropic-messages",
      baseUrl: "https://gateway.example.invalid/v1",
      apiKeyEnv: "MODEL_GATEWAY_KEY",
      reasoning: true,
    };

    const model = createModel(config.model);

    expect(model).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://gateway.example.invalid/v1",
      compat: {
        supportsEagerToolInputStreaming: false,
        supportsLongCacheRetention: false,
        supportsCacheControlOnTools: false,
      },
    });
  });

  it("sends Responses requests to the configured base URL with storage disabled", async () => {
    const config = testConfig("/tmp/xuan-responses-payload");
    config.model = {
      ...config.model,
      provider: "test-openai",
      id: "test-responses-model",
      api: "openai-responses",
      baseUrl: "https://gateway.example.invalid",
      reasoning: true,
    };
    const model = createModel(config.model) as Model<"openai-responses">;
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const captureFetch: typeof fetch = async (input, init) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      requestBody = JSON.parse(String(body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ error: { message: "captured by unit test" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const message = await streamOpenAIResponses(
      model,
      {
        systemPrompt: "Reply with pong.",
        messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
        tools: [],
      },
      {
        apiKey: "unit-test-only",
        reasoning: "xhigh",
        fetch: captureFetch,
        maxRetries: 0,
      },
    ).result();

    expect(message.stopReason).toBe("error");
    expect(requestUrl).toBe("https://gateway.example.invalid/responses");
    expect(requestBody).toMatchObject({
      model: "test-responses-model",
      stream: true,
      store: false,
      reasoning: { effort: "xhigh", summary: "auto" },
    });
  });

  it("runs a deterministic plan-observe-reflect-report loop on Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    await writeFile(join(config.scope.workspaceRoot, "sample.txt"), "service=demo\nstatus=healthy\n", "utf8");

    const faux = registerFauxProvider();
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "submit_plan",
          {
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
          },
          { id: "plan-1" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("inspect_artifact", { source: "workspace", path: "sample.txt" }, { id: "inspect-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall(
          "checkpoint",
          {
            observations: ["sample.txt exists"],
            assessment: "The input is available for bounded inspection",
            planChanges: [],
            nextAction: "Record the verified operational observation",
            hypotheses: [{
              hypothesis: "The sample contains useful service metadata",
              status: "supported",
              evidence: ["inspect_artifact recovered printable service metadata"],
            }],
          },
          { id: "checkpoint-1" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "record_finding",
          {
            title: "Sample evidence discovered",
            severity: "info",
            confidence: 0.95,
            description: "The authorized workspace contains sample.txt.",
            evidence: ["list_files returned sample.txt"],
            remediation: "No remediation required",
          },
          { id: "finding-1" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "finish_task",
          {
            status: "completed",
            summary: "已完成授权工作区的证据驱动检查。",
            evidence: ["sample.txt"],
            remainingRisks: ["未执行网络操作"],
            nextSteps: [],
            confidence: 0.95,
            verification: ["list_files independently confirmed sample.txt"],
            independentlyVerified: true,
          },
          { id: "finish-1" },
        ),
        { stopReason: "toolUse" },
      ),
    ]);

    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
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
  });

  it("records bounded binary searches as auditable local observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-artifact-search-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    await writeFile(join(config.scope.workspaceRoot, "firmware.bin"), Buffer.from([0x00, 0x41, 0x44, 0x4d, 0x49, 0x4e, 0x00]));
    const faux = registerFauxProvider();
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("submit_plan", {
          goal: "Search the supplied binary without executing it",
          assumptions: [],
          hypotheses: ["The binary contains the requested marker"],
          steps: [{ id: "search", objective: "Search a bounded byte prefix", successCriteria: ["Offsets returned"], tools: ["search_artifact"] }],
        }, { id: "search-plan" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("search_artifact", { source: "workspace", path: "firmware.bin", pattern: "ADMIN", encoding: "utf8" }, { id: "search-artifact" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("finish_task", {
          status: "blocked",
          summary: "The marker was observed, but no final task answer was requested.",
          evidence: ["search_artifact reported one ADMIN offset"],
          remainingRisks: ["No solve objective"],
          nextSteps: [],
          confidence: 0.4,
          verification: ["The bounded byte search returned the requested marker"],
          independentlyVerified: false,
        }, { id: "search-finish" }),
        { stopReason: "toolUse" },
      ),
    ]);

    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
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
  });

  it("audits an allowlisted sandbox program through the generic run_command tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-command-audit-"));
    roots.push(root);
    const config = testConfig(root);
    config.scope.allowedPrograms = ["node"];
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const sandbox = await startSandboxServer({
      socketPath: config.runtime.sandbox.socketPath,
      workspaceRoot: config.scope.workspaceRoot,
      scratchRoot: config.runtime.scratchRoot,
      allowedPrograms: ["node"],
      defaultTimeoutMs: config.runtime.commandTimeoutMs,
      maxOutputBytes: config.runtime.maxOutputBytes,
      network: "none",
    });
    const faux = registerFauxProvider();
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("submit_plan", {
          goal: "Run one bounded offline command",
          assumptions: ["The negotiated sandbox exposes node"],
          hypotheses: ["The command returns deterministic output"],
          steps: [{
            id: "command",
            objective: "Execute the allowlisted program",
            successCriteria: ["The expected output is returned"],
            tools: ["run_command"],
          }],
        }, { id: "command-plan" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("run_command", {
          program: "node",
          args: ["-e", "process.stdout.write('offline-ok')"],
        }, { id: "command-run" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("checkpoint", {
          observations: ["The allowlisted command returned offline-ok"],
          assessment: "The sandbox command completed within its bounds",
          planChanges: [],
          nextAction: "Finish with the audited command evidence",
        }, { id: "command-checkpoint" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("finish_task", {
          status: "completed",
          summary: "The bounded offline command completed.",
          evidence: ["run_command returned offline-ok"],
          remainingRisks: [],
          nextSteps: [],
          confidence: 1,
          verification: ["The sandbox returned exitCode=0 and offline-ok"],
          independentlyVerified: true,
        }, { id: "command-finish" }),
        { stopReason: "toolUse" },
      ),
    ]);

    try {
      const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
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
      await sandbox.close();
    }
  });

  it("returns image pixels to the model but redacts them from persisted artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-image-"));
    roots.push(root);
    const config = testConfig(root);
    config.runtime.maxImageBytes = 1024;
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const image = join(root, "clue.jpg");
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x43, 0x4c, 0x55, 0x45]);
    await writeFile(image, imageBytes);

    const faux = registerFauxProvider({ models: [{ id: "faux-visual", input: ["text", "image"] }] });
    registrations.push(faux);
    let observedContext: { messages?: unknown[] } | undefined;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "submit_plan",
          {
            goal: "Inspect the supplied image",
            assumptions: [],
            hypotheses: ["The image contains visual evidence"],
            steps: [{ id: "observe", objective: "Observe pixels", successCriteria: ["Pixels received"], tools: ["observe_image"] }],
          },
          { id: "plan-image" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("observe_image", { source: "workspace", path: "01-clue.jpg" }, { id: "image-1" }),
        { stopReason: "toolUse" },
      ),
      (_context) => {
        observedContext = _context;
        return fauxAssistantMessage(
          fauxToolCall(
            "checkpoint",
            {
              observations: ["The image was returned to the model"],
              assessment: "Visual evidence is available",
              planChanges: [],
              nextAction: "Finish with the bounded observation",
            },
            { id: "checkpoint-image" },
          ),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall(
          "finish_task",
          {
            status: "blocked",
            summary: "Image observed but no answer can be confirmed.",
            evidence: ["bounded image observation"],
            remainingRisks: ["No candidate"],
            nextSteps: [],
            confidence: 0.2,
            verification: ["The image tool returned a bounded result"],
            independentlyVerified: false,
          },
          { id: "finish-image" },
        ),
        { stopReason: "toolUse" },
      ),
    ]);

    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
    const state = await runtime.run({ task: "观察附件图片", attachments: [image] }, { workspaceMode: "attachments-only" });
    const encoded = imageBytes.toString("base64");
    const messages = JSON.stringify(observedContext?.messages ?? []);
    expect(messages).toContain(encoded);
    expect(state.imageObservations).toBe(1);
    const runDirectory = join(config.runtime.artifactRoot, state.id);
    const auditText = await readFile(join(runDirectory, "audit.jsonl"), "utf8");
    const transcriptText = await readFile(join(runDirectory, "transcript.json"), "utf8");
    expect(auditText).not.toContain(encoded);
    expect(transcriptText).not.toContain(encoded);
    expect(auditText).toContain("image.observed");
  });

  it("isolates attachments-only runs from stale shared workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-isolation-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    await writeFile(join(config.scope.workspaceRoot, "stale.txt"), "old task", "utf8");
    const current = join(root, "current.txt");
    await writeFile(current, "current task", "utf8");
    const faux = registerFauxProvider();
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "submit_plan",
          {
            goal: "List only current attachments",
            assumptions: [],
            hypotheses: [],
            steps: [{ id: "list", objective: "List inputs", successCriteria: ["Only current input appears"], tools: ["list_files"] }],
          },
          { id: "plan-isolation" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("list_files", { path: ".", depth: 2 }, { id: "list-isolation" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall(
          "finish_task",
          {
            status: "blocked",
            summary: "Inputs listed.",
            evidence: ["Current attachment only"],
            remainingRisks: ["No solve"],
            nextSteps: [],
            confidence: 0.2,
            verification: ["Bounded listing"],
            independentlyVerified: false,
          },
          { id: "finish-isolation" },
        ),
        { stopReason: "toolUse" },
      ),
    ]);
    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
    const state = await runtime.run({ task: "仅列出当前附件", attachments: [current] }, { workspaceMode: "attachments-only" });
    const auditText = await readFile(join(config.runtime.artifactRoot, state.id, "audit.jsonl"), "utf8");
    expect(auditText).toContain("01-current.txt");
    expect(auditText).not.toContain("stale.txt");
  });
});

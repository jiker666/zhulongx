import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AuditChain } from "../src/audit.js";
import type { PermissionGate } from "../src/permissions.js";
import { PolicyEngine } from "../src/policy.js";
import {
  createToolCallPipeline,
  createXuanShuMcpServer,
  toolParameterDefaults,
  toolParametersToZodShape,
  wrapXuanShuTools,
  XUANSHU_MCP_SERVER_NAME,
} from "../src/tool-adapter.js";
import { toolDescriptorMap, type ToolDescriptor } from "../src/tool-catalog.js";
import type { RunState, ToolShape } from "../src/types.js";
import { WebReasoningController } from "../src/web-reasoning/controller.js";
import { defaultWebReasoningConfig } from "../src/web-reasoning/state.js";
import { testConfig } from "./helpers.js";

interface RecordedEvent {
  sequence: number;
  type: string;
  data: unknown;
  metadata: Record<string, unknown>;
}

function fakeAudit() {
  let sequence = 0;
  const events: RecordedEvent[] = [];
  const audit = {
    events,
    async append(type: string, data: unknown, metadata: Record<string, unknown> = {}) {
      sequence += 1;
      const resolved = typeof data === "function"
        ? (data as (context: { previousSequence: number }) => unknown)({ previousSequence: sequence - 1 })
        : data;
      const event: RecordedEvent = { sequence, type, data: resolved, metadata };
      events.push(event);
      return { sequence, timestamp: new Date().toISOString(), runId: "run-1", type, data: resolved, previousHash: "", hash: "" };
    },
  };
  return audit as unknown as typeof audit & AuditChain;
}

const ECHO_DESCRIPTOR: ToolDescriptor = { name: "mcp.echo", source: "mcp", kind: "read", effect: "pure_readonly", executionMode: "parallel", capabilityRequirements: [], sideEffects: ["Echoes bounded text"], riskEvaluator: () => ({ level: "read", summary: "Echo", requiresApproval: false }) };
const LOOKUP_DESCRIPTOR: ToolDescriptor = { name: "mcp.lookup", source: "mcp", kind: "search", effect: "network", executionMode: "parallel", capabilityRequirements: [], sideEffects: ["Issues one read-only lookup"], networkTargetFields: ["url"], riskEvaluator: () => ({ level: "network", summary: "External lookup", requiresApproval: true }) };
const BOOM_DESCRIPTOR: ToolDescriptor = { name: "mcp.boom", source: "mcp", kind: "read", effect: "pure_readonly", executionMode: "parallel", capabilityRequirements: [], sideEffects: ["Fails on purpose"], riskEvaluator: () => ({ level: "read", summary: "Boom", requiresApproval: false }) };
const IMAGE_DESCRIPTOR: ToolDescriptor = { name: "mcp.image", source: "mcp", kind: "read", effect: "pure_readonly", executionMode: "parallel", capabilityRequirements: [], sideEffects: ["Returns an image"], riskEvaluator: () => ({ level: "read", summary: "Image", requiresApproval: false }) };

function echoTool(): ToolShape {
  return {
    name: "mcp.echo",
    label: "echo",
    description: "Echo text",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 100 }),
      times: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 1 })),
    }),
    async execute(_id, params) {
      // No ?? fallback: the wrapper must supply the typebox default.
      const input = params as { text: string; times: number };
      return { content: [{ type: "text" as const, text: input.text.repeat(input.times) }], details: { apiKey: "super-secret-key" } };
    },
  };
}

function lookupTool(): ToolShape {
  return {
    name: "mcp.lookup",
    label: "lookup",
    description: "Lookup",
    parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      const input = params as { url: string };
      return { content: [{ type: "text" as const, text: `looked up ${input.url}` }], details: { url: input.url } };
    },
  };
}

function finishTool(): ToolShape {
  return {
    name: "finish_task",
    label: "Finish",
    description: "Finish",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
      summary: Type.String({ minLength: 1 }),
      submission: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      evidence: Type.Array(Type.String()),
      remainingRisks: Type.Array(Type.String()),
      nextSteps: Type.Array(Type.String()),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      verification: Type.Array(Type.String()),
      independentlyVerified: Type.Boolean(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text" as const, text: (params as { summary: string }).summary }], details: params, terminate: true };
    },
  };
}

function boomTool(): ToolShape {
  return {
    name: "mcp.boom",
    label: "boom",
    description: "Throw",
    parameters: Type.Object({ message: Type.String() }),
    async execute(_id, params) {
      throw new Error((params as { message: string }).message);
    },
  };
}

function imageTool(): ToolShape {
  return {
    name: "mcp.image",
    label: "image",
    description: "Image",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: "observed" }, { type: "image" as const, data: "aGk=", mimeType: "image/png" }], details: {} };
    },
  };
}

function runState(): RunState {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    status: "running",
    phase: "exploration",
    task: { task: "test", attachments: [], metadata: {} },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    plan: { goal: "test", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "echo", successCriteria: [], tools: ["mcp.echo", "mcp.lookup", "mcp.boom", "mcp.image"] }] },
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "run-1",
    scratchRoot: "/tmp/scratch",
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 1,
    toolCalls: 0,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

interface HarnessOptions {
  external?: ToolDescriptor[];
  permissionGate?: PermissionGate;
  submissionPolicy?: "strict" | "advisory";
}

function harness(options: HarnessOptions = {}) {
  const config = testConfig("/tmp/xuan-tool-adapter");
  config.scope.mode = "controlled";
  config.scope.allowedHosts = ["lab.invalid"];
  const external = options.external ?? [ECHO_DESCRIPTOR];
  const run = runState();
  const audit = fakeAudit();
  const policy = new PolicyEngine(config.scope, config.runtime, external);
  const webReasoning = new WebReasoningController(run, audit, { ...defaultWebReasoningConfig, enabled: false });
  const emitted: Array<{ type: string; data: unknown }> = [];
  const persistCalls: RunState[] = [];
  const pipeline = createToolCallPipeline({
    state: run,
    runtime: config.runtime,
    audit,
    policy,
    descriptors: toolDescriptorMap(external),
    webReasoning,
    ...(options.permissionGate ? { permissionGate: options.permissionGate } : {}),
    submissionPolicy: options.submissionPolicy ?? "advisory",
    allowedToolNames: ["mcp.echo", "mcp.lookup", "mcp.boom", "mcp.image", "finish_task"],
    emit: (type, data) => {
      emitted.push({ type, data });
    },
    persistState: async (state) => {
      persistCalls.push(state);
    },
  });
  return { config, run, audit, policy, webReasoning, pipeline, emitted, persistCalls };
}

describe("toolParametersToZodShape", () => {
  const schema = Type.Object({
    name: Type.String({ minLength: 2, maxLength: 10 }),
    mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("slow")])),
    count: Type.Optional(Type.Integer({ minimum: 0, maximum: 9, default: 4 })),
    ratio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    flag: Type.Optional(Type.Boolean()),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 8 }), { minItems: 1, maxItems: 3 })),
    nested: Type.Optional(Type.Object({ inner: Type.Optional(Type.String()) })),
    index: Type.Optional(Type.Record(Type.String(), Type.Integer())),
    extra: Type.Optional(Type.Unknown()),
  });
  const shape = toolParametersToZodShape(schema);
  const defaults = toolParameterDefaults(schema);
  const parse = (input: unknown): unknown => ({ ...defaults, ...z.object(shape).parse(input) });

  it("parses valid input and applies typebox defaults after the raw parse", () => {
    expect(z.object(shape).parse({ name: "ab" })).toEqual({ name: "ab" });
    expect(parse({ name: "ab" })).toEqual({ name: "ab", count: 4 });
    expect(parse({
      name: "abcd",
      mode: "fast",
      ratio: 0.5,
      flag: true,
      tags: ["x", "yy"],
      nested: { inner: "v" },
      index: { a: 1 },
      extra: { anything: true },
    })).toEqual({ name: "abcd", mode: "fast", count: 4, ratio: 0.5, flag: true, tags: ["x", "yy"], nested: { inner: "v" }, index: { a: 1 }, extra: { anything: true } });
  });

  it("rejects out-of-bounds and mistyped input", () => {
    const validator = z.object(shape);
    expect(validator.safeParse({}).success).toBe(false);
    expect(validator.safeParse({ name: "a" }).success).toBe(false);
    expect(validator.safeParse({ name: "abcd", count: 10 }).success).toBe(false);
    expect(validator.safeParse({ name: "abcd", count: 1.5 }).success).toBe(false);
    expect(validator.safeParse({ name: "abcd", mode: "medium" }).success).toBe(false);
    expect(validator.safeParse({ name: "abcd", tags: [] }).success).toBe(false);
    expect(validator.safeParse({ name: "abcd", nested: { inner: 5 } }).success).toBe(false);
    expect(validator.safeParse({ name: "abcd", index: { a: 1.5 } }).success).toBe(false);
    expect(validator.safeParse({ name: "abcdefghijk" }).success).toBe(false);
  });

  it("unwraps single-variant unions", () => {
    const validator = z.object(toolParametersToZodShape(Type.Object({ mode: Type.Union([Type.Literal("only")]) })));
    expect(validator.parse({ mode: "only" })).toEqual({ mode: "only" });
    expect(validator.safeParse({ mode: "other" }).success).toBe(false);
  });

  it("throws loudly on unsupported schema shapes", () => {
    expect(() => toolParametersToZodShape(Type.String())).toThrow("Type.Object");
    expect(() => toolParametersToZodShape(Type.Object({ value: Type.Null() }))).toThrow("Unsupported typebox schema");
    expect(() => toolParametersToZodShape(Type.Object({ value: Type.Union([]) }))).toThrow("empty union");
  });

  it("converts cleanly through the Agent SDK's own registration, listing, and validation path", { timeout: 10_000 }, async () => {
    // Regression contract for SDK/zod copy drift: the SDK's bundled zod build
    // rejects absent ZodDefault fields ("expected nonoptional") and its
    // zod→JSON-Schema conversion crashes on foreign ZodRecord instances. The
    // converted shape must survive both paths.
    const server = createSdkMcpServer({
      name: XUANSHU_MCP_SERVER_NAME,
      version: "1.0.0",
      alwaysLoad: true,
      tools: [{
        name: "matrix",
        description: "SDK compatibility probe",
        inputSchema: shape,
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      }],
    });
    const client = new Client({ name: "probe", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(["matrix"]);
      const admitted = await client.callTool({ name: "matrix", arguments: { name: "ab" } });
      expect(admitted.isError).toBeUndefined();
      const rejected = await client.callTool({ name: "matrix", arguments: { name: "a" } });
      expect(rejected.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("wrapXuanShuTools", () => {
  it("runs the gate pipeline with full audit linkage and sanitized details", async () => {
    const h = harness();
    const tools = wrapXuanShuTools({ tools: [echoTool()], pipeline: h.pipeline });
    const result = await tools[0]!.invoke({ text: "hello" }, "call-1");
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(result.isError).toBeUndefined();
    expect(h.audit.events.map((event) => event.type)).toEqual(["tool.requested", "policy.decision", "tool.result"]);
    const [requested, decision, toolResult] = h.audit.events as [RecordedEvent, RecordedEvent, RecordedEvent];
    expect(requested.data).toMatchObject({ toolCallId: "call-1", toolName: "mcp.echo" });
    expect(requested.metadata.correlationId).toBe("call-1");
    expect(decision.metadata.parentSequence).toBe(requested.sequence);
    expect(decision.data).toMatchObject({ allowed: true });
    expect(toolResult.metadata.parentSequence).toBe(requested.sequence);
    expect(toolResult.data).toMatchObject({ toolCallId: "call-1", isError: false });
    expect(JSON.stringify(toolResult.data)).not.toContain("super-secret-key");
    expect(JSON.stringify(toolResult.data)).toContain("[redacted]");
    expect(h.run.toolCalls).toBe(1);
    expect(h.emitted.map((event) => event.type)).toEqual(["policy.decision", "tool.result"]);
    expect(h.persistCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects schema-invalid arguments before any pipeline side effects", async () => {
    const h = harness();
    const tools = wrapXuanShuTools({ tools: [echoTool()], pipeline: h.pipeline });
    const result = await tools[0]!.invoke({ text: "", times: 99 }, "call-1");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Invalid tool arguments") });
    expect(h.audit.events).toHaveLength(0);
    expect(h.run.toolCalls).toBe(0);
    expect(h.emitted).toHaveLength(0);
  });

  it("executes network tools regardless of configured host scope and records malformed-URL policy failures", async () => {
    const h = harness({ external: [LOOKUP_DESCRIPTOR] });
    const tools = wrapXuanShuTools({ tools: [lookupTool()], pipeline: h.pipeline });
    const result = await tools[0]!.invoke({ url: "https://outside.invalid/x" }, "call-1");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toMatchObject({ type: "text", text: "looked up https://outside.invalid/x" });
    expect(h.run.toolCalls).toBe(1);

    const rejected = await tools[0]!.invoke({ url: "not a url" }, "call-2");
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Invalid external tool URL") });
    expect(h.audit.events.map((event) => event.type)).toEqual([
      "tool.requested",
      "policy.decision",
      "tool.result",
      "tool.requested",
      "policy.decision",
    ]);
    const decision = h.audit.events[4]! as RecordedEvent;
    expect(decision.data).toMatchObject({ allowed: false });
    expect(h.run.lastFailure).toMatchObject({ classification: "policy", toolName: "mcp.lookup" });
    expect(h.run.strategyRevisionRequired).toBe(true);
  });

  it("routes approval-requiring tools through the permission gate", async () => {
    const gate: PermissionGate = {
      async authorize(input) {
        return {
          request: { id: "req-1", sessionId: input.sessionId, toolCallId: input.toolCallId, toolName: input.toolName, summary: "External lookup", risk: input.risk.level, args: input.args, createdAt: "", expiresAt: "" },
          decision: "deny",
          resolvedAt: "",
          source: "operator",
        };
      },
    };
    const h = harness({ external: [LOOKUP_DESCRIPTOR], permissionGate: gate });
    const tools = wrapXuanShuTools({ tools: [lookupTool()], pipeline: h.pipeline });
    const result = await tools[0]!.invoke({ url: "https://lab.invalid/evidence" }, "call-1");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "Tool permission denied (operator)" });
    expect(h.audit.events.map((event) => event.type)).toEqual(["tool.requested", "policy.decision", "permission.request", "permission.resolved"]);
    expect(h.audit.events[3]).toMatchObject({ data: { decision: "deny", source: "operator" } });
    expect(h.run.toolCalls).toBe(0);
  });

  it("approves and executes approval-requiring tools in authorized scope", async () => {
    const gate: PermissionGate = {
      async authorize(input) {
        return {
          request: { id: "req-1", sessionId: input.sessionId, toolCallId: input.toolCallId, toolName: input.toolName, summary: "External lookup", risk: input.risk.level, args: input.args, createdAt: "", expiresAt: "" },
          decision: "approve_once",
          resolvedAt: "",
          source: "policy",
        };
      },
    };
    const h = harness({ external: [LOOKUP_DESCRIPTOR], permissionGate: gate });
    const tools = wrapXuanShuTools({ tools: [lookupTool()], pipeline: h.pipeline });
    const result = await tools[0]!.invoke({ url: "https://lab.invalid/evidence" }, "call-1");
    expect(result).toEqual({ content: [{ type: "text", text: "looked up https://lab.invalid/evidence" }] });
    expect(h.run.toolCalls).toBe(1);
  });

  it("enforces the strict finish_task submission gate on grounded candidates", async () => {
    const h = harness({ submissionPolicy: "strict" });
    const tools = wrapXuanShuTools({ tools: [echoTool(), finishTool()], pipeline: h.pipeline });
    const finishArgs = {
      status: "completed" as const,
      summary: "done",
      submission: "flag-was-observed-42",
      evidence: [],
      remainingRisks: [],
      nextSteps: [],
      confidence: 1,
      verification: ["echo confirmed flag-was-observed-42"],
      independentlyVerified: true,
    };
    const ungrounded = await tools[1]!.invoke(finishArgs, "call-f1");
    expect(ungrounded.isError).toBe(true);
    expect(ungrounded.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Submission gate:") });
    expect(h.audit.events.map((event) => event.type)).toEqual(["tool.requested", "submission.validation"]);
    expect(h.run.submissionValidation).toMatchObject({ status: "pending" });
    expect(h.run.toolCalls).toBe(0);

    await tools[0]!.invoke({ text: "flag-was-observed-42" }, "call-1");
    await tools[0]!.invoke({ text: "flag-was-observed-42" }, "call-2");
    const accepted = await tools[1]!.invoke(finishArgs, "call-f2");
    expect(accepted.isError).toBeUndefined();
    expect(h.run.submissionValidation).toMatchObject({ status: "accepted" });
    expect(h.pipeline.isSettled()).toBe(true);
  });

  it("settles after a terminating tool and rejects further calls", async () => {
    const h = harness();
    const tools = wrapXuanShuTools({ tools: [echoTool(), finishTool()], pipeline: h.pipeline });
    const finished = await tools[1]!.invoke({
      status: "completed",
      summary: "done",
      evidence: [],
      remainingRisks: [],
      nextSteps: [],
      confidence: 1,
      verification: [],
      independentlyVerified: true,
    }, "call-f1");
    expect(finished.isError).toBeUndefined();
    expect(h.pipeline.isSettled()).toBe(true);
    expect(h.run.toolCalls).toBe(1);

    const after = await tools[0]!.invoke({ text: "hello" }, "call-2");
    expect(after.isError).toBe(true);
    expect(after.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("already been settled") });
    expect(h.audit.events.at(-1)).toMatchObject({ type: "tool.requested", data: { toolCallId: "call-2" } });
    expect(h.run.toolCalls).toBe(1);
  });

  it("converts tool throws into isError results with failure classification", async () => {
    const h = harness({ external: [BOOM_DESCRIPTOR] });
    const tools = wrapXuanShuTools({ tools: [boomTool()], pipeline: h.pipeline });
    const result = await tools[0]!.invoke({ message: "kaboom happened" }, "call-1");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "Tool execution failed: kaboom happened" });
    const toolResult = h.audit.events.at(-1) as RecordedEvent;
    expect(toolResult).toMatchObject({ type: "tool.result" });
    expect(toolResult.data).toMatchObject({ isError: true });
    expect(h.run.lastFailure).toMatchObject({ classification: "tool", toolName: "mcp.boom" });
    expect(h.run.strategyRevisionRequired).toBe(true);
    expect(h.emitted.at(-1)).toMatchObject({ type: "tool.result", data: { toolName: "mcp.boom", isError: true } });
  });

  it("returns image content to the model but omits it from persisted audit", async () => {
    const h = harness({ external: [IMAGE_DESCRIPTOR] });
    const tools = wrapXuanShuTools({ tools: [imageTool()], pipeline: h.pipeline });
    const result = await tools[0]!.invoke({}, "call-1");
    expect(result.content[1]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
    const toolResult = h.audit.events.at(-1) as RecordedEvent;
    const persisted = JSON.stringify(toolResult.data);
    expect(persisted).not.toContain("aGk=");
    expect(persisted).toContain("image omitted");
  });

  it("serializes concurrent invokes on one shared queue", async () => {
    const h = harness({ external: [ECHO_DESCRIPTOR, LOOKUP_DESCRIPTOR] });
    const order: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow: ToolShape = {
      name: "mcp.echo",
      label: "slow echo",
      description: "slow echo",
      parameters: Type.Object({ text: Type.String() }),
      async execute() {
        order.push("slow-start");
        await slowGate;
        order.push("slow-end");
        return { content: [{ type: "text" as const, text: "slow" }], details: {} };
      },
    };
    const quick: ToolShape = {
      name: "mcp.lookup",
      label: "quick lookup",
      description: "quick lookup",
      parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
      async execute() {
        order.push("quick");
        return { content: [{ type: "text" as const, text: "quick" }], details: {} };
      },
    };
    const tools = wrapXuanShuTools({ tools: [slow, quick], pipeline: h.pipeline });
    const slowPromise = tools[0]!.invoke({ text: "s" }, "call-1");
    const quickPromise = tools[1]!.invoke({ url: "https://lab.invalid/" }, "call-2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["slow-start"]);
    releaseSlow();
    await Promise.all([slowPromise, quickPromise]);
    expect(order).toEqual(["slow-start", "slow-end", "quick"]);
  });
});

describe("createXuanShuMcpServer", () => {
  it("builds the in-process xuanshu server", () => {
    const h = harness();
    const server = createXuanShuMcpServer({ tools: [echoTool()], pipeline: h.pipeline, timeoutMs: 120_000 });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(XUANSHU_MCP_SERVER_NAME);
    expect(server.timeout).toBe(120_000);
    expect(typeof server.instance.connect).toBe("function");
  });
});

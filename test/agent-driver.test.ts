import { describe, expect, it } from "vitest";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  buildAgentSubprocessEnv,
  createAgentSession,
  runSdkSingleShot,
  sdkThinkingConfig,
  type AgentDriverEventType,
} from "../src/agent-driver.js";
import { assistantStep, registerFauxCli, successResult, textBlock, toolUseBlock } from "./faux-cli.js";

// Driver tests drive the real SDK against the faux CLI: the session loop,
// event translation, recovery injection, abort, and the settled guard all run
// exactly as in production — only the "model" is scripted.
const FAUX_BASE_URL = "http://127.0.0.1:9";

interface CapturedEvent {
  type: AgentDriverEventType;
  data: unknown;
}

function echoServer(calls: Array<{ id: string; args: unknown }> = []): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: "xuanshu",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [{
      name: "echo",
      description: "Echo a value",
      inputSchema: { value: z.string() },
      handler: async (args: unknown, extra: unknown) => {
        const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
        calls.push({ id: String(meta?.["claudecode/toolUseId"] ?? "missing"), args });
        return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
      },
    }],
  });
}

function testEnv(faux: { scriptPath: string; logPath: string }): Record<string, string> {
  return {
    XUANSHU_FAUX_CLI_SCRIPT: faux.scriptPath,
    XUANSHU_FAUX_CLI_LOG: faux.logPath,
  };
}

describe("sdkThinkingConfig", () => {
  it("maps levels to SDK thinking configs", () => {
    expect(sdkThinkingConfig("off")).toEqual({ type: "disabled" });
    expect(sdkThinkingConfig("high")).toEqual({ type: "enabled", budgetTokens: 20_480 });
  });
});

describe("buildAgentSubprocessEnv", () => {
  it("pins the gateway route, neutralizes model overrides, and hides credentials", () => {
    const env = buildAgentSubprocessEnv({
      baseUrl: "http://127.0.0.1:4567/run/abc",
      modelId: "deepseek-v4-flash",
      configDir: "/tmp/xyz",
      extra: { XUANSHU_TEST_MARK: "1" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4567/run/abc");
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash");
    // The gateway strips client credentials and injects the real upstream key,
    // so the subprocess only ever holds a placeholder.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("xuanshu-gateway-placeholder");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/xyz");
    expect(env.XUANSHU_TEST_MARK).toBe("1");
  });
});

describe("createAgentSession", () => {
  it("runs a tool round trip and translates SDK frames into driver events", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      assistantStep([toolUseBlock("toolu_1", "mcp__xuanshu__echo", { value: "ping" })]),
      assistantStep([textBlock("Done after the echo.")]),
      successResult("Done after the echo."),
    ]);
    const calls: Array<{ id: string; args: unknown }> = [];
    const events: CapturedEvent[] = [];
    const session = createAgentSession({
      runId: "run-driver-1",
      systemPrompt: "You are a test agent.",
      modelId: "faux-model",
      baseUrl: FAUX_BASE_URL,
      thinkingLevel: "off",
      mcpServer: echoServer(calls),
      sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
      onEvent: (type, data) => {
        events.push({ type, data });
      },
    });
    let result;
    try {
      session.prompt("Run the echo tool.");
      result = await session.done;
    } finally {
      await faux.cleanup();
    }

    expect(calls).toEqual([{ id: "toolu_1", args: { value: "ping" } }]);
    expect(result.subtype).toBe("success");
    expect(result.aborted).toBe(false);
    expect(result.resultText).toBe("Done after the echo.");
    expect(result.numTurns).toBe(2);
    const turnStarts = events.filter((event) => event.type === "turn.started");
    expect(turnStarts.map((event) => (event.data as { turn: number }).turn)).toEqual([1, 2]);
    expect(events.filter((event) => event.type === "tool.started")).toEqual([{ type: "tool.started", data: { toolName: "mcp__xuanshu__echo" } }]);
    const assistantMessages = events.filter((event) => event.type === "assistant.message");
    expect(assistantMessages).toHaveLength(2);
    const lastMessage = assistantMessages.at(-1)!.data as { stop_reason?: unknown; content?: Array<{ type: string }> };
    expect(lastMessage.stop_reason).toBe("end_turn");
    expect(lastMessage.content).toEqual([{ type: "text", text: "Done after the echo." }]);
    // The transcript keeps one merged entry per assistant turn.
    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("injects a length recovery prompt when a turn ends with max_tokens", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      { type: "assistant", content: [textBlock("Truncated mid-analysis")], stopReason: "max_tokens" },
      { type: "result", subtype: "success", result: "", stopReason: "max_tokens" },
      assistantStep([textBlock("Resumed and finished.")]),
      successResult("Resumed and finished."),
    ]);
    const events: CapturedEvent[] = [];
    const session = createAgentSession({
      runId: "run-driver-2",
      systemPrompt: "You are a test agent.",
      modelId: "faux-model",
      baseUrl: FAUX_BASE_URL,
      thinkingLevel: "medium",
      mcpServer: echoServer(),
      sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
      onEvent: (type, data) => {
        events.push({ type, data });
      },
    });
    let result;
    let received: unknown[] = [];
    try {
      session.prompt("Start.");
      result = await session.done;
      received = await faux.receivedUserMessages();
    } finally {
      await faux.cleanup();
    }

    expect(result.subtype).toBe("success");
    expect(result.numTurns).toBe(2);
    const recovery = events.find((event) => event.type === "model.length_recovery");
    expect(recovery?.data).toMatchObject({
      attempt: 1,
      maximumAttempts: 2,
      // Per-turn downgrade is impossible under the SDK; the audit records the
      // session-level downgrade the old runtime would have applied.
      thinkingLevel: "low",
    });
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(received[received.length - 1])).toContain("exhausted its output budget");
  });

  it("injects a no-action recovery prompt when a turn ends empty", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      assistantStep([]),
      successResult(""),
      assistantStep([textBlock("Recovered with a tool call.")]),
      successResult("Recovered with a tool call."),
    ]);
    const events: CapturedEvent[] = [];
    const session = createAgentSession({
      runId: "run-driver-3",
      systemPrompt: "You are a test agent.",
      modelId: "faux-model",
      baseUrl: FAUX_BASE_URL,
      thinkingLevel: "off",
      mcpServer: echoServer(),
      sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
      onEvent: (type, data) => {
        events.push({ type, data });
      },
    });
    let result;
    let received: unknown[] = [];
    try {
      session.prompt("Start.");
      result = await session.done;
      received = await faux.receivedUserMessages();
    } finally {
      await faux.cleanup();
    }

    expect(result.subtype).toBe("success");
    const recovery = events.find((event) => event.type === "model.no_action_recovery");
    expect(recovery?.data).toMatchObject({ attempt: 1, maximumAttempts: 2 });
    expect(JSON.stringify(received.at(-1))).toContain("ended without a structured tool call");
  });

  it("recovers from the result frame stop_reason when assistant frames carry none", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      // Per-block assistant frames share a message id and carry stop_reason
      // null; the authoritative stop_reason only arrives on the result frame.
      { type: "assistant", content: [textBlock("Truncated")], stopReason: null },
      { type: "result", subtype: "success", result: "", stopReason: "max_tokens" },
      assistantStep([textBlock("Resumed.")]),
      successResult("Resumed."),
    ]);
    const events: CapturedEvent[] = [];
    const session = createAgentSession({
      runId: "run-driver-4",
      systemPrompt: "You are a test agent.",
      modelId: "faux-model",
      baseUrl: FAUX_BASE_URL,
      thinkingLevel: "low",
      mcpServer: echoServer(),
      sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
      onEvent: (type, data) => {
        events.push({ type, data });
      },
    });
    let result;
    let received: unknown[] = [];
    try {
      session.prompt("Start.");
      result = await session.done;
      received = await faux.receivedUserMessages();
    } finally {
      await faux.cleanup();
    }

    expect(result.subtype).toBe("success");
    expect(events.find((event) => event.type === "model.length_recovery")?.data).toMatchObject({ attempt: 1, thinkingLevel: "low" });
    expect(JSON.stringify(received.at(-1))).toContain("exhausted its output budget");
  });

  it("emits context.compacted and model.provider_retry system translations", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", pre_tokens: 80_000, post_tokens: 20_000 } },
      { type: "system", subtype: "api_retry", attempt: 2, maxRetries: 5, retryDelayMs: 8_000, errorStatus: 529, errorMessage: "overloaded" },
      assistantStep([textBlock("Steady.")]),
      successResult("Steady."),
    ]);
    const events: CapturedEvent[] = [];
    const session = createAgentSession({
      runId: "run-driver-5",
      systemPrompt: "You are a test agent.",
      modelId: "faux-model",
      baseUrl: FAUX_BASE_URL,
      thinkingLevel: "off",
      mcpServer: echoServer(),
      sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
      onEvent: (type, data) => {
        events.push({ type, data });
      },
    });
    let result;
    try {
      session.prompt("Start.");
      result = await session.done;
    } finally {
      await faux.cleanup();
    }

    expect(result.subtype).toBe("success");
    expect(events.find((event) => event.type === "context.compacted")?.data).toMatchObject({
      trigger: "manual",
      preTokens: 80_000,
      postTokens: 20_000,
    });
    expect(events.find((event) => event.type === "model.provider_retry")?.data).toMatchObject({
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 8_000,
      errorStatus: 529,
      error: "overloaded",
    });
  });

  it("aborts with the caller-supplied reason", { timeout: 20_000 }, async () => {
    // No terminal result step: the faux CLI stays idle after the assistant
    // frame, so the only way out is the abort.
    const faux = await registerFauxCli([assistantStep([textBlock("Working...")])]);
    const session = createAgentSession({
      runId: "run-driver-6",
      systemPrompt: "You are a test agent.",
      modelId: "faux-model",
      baseUrl: FAUX_BASE_URL,
      thinkingLevel: "off",
      mcpServer: echoServer(),
      sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
    });
    let result;
    try {
      session.prompt("Start.");
      await new Promise((resolve) => setTimeout(resolve, 400));
      session.abort("Turn budget exhausted");
      result = await session.done;
    } finally {
      await faux.cleanup();
    }

    expect(result.aborted).toBe(true);
    expect(result.subtype).toBe("aborted");
    expect(result.abortReason).toBe("Turn budget exhausted");
  });

  it("aborts once a settled run keeps issuing tool turns", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      assistantStep([toolUseBlock("toolu_s1", "mcp__xuanshu__echo", { value: "again" })]),
      assistantStep([toolUseBlock("toolu_s2", "mcp__xuanshu__echo", { value: "again" })]),
      assistantStep([toolUseBlock("toolu_s3", "mcp__xuanshu__echo", { value: "again" })]),
      successResult("never reached"),
    ]);
    const session = createAgentSession({
      runId: "run-driver-7",
      systemPrompt: "You are a test agent.",
      modelId: "faux-model",
      baseUrl: FAUX_BASE_URL,
      thinkingLevel: "off",
      mcpServer: echoServer(),
      isSettled: () => true,
      sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
    });
    let result;
    try {
      session.prompt("Start.");
      result = await session.done;
    } finally {
      await faux.cleanup();
    }

    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("Agent kept issuing tool calls after the task was settled");
  });
});

describe("runSdkSingleShot", () => {
  it("returns the final result text without MCP servers", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      assistantStep([textBlock("The writeup body.")]),
      { type: "result", subtype: "success", result: "The writeup body.", stopReason: "end_turn" },
    ]);
    let single;
    try {
      single = await runSdkSingleShot({
        prompt: "Write the report.",
        systemPrompt: "You write reports.",
        modelId: "faux-model",
        baseUrl: FAUX_BASE_URL,
        thinkingLevel: "off",
        sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: testEnv(faux) },
      });
    } finally {
      await faux.cleanup();
    }

    expect(single.isError).toBe(false);
    expect(single.resultText).toBe("The writeup body.");
  });
});

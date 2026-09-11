import { describe, expect, it } from "vitest";
import {
  estimateAnthropicRequestTokens,
  estimateModelRequestTokens,
  ModelRequestGate,
} from "../src/model-rate-limit.js";

const model = { maxTokens: 4_096 };

function gateWithClock() {
  let now = 0;
  const sleeps: number[] = [];
  const gate = new ModelRequestGate({
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  return { gate, sleeps, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("ModelRequestGate", () => {
  it("enforces the rolling request budget deterministically", async () => {
    const { gate, sleeps } = gateWithClock();
    const limits = { minimumIntervalMs: 0, requestsPerMinute: 2, tokensPerMinute: 0, estimatedTokens: 1 };

    await gate.wait(limits);
    await gate.wait(limits);
    const third = await gate.wait(limits);

    expect(sleeps).toEqual([60_000]);
    expect(third.waitedMs).toBe(60_000);
  });

  it("waits for enough rolling token budget to expire", async () => {
    const { gate, sleeps } = gateWithClock();
    const limits = { minimumIntervalMs: 0, requestsPerMinute: 0, tokensPerMinute: 100, estimatedTokens: 60 };

    await gate.wait(limits);
    const second = await gate.wait(limits);

    expect(sleeps).toEqual([60_000]);
    expect(second).toMatchObject({ estimatedTokens: 60, waitedMs: 60_000 });
  });

  it("rejects a single request that cannot fit inside the configured TPM budget", async () => {
    const { gate } = gateWithClock();

    await expect(gate.wait({
      minimumIntervalMs: 0,
      requestsPerMinute: 0,
      tokensPerMinute: 100,
      estimatedTokens: 101,
    })).rejects.toThrow("exceeds configured modelTokensPerMinute");
  });

  it("cancels a blocked request through its AbortSignal", async () => {
    const gate = new ModelRequestGate();
    const limits = { minimumIntervalMs: 0, requestsPerMinute: 1, tokensPerMinute: 0, estimatedTokens: 1 };
    await gate.wait(limits);
    const controller = new AbortController();
    const blocked = gate.wait(limits, controller.signal);
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));

    controller.abort(new Error("operator stopped the run"));

    await expect(blocked).rejects.toThrow("operator stopped the run");
  });

  it("true-ups the rolling token window with actual provider usage", async () => {
    const { gate, sleeps } = gateWithClock();
    const limits = { minimumIntervalMs: 0, requestsPerMinute: 0, tokensPerMinute: 100, estimatedTokens: 10 };

    const first = await gate.wait(limits);
    expect(first.estimatedTokens).toBe(10);

    gate.recordActualTokens(first.entryId, 85);
    // 85 + 10 fits, so the second request is admitted without waiting.
    await gate.wait(limits);
    // The estimate was 10 but the window now holds 85 + 10 actual/estimated
    // tokens, so a third request has to wait for the trued-up entry to expire.
    await gate.wait(limits);

    expect(sleeps).toEqual([60_000]);
  });

  it("ignores true-ups for entries outside the rolling window", async () => {
    const { gate, sleeps, advance } = gateWithClock();
    const limits = { minimumIntervalMs: 0, requestsPerMinute: 0, tokensPerMinute: 100, estimatedTokens: 10 };

    const first = await gate.wait(limits);
    advance(60_001);
    gate.recordActualTokens(first.entryId, 1_000);
    const third = await gate.wait(limits);

    expect(third.waitedMs).toBe(0);
    expect(sleeps).toEqual([]);
  });
});

describe("estimateModelRequestTokens (legacy context shapes)", () => {
  it("reserves at least the configured output budget for a small initial request", () => {
    const context = { systemPrompt: "system", messages: [], tools: [] };
    expect(estimateModelRequestTokens(model, context)).toBe(4_096);
  });

  it("uses reported usage plus trailing tool output for a growing context", () => {
    const context = {
      systemPrompt: "system",
      tools: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "analysis" }],
          usage: {
            input: 18_000,
            output: 2_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20_000,
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: "x".repeat(400) }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    expect(estimateModelRequestTokens(model, context)).toBe(20_100);
  });
});

describe("estimateAnthropicRequestTokens", () => {
  it("floors the estimate at the requested output budget", () => {
    expect(estimateAnthropicRequestTokens({ model: "m", max_tokens: 8_192, messages: [] })).toBe(8_192);
  });

  it("estimates text, tool calls, and tool results from a raw request body", () => {
    const request = {
      system: "system prompt (20 chars)",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "x".repeat(400) }],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "run_command", input: { program: "python3", args: ["-c", "print(1)"] } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(80) }],
        },
      ],
      tools: [{ name: "run_command", description: "bounded execution", input_schema: { type: "object" } }],
    };
    const estimate = estimateAnthropicRequestTokens(request);
    // 400 text chars + tool call + tool result + serialized tools + system,
    // divided by 4 — comfortably above the 16-token output floor.
    expect(estimate).toBeGreaterThan(100);
    expect(estimate).toBeLessThan(400);
  });

  it("counts images at a fixed allowance and falls back to a default output budget", () => {
    const request = {
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "a".repeat(2_000) } }] }],
    };
    expect(estimateAnthropicRequestTokens(request)).toBe(1_200);
  });

  it("returns the fallback budget for non-object bodies", () => {
    expect(estimateAnthropicRequestTokens(null)).toBe(4_096);
    expect(estimateAnthropicRequestTokens("nope", 128)).toBe(128);
  });
});

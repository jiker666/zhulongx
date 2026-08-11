import type { Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateModelRequestTokens, ModelRequestGate } from "../src/model-rate-limit.js";

const model: Model<string> = {
  id: "rate-limit-test",
  name: "Rate Limit Test",
  api: "openai-completions",
  provider: "faux",
  baseUrl: "http://localhost:0",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

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
  return { gate, sleeps };
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
});

describe("estimateModelRequestTokens", () => {
  it("reserves at least the configured output budget for a small initial request", () => {
    const context: Context = { systemPrompt: "system", messages: [], tools: [] };
    expect(estimateModelRequestTokens(model, context)).toBe(4_096);
  });

  it("uses reported usage plus trailing tool output for a growing context", () => {
    const context: Context = {
      systemPrompt: "system",
      tools: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "analysis" }],
          api: "openai-completions",
          provider: "faux",
          model: model.id,
          usage: {
            input: 18_000,
            output: 2_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_file",
          content: [{ type: "text", text: "x".repeat(400) }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    expect(estimateModelRequestTokens(model, context)).toBe(20_100);
  });
});

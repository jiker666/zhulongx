import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectModelMessages } from "../src/context-projection.js";

function messages(): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (let index = 0; index < 8; index += 1) {
    result.push({ role: "user", content: `request ${index} ${"x".repeat(400)}`, timestamp: index * 2 });
    result.push({
      role: "assistant",
      content: [{ type: "thinking", thinking: `hidden-${index}` }, { type: "text", text: `public result ${index} Authorization: Bearer sensitive-token` }],
      api: "openai-completions",
      provider: "faux",
      model: "faux",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: index * 2 + 1,
    });
  }
  return result;
}

describe("model context projection", () => {
  it("keeps short contexts unchanged", () => {
    const source = messages().slice(0, 2);
    expect(projectModelMessages(source, { contextWindow: 100_000, compactAtRatio: 0.9, keepRecentTokens: 1_000, maxSummaryChars: 2_000 }).messages).toBe(source);
  });

  it("summarizes only the model projection and keeps a complete recent turn", () => {
    const source = messages();
    const projected = projectModelMessages(source, { contextWindow: 1_000, compactAtRatio: 0.2, keepRecentTokens: 300, maxSummaryChars: 2_000 });
    expect(projected.cut).toBeDefined();
    expect(projected.messages.length).toBeLessThan(source.length);
    expect(projected.messages[0]).toMatchObject({ role: "user" });
    expect(projected.messages[1]?.role).toBe("user");
    const serialized = JSON.stringify(projected.messages[0]);
    expect(serialized).not.toContain("hidden-");
    expect(serialized).not.toContain("sensitive-token");
    expect(serialized).toContain("[redacted]");
    expect(source).toHaveLength(16);
  });

  it("is deterministic for the same input and policy", () => {
    const source = messages();
    const policy = { contextWindow: 1_000, compactAtRatio: 0.2, keepRecentTokens: 300, maxSummaryChars: 2_000 };
    expect(projectModelMessages(source, policy)).toEqual(projectModelMessages(source, policy));
  });
});

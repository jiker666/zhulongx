import { describe, expect, it } from "vitest";
import { inferTrajectorySource, modelContextSnapshot } from "../src/session-trajectory.js";

describe("session trajectory", () => {
  it("classifies event producers for source-oriented replay", () => {
    expect(inferTrajectorySource("model.context")).toBe("model");
    expect(inferTrajectorySource("context.injected")).toBe("context");
    expect(inferTrajectorySource("policy.decision")).toBe("policy");
    expect(inferTrajectorySource("tool.result")).toBe("tool");
    expect(inferTrajectorySource("session.forked")).toBe("orchestrator");
  });

  it("records the public model-visible context without hidden reasoning, secrets, or pixels", () => {
    const context = {
      systemPrompt: "Use Authorization: Bearer super-secret-value only for this test",
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain" },
          { type: "text", text: "public rationale" },
          { type: "image", data: Buffer.from("pixels").toString("base64"), mimeType: "image/png" },
        ],
        timestamp: Date.now(),
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
      }],
      tools: [],
    } as unknown as Parameters<typeof modelContextSnapshot>[0];
    const snapshot = modelContextSnapshot(context);
    const persisted = JSON.stringify(snapshot);
    expect(persisted).toContain("public rationale");
    expect(persisted).toContain("hiddenReasoningOmitted");
    expect(persisted).toContain("image omitted from persisted artifacts");
    expect(persisted).not.toContain("private chain");
    expect(persisted).not.toContain("super-secret-value");
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});

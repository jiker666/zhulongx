import { describe, expect, it } from "vitest";
import { isTerminalReason, isTransientTerminalReason, terminalReasonHint } from "../src/terminal-reason.js";
import { shouldRetryRunFailure } from "../src/manual-jobs.js";

describe("terminal reason taxonomy", () => {
  it("covers every reason with an actionable operator hint", () => {
    for (const reason of [
      "agent_completed",
      "agent_blocked",
      "ended_without_finish",
      "output_limit",
      "model_error",
      "operator_abort",
      "infrastructure_error",
    ] as const) {
      expect(isTerminalReason(reason)).toBe(true);
      const hint = terminalReasonHint(reason);
      expect(hint.length).toBeGreaterThan(20);
    }
    expect(isTerminalReason("failed")).toBe(false);
    expect(isTerminalReason(undefined)).toBe(false);
  });

  it("treats only transient provider failures as retryable", () => {
    expect(isTransientTerminalReason("model_error", { code: "rate_limit", message: "429", retryable: true })).toBe(true);
    expect(isTransientTerminalReason("model_error", { code: "network", message: "econnreset", retryable: true })).toBe(true);
    expect(isTransientTerminalReason("model_error", { code: "quota", message: "billing", retryable: false })).toBe(false);
    expect(isTransientTerminalReason("model_error", { code: "unknown", message: "?", retryable: false })).toBe(false);
    expect(isTransientTerminalReason("model_error")).toBe(false);
    expect(isTransientTerminalReason("output_limit")).toBe(false);
    expect(isTransientTerminalReason("agent_blocked")).toBe(false);
    expect(isTransientTerminalReason("operator_abort")).toBe(false);
    expect(isTransientTerminalReason("infrastructure_error")).toBe(false);
  });

  it("prefers the structured reason and falls back to legacy stop text", () => {
    expect(shouldRetryRunFailure({
      terminalReason: "model_error",
      providerError: { code: "server", message: "503", retryable: true },
      stopReason: "irrelevant legacy text",
    })).toBe(true);
    // Structured reason wins even when legacy text would have matched.
    expect(shouldRetryRunFailure({
      terminalReason: "agent_blocked",
      stopReason: "connection error during sweep",
    })).toBe(false);
    // Pre-taxonomy runs still retry on the legacy regex.
    expect(shouldRetryRunFailure({ stopReason: "fetch failed after retries" })).toBe(true);
    expect(shouldRetryRunFailure({ stopReason: "Agent reported a blocker" })).toBe(false);
  });
});

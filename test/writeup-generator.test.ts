import { describe, expect, it } from "vitest";
import type { NormalizedTask, RunState } from "../src/types.js";
import { generateWriteup } from "../src/writeup-generator.js";
import { assistantStep, registerFauxCli } from "./faux-cli.js";

function state(): RunState {
  const now = new Date().toISOString();
  return {
    id: "run-writeup", status: "completed", phase: "done",
    task: { task: "Solve a crypto challenge", attachments: [], metadata: { category: "crypto" } },
    createdAt: now, updatedAt: now, finishedAt: now, findings: [], lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false,
    sandboxNamespace: "run-writeup", scratchRoot: "/tmp/run-writeup", workspaceMode: "attachments-only", appliedExperienceIds: [],
    submission: "flag{verified}", summary: "Recovered the plaintext and verified the transformation.", verification: ["Round trip matched"], independentlyVerified: true,
    turns: 2, toolCalls: 3, imageObservations: 0, httpRequests: 0, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {},
  };
}

const GOOD_WRITEUP = [
  "---", "title: \"Crypto Challenge\"", "ctf: \"Demo\"", "date: 2026-08-26", "category: crypto", "difficulty: easy", "points: 100", "flag_format: \"flag{...}\"", "author: \"Team\"", "---", "",
  "# Crypto Challenge", "", "## Summary", "", "Recovered the plaintext with the documented transformation.", "", "## Solution", "", "### Step 1: Decrypt", "", "```python", "print(\"flag{verified}\")", "```", "", "## Flag", "", "```", "flag{verified}", "```",
].join("\n");

describe("generateWriteup", () => {
  it("asks a dedicated model for a complete standard writeup", { timeout: 20_000 }, async () => {
    const faux = await registerFauxCli([
      assistantStep([{ type: "text", text: GOOD_WRITEUP }]),
      { type: "result", subtype: "success", result: GOOD_WRITEUP, stopReason: "end_turn" },
    ]);
    try {
      const task = state().task as NormalizedTask;
      const result = await generateWriteup({
        runId: "run-writeup",
        task,
        state: state(),
        transcript: [{ role: "assistant", content: [{ type: "text", text: "public evidence" }] }],
        modelId: "faux-model",
        baseUrl: "http://127.0.0.1:9",
        sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: faux.env },
        timeoutMs: 15_000,
      });
      expect(result.attempts).toBe(1);
      expect(result.markdown).toContain("## Solution");
      expect(result.markdown).toContain("```python");
      expect(result.markdown).toContain("flag{verified}");
    } finally {
      await faux.cleanup();
    }
  });

  it("rewrites a draft that fails validation on the second attempt", { timeout: 20_000 }, async () => {
    // The cursor shares one script across the two single-shot subprocesses:
    // attempt 1 consumes the bad draft, attempt 2 continues to the good one.
    const faux = await registerFauxCli([
      assistantStep([{ type: "text", text: "not a writeup at all" }]),
      { type: "result", subtype: "success", result: "not a writeup at all", stopReason: "end_turn" },
      assistantStep([{ type: "text", text: GOOD_WRITEUP }]),
      { type: "result", subtype: "success", result: GOOD_WRITEUP, stopReason: "end_turn" },
    ], { cursor: true });
    try {
      const task = state().task as NormalizedTask;
      const result = await generateWriteup({
        runId: "run-writeup-retry",
        task,
        state: state(),
        transcript: [],
        modelId: "faux-model",
        baseUrl: "http://127.0.0.1:9",
        sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: faux.env },
        timeoutMs: 15_000,
      });
      expect(result.attempts).toBe(2);
      expect(result.markdown).toContain("## Flag");
      expect(result.markdown).toContain("flag{verified}");
    } finally {
      await faux.cleanup();
    }
  });
});

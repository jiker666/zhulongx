import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import type { NormalizedTask, RunState } from "../src/types.js";
import { generateWriteup } from "../src/writeup-generator.js";

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

describe("generateWriteup", () => {
  it("asks a dedicated model for a complete standard writeup", async () => {
    const faux = registerFauxProvider();
    try {
      const markdown = [
        "---", "title: \"Crypto Challenge\"", "ctf: \"Demo\"", "date: 2026-08-26", "category: crypto", "difficulty: easy", "points: 100", "flag_format: \"flag{...}\"", "author: \"Team\"", "---", "",
        "# Crypto Challenge", "", "## Summary", "", "Recovered the plaintext with the documented transformation.", "", "## Solution", "", "### Step 1: Decrypt", "", "```python", "print(\"flag{verified}\")", "```", "", "## Flag", "", "```", "flag{verified}", "```",
      ].join("\n");
      faux.setResponses([fauxAssistantMessage(markdown, { stopReason: "stop" })]);
      const task = state().task as NormalizedTask;
      const result = await generateWriteup({ runId: "run-writeup", task, state: state(), transcript: [{ role: "assistant", content: [{ type: "text", text: "public evidence" }] }], model: faux.getModel(), streamFn: streamSimple, timeoutMs: 2_000 });
      expect(result.attempts).toBe(1);
      expect(result.markdown).toContain("## Solution");
      expect(result.markdown).toContain("```python");
      expect(result.markdown).toContain("flag{verified}");
    } finally { faux.unregister(); }
  });
});

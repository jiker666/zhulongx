import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/system-prompt.js";

const scope = { mode: "observe", workspaceRoot: "/workspace", allowedPrograms: [], allowedHosts: [], networkEgress: "sandbox" } as Parameters<typeof buildSystemPrompt>[0];
const runtime = { scratchRoot: "/scratch", commandTimeoutMs: 300_000 } as Parameters<typeof buildSystemPrompt>[1];

describe("system prompt R17 governance", () => {
  it("exposes the real per-call command timeout so long computations split before launch", () => {
    const prompt = buildSystemPrompt(scope, runtime);
    expect(prompt).toContain("command execution timeout: 300s per call");
    expect(prompt).toContain("split into batches");
  });

  it("no longer claims budgets do not restrict — wall-clock comes from the task text", () => {
    const prompt = buildSystemPrompt(scope, runtime);
    expect(prompt).toContain("token budgets are not a constraint");
    expect(prompt).toContain("wall-clock budget stated in the task text");
    expect(prompt).not.toMatch(/allowlists, budgets, and turn limits/);
  });

  it("appends operator arena discipline after the profile instructions", () => {
    const withDiscipline = buildSystemPrompt(scope, runtime, undefined, undefined, undefined, "CORE-DISCIPLINE");
    expect(withDiscipline).toContain("Arena discipline");
    expect(withDiscipline).toContain("CORE-DISCIPLINE");
  });
});

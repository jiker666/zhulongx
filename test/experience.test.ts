import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore, renderExperienceContext } from "../src/experience.js";
import type { RunState } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("validated experience store", () => {
  it("promotes only scrubbed Arena-success lessons and supports reviewer disabling", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-experience-"));
    roots.push(root);
    const store = new ExperienceStore(join(root, "runs"));
    const now = new Date().toISOString();
    const state = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      phase: "done",
      task: { task: "challenge", attachments: [], metadata: { source: "nssctf-agent-arena", attemptId: "2715", category: "Pwn" } },
      createdAt: now,
      updatedAt: now,
      findings: [],
      lessons: [{
        id: "lesson-general-pwn",
        title: "Never retain NSSCTF{secret-value} or attempt 2715",
        applicableWhen: ["A native binary has a controlled return address"],
        strategy: ["Verify the offset, then replace 0x401229 with an evidence-derived target"],
        verification: ["Reproduce locally and confirm remote output independently"],
        pitfalls: ["Do not reuse NSSCTF{secret-value}"],
        tools: ["/usr/bin/objdump", "python3"],
      }],
      hypotheses: [],
      strategyRevisions: [],
      strategyRevisionRequired: false,
      sandboxNamespace: "11111111-1111-4111-8111-111111111111",
      scratchRoot: join(root, "scratch"),
      workspaceMode: "configured",
      appliedExperienceIds: [],
      submission: "NSSCTF{secret-value}",
      turns: 1,
      toolCalls: 1,
      imageObservations: 0,
      httpRequests: 0,
      tcpSessions: 0,
      actionsSinceCheckpoint: 0,
      repeatedActions: {},
    } satisfies RunState;

    const [promoted] = await store.promoteArenaSuccess(state);
    expect(promoted?.title).not.toContain("2715");
    expect(promoted?.title).not.toContain("secret-value");
    expect(promoted?.strategy.join(" ")).not.toContain("0x401229");
    expect(promoted?.tools).toEqual(["objdump", "python3"]);
    expect(renderExperienceContext(await store.relevant("Pwn"))).toContain("externally accepted");
    expect(await store.relevant("Crypto")).toEqual([]);

    await store.update(promoted!.id, { status: "disabled", reviewNote: "Needs correction" });
    expect(await store.relevant("Pwn")).toEqual([]);
  });
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { QuestionBankProgressStore } from "../src/question-bank-progress.js";
import type { QuestionBankQuestion } from "../src/question-bank.js";
import type { RunState } from "../src/types.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function question(fingerprint = "a".repeat(64)): QuestionBankQuestion {
  return {
    id: "benchmark/crypto/example",
    title: "Example",
    category: "crypto",
    root: "/operator-owned/question",
    attachments: ["/operator-owned/question/challenge.txt"],
    fingerprint,
  };
}

function completedState(id: string, questionId: string): RunState {
  const now = "2026-08-07T12:00:00.000Z";
  return {
    ...({} as RunState),
    id,
    status: "completed",
    submission: "NSSCTF{do-not-persist}",
    finishedAt: now,
    updatedAt: now,
    task: { task: "solve", attachments: [], metadata: { source: "question-bank", questionId } },
  };
}

describe("QuestionBankProgressStore", () => {
  it("stores only a completed question identity and fingerprint, then requeues changed materials", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-question-progress-"));
    roots.push(root);
    const store = new QuestionBankProgressStore(testConfig(root));
    const current = question();

    expect(await store.recordCompleted(current, completedState("run-1", current.id))).toBe(true);
    const persisted = await readFile(store.path, "utf8");
    expect(persisted).toContain(current.id);
    expect(persisted).not.toContain("NSSCTF{do-not-persist}");
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      records: [{ questionId: current.id, fingerprint: current.fingerprint, solvedAt: "2026-08-07T12:00:00.000Z", runId: "run-1" }],
    });
    expect((await store.progressFor([current])).get(current.id)?.runId).toBe("run-1");
    expect(await store.pending([question("b".repeat(64))])).toHaveLength(1);
  });

  it("backfills only completed question-bank runs with structured submissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-question-progress-artifact-"));
    roots.push(root);
    const config = testConfig(root);
    const runId = "00000000-0000-4000-8000-000000000001";
    await mkdir(join(config.runtime.artifactRoot, runId), { recursive: true });
    const current = question("c".repeat(64));
    await writeFile(join(config.runtime.artifactRoot, runId, "state.json"), JSON.stringify(completedState(runId, current.id)), "utf8");
    await mkdir(join(config.runtime.artifactRoot, "not-a-run"), { recursive: true });
    await writeFile(join(config.runtime.artifactRoot, "not-a-run", "state.json"), JSON.stringify({
      status: "completed",
      submission: "missing identity",
      task: { metadata: { source: "question-bank", questionId: current.id } },
    }), "utf8");

    const store = new QuestionBankProgressStore(config);
    expect(await store.syncCompletedRunArtifacts([current])).toBe(1);
    expect(await store.syncCompletedRunArtifacts([current])).toBe(0);
    expect(await store.pending([current])).toEqual([]);
    expect(await readFile(store.path, "utf8")).not.toContain("NSSCTF{do-not-persist}");
  });
});

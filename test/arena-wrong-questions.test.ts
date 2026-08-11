import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ArenaWrongQuestionStore } from "../src/arena-wrong-questions.js";
import type { ArenaAttemptEvaluation } from "../src/arena-evaluation.js";
import type { RunState } from "../src/types.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.XUANSHU_TEST_API_KEY;
  delete process.env.XUANSHU_TEST_ARENA_TOKEN;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function state(attachment: string): RunState {
  const now = new Date().toISOString();
  return {
    id: "run-wrong-question",
    status: "blocked",
    phase: "done",
    task: {
      task: "Analyze this attachment with token=do-not-persist-this-secret",
      attachments: [{
        source: attachment,
        kind: "binary",
        size: 12,
        sha256: "hash",
        summary: "binary",
        truncated: false,
      }],
      metadata: { source: "nssctf-agent-arena", attemptId: "2926", category: "Crypto" },
    },
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "run-wrong-question",
    scratchRoot: "/tmp/wrong-question",
    workspaceMode: "attachments-only",
    appliedExperienceIds: [],
    stopReason: "Agent reported a blocker",
    turns: 8,
    toolCalls: 12,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

function evaluation(): ArenaAttemptEvaluation {
  return {
    attemptId: 2926,
    category: "Crypto",
    outcome: "blocked",
    settled: false,
    flagCandidateFound: false,
    submissionAttempts: 0,
    runCount: 1,
    attachmentCount: 1,
    reused: false,
    reason: "No explicit FLAG line was produced; the active attempt was left open for retry",
    run: { id: "run-wrong-question", status: "blocked", turns: 8, toolCalls: 12 },
  };
}

describe("ArenaWrongQuestionStore", () => {
  it("archives bounded failure metadata and attachment bytes without configured secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-wrong-questions-"));
    roots.push(root);
    const config = testConfig(root);
    process.env.XUANSHU_TEST_API_KEY = "model-secret";
    process.env.XUANSHU_TEST_ARENA_TOKEN = "arena-secret";
    const source = join(root, "challenge.bin");
    await writeFile(source, "challenge-bytes");
    const store = new ArenaWrongQuestionStore(config);

    const record = await store.record(state(source), evaluation());
    expect(record).toMatchObject({ attemptId: 2926, category: "Crypto", status: "pending" });
    expect(record.task).not.toContain("do-not-persist-this-secret");
    expect(record.task).not.toContain("model-secret");
    expect(record.attachments).toHaveLength(1);
    expect(await readFile(record.attachments[0]!.path, "utf8")).toBe("challenge-bytes");
    expect(await store.get(2926)).toMatchObject({ failureCount: 1, attachments: [{ size: 15 }] });
    expect(await store.list()).toMatchObject([{ attemptId: 2926, attachmentCount: 1, lastOutcome: "blocked" }]);
  });
});

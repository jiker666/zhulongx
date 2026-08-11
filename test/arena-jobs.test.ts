import { describe, expect, it, vi, afterEach } from "vitest";
import type { ArenaClient } from "../src/arena.js";
import {
  ArenaJobManager,
  buildArenaCapabilitySummary,
  type ArenaJobStartInput,
} from "../src/arena-jobs.js";
import type { ArenaAttemptEvaluation, ArenaSolveResult } from "../src/arena-evaluation.js";
import type { RunState } from "../src/types.js";
import { testConfig } from "./helpers.js";

function attempt(
  outcome: ArenaAttemptEvaluation["outcome"],
  correct: boolean,
  promotedLessons = 0,
  attemptId = 1,
): ArenaAttemptEvaluation {
  return {
    attemptId,
    category: "crypto",
    outcome,
    settled: true,
    correct,
    flagCandidateFound: true,
    submissionAttempts: correct ? 1 : 2,
    runCount: 1,
    attachmentCount: 0,
    reused: false,
    run: {
      id: "run-test",
      status: "completed",
      turns: 8,
      toolCalls: 12,
      promotedLessons,
    },
  };
}

function runState(): RunState {
  const now = new Date().toISOString();
  return {
    id: "run-test",
    status: "completed",
    phase: "done",
    task: { task: "test", attachments: [], metadata: { category: "crypto" } },
    createdAt: now,
    updatedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "run-test",
    scratchRoot: "/tmp/run-test",
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 8,
    toolCalls: 12,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

function configuredManager(
  solveOnce: (options: { signal?: AbortSignal }) => Promise<ArenaSolveResult>,
  configure: (config: ReturnType<typeof testConfig>) => void = () => {},
  dependencies: NonNullable<ConstructorParameters<typeof ArenaJobManager>[1]> = {},
): ArenaJobManager {
  const config = testConfig("/tmp/xuan-arena-jobs");
  config.scope.mode = "controlled";
  config.scope.allowedHosts = ["*.nssctf.cn:*"];
  configure(config);
  process.env[config.model.apiKeyEnv] = "model-test-key";
  process.env[config.arena?.tokenEnv ?? "XUANSHU_TEST_ARENA_TOKEN"] = "arena-test-token";
  return new ArenaJobManager(config, {
    solveOnce: async (_config, _client, options) => await solveOnce(options),
    clientFactory: () => ({}) as ArenaClient,
    readAgent: async () => ({ rating: 1000 }),
    ensureSandbox: async () => ({ owned: false, close: async () => {} }),
    writeReport: async () => "/tmp/arena-report.json",
    ...dependencies,
  });
}

afterEach(() => {
  delete process.env.XUANSHU_TEST_API_KEY;
  delete process.env.XUANSHU_TEST_ARENA_TOKEN;
});

describe("ArenaJobManager", () => {
  it("builds a deterministic platform-evidence capability summary", () => {
    const summary = buildArenaCapabilitySummary([attempt("solved", true, 2, 1), attempt("wrong", false, 0, 2)]);
    expect(summary).toMatchObject({
      solved: 1,
      evaluated: 2,
      accuracyPercent: 50,
      averageTurns: 8,
      averageToolCalls: 12,
      promotedLessons: 2,
    });
    expect(summary.strengths.join(" ")).toContain("平台验真");
    expect(summary.gaps.join(" ")).toContain("候选答案被拒绝");
  });

  it("runs one bounded job and rejects a concurrent start", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = configuredManager(async () => {
      await gate;
      const evaluation = attempt("solved", true, 1);
      return { attemptId: evaluation.attemptId, state: runState(), evaluation };
    });
    const input: ArenaJobStartInput = { maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: false };
    const started = manager.start(input);
    expect(() => manager.start(input)).toThrow("already active");
    release?.();
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    expect(manager.get(started.id)).toMatchObject({ completedAttempts: 1, summary: { solved: 1 } });
  });

  it("keeps a continuous job running after each settled attempt until stopped", async () => {
    let calls = 0;
    const manager = configuredManager(async (options) => {
      calls += 1;
      if (calls <= 2) {
        const evaluation = attempt("solved", true, 0, calls);
        return { attemptId: evaluation.attemptId, state: runState(), evaluation };
      }
      return await new Promise<ArenaSolveResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    });
    const started = manager.start({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: true });
    await vi.waitFor(() => expect(manager.get(started.id)).toMatchObject({ status: "running", completedAttempts: 2 }));
    expect(manager.get(started.id)?.options).toMatchObject({ continuous: true, maxAttempts: 1 });
    expect(manager.list()[0]).toMatchObject({ continuous: true, targetAttempts: null, completedAttempts: 2 });
    manager.stop(started.id);
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("aborted"));
    expect(manager.get(started.id)?.report?.targetAttempts).toBeNull();
  });

  it("archives a blocked attempt and stops without requesting another attempt", async () => {
    let calls = 0;
    const record = vi.fn(async () => undefined as never);
    const manager = configuredManager(async (options) => {
      calls += 1;
      if (calls === 1) {
        const evaluation = attempt("blocked", false, 0, 29);
        evaluation.settled = false;
        evaluation.reason = "No explicit FLAG line was produced; the active attempt was left open for retry";
        return { attemptId: evaluation.attemptId, state: runState(), evaluation };
      }
      return await new Promise<ArenaSolveResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    }, undefined, {
      wrongQuestionStore: { record, get: async () => undefined, list: async () => [] },
    });
    const started = manager.start({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: true });

    await vi.waitFor(() => {
      expect(manager.get(started.id)).toMatchObject({ status: "failed", completedAttempts: 0 });
      expect(record).toHaveBeenCalledOnce();
      expect(calls).toBe(1);
    });
    expect(manager.get(started.id)?.activity.some((event) => event.type === "arena.wrong-question.saved")).toBe(true);
  });

  it("aborts an active solve without settling the platform attempt", async () => {
    const manager = configuredManager(async (options) => await new Promise<ArenaSolveResult>((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) return reject(new Error("missing signal"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const started = manager.start({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: false });
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("running"));
    manager.stop(started.id);
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("aborted"));
    expect(manager.get(started.id)?.completedAttempts).toBe(0);
  });

  it("stops on a filtered category without requesting or abandoning another attempt", async () => {
    let calls = 0;
    const manager = configuredManager(async () => {
      calls += 1;
      const evaluation = attempt("skipped", false, 0, 10);
      evaluation.settled = false;
      evaluation.runCount = 0;
      evaluation.reason = "Category Web is outside the configured Arena allowlist; the active attempt was left open";
      return { attemptId: evaluation.attemptId, state: runState(), evaluation };
    }, (config) => {
      config.arena!.allowedCategories = ["crypto", "misc"];
    });
    const started = manager.start({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: false });
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("failed"));
    expect(calls).toBe(1);
    expect(manager.get(started.id)).toMatchObject({ completedAttempts: 0 });
    expect(manager.get(started.id)?.attempts.map((item) => item.outcome)).toEqual(["skipped"]);
    expect(manager.get(started.id)?.error).toContain("left open");
  });

  it("redacts configured credentials from persisted job failures", async () => {
    const manager = configuredManager(async () => {
      throw new Error(`upstream leaked ${process.env.XUANSHU_TEST_API_KEY} and ${process.env.XUANSHU_TEST_ARENA_TOKEN}`);
    });
    const started = manager.start({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: false });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("failed"));
    const snapshot = manager.get(started.id);
    const serialized = JSON.stringify(snapshot);
    expect(snapshot?.error).toContain("[REDACTED]");
    expect(serialized).not.toContain("model-test-key");
    expect(serialized).not.toContain("arena-test-token");
  });
});

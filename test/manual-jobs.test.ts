import { describe, expect, it, vi } from "vitest";
import { isRetryableManualRunFailure, ManualJobManager, validateManualJobInput } from "../src/manual-jobs.js";
import type { SharedEvidenceBoard } from "../src/shared-evidence.js";
import type { RunState, TaskRequest } from "../src/types.js";

function fakeState(id: string, task: TaskRequest, status: RunState["status"] = "completed"): RunState {
  const now = new Date().toISOString();
  return {
    id,
    status,
    phase: "done",
    task: { task: task.task, attachments: [], metadata: task.metadata ?? {} },
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: id,
    scratchRoot: "/tmp/manual-job",
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 2,
    toolCalls: 3,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

describe("ManualJobManager", () => {
  it("validates bounded batches and runs tasks up to the requested concurrency", async () => {
    expect(() => validateManualJobInput({ tasks: [], concurrency: 2 })).toThrow("between 1 and 20");
    expect(() => validateManualJobInput({ tasks: ["one"], concurrency: 9 })).toThrow("between 1 and 8");
    expect(() => validateManualJobInput({ tasks: ["one"], concurrency: 2, writeup: "yes" })).toThrow("writeup must be a boolean");
    expect(() => validateManualJobInput({ tasks: ["one"], raceAgents: 9 })).toThrow("raceAgents must be an integer between 1 and 8");
    expect(() => validateManualJobInput({ tasks: ["one"], concurrency: 2, transientRetryLimit: 4 })).toThrow("between 0 and 3");
    expect(validateManualJobInput({ tasks: ["one"] }).concurrency).toBe(1);
    expect(validateManualJobInput({ tasks: ["one"], concurrency: 2 }).writeup).toBe(true);
    expect(validateManualJobInput({ tasks: ["one"], concurrency: 2, writeup: false }).writeup).toBe(false);
    expect(validateManualJobInput({ tasks: ["one"], raceAgents: 2 }).raceAgents).toBe(2);

    let sequence = 0;
    let active = 0;
    let maximumActive = 0;
    const waits = new Map<string, Promise<RunState>>();
    const runManager = {
      start: vi.fn((task: TaskRequest) => {
        const id = `run-${++sequence}`;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const promise = new Promise<RunState>((resolve) => {
          setTimeout(() => {
            active -= 1;
            resolve(fakeState(id, task));
          }, 5);
        });
        waits.set(id, promise);
        return id;
      }),
      wait: vi.fn((id: string) => waits.get(id) as Promise<RunState>),
      stop: vi.fn(() => true),
    };
    const manager = new ManualJobManager({ runManager });
    const started = manager.start({ tasks: ["one", "two", "three", "four", "five"], concurrency: 2 });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    const snapshot = manager.get(started.id);
    expect(maximumActive).toBe(2);
    expect(snapshot).toMatchObject({ total: 5, completed: 5, failed: 0 });
    expect(snapshot?.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(runManager.start).toHaveBeenCalledWith(expect.any(Object), { workspaceMode: "attachments-only" });
  });

  it("returns structured submissions and bounded reports without inferring results from prose", async () => {
    const requests: TaskRequest[] = [];
    let nextRun = 0;
    const states = new Map<string, RunState>();
    const runManager = {
      start: vi.fn((task: TaskRequest) => {
        const id = `run-result-${++nextRun}`;
        requests.push(task);
        const result = fakeState(id, task);
        if (nextRun === 1) {
          result.submission = "exact-result";
          result.summary = `# Report\n\n${"evidence ".repeat(3000)}`;
        } else {
          result.summary = "# Report\n\nRecovered from deterministic evidence.\nRESULT: `prose-only-result`";
        }
        states.set(id, result);
        return id;
      }),
      wait: vi.fn(async (id: string) => states.get(id) as RunState),
      stop: vi.fn(() => true),
    };
    const manager = new ManualJobManager({ runManager });
    const started = manager.start({ tasks: ["first task", "second task"], concurrency: 2, writeup: true });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    const snapshot = manager.get(started.id);
    expect(snapshot).toMatchObject({ writeup: true, tasks: [
      { task: "first task", submission: "exact-result" },
      { task: "second task" },
    ] });
    expect(snapshot?.tasks[1]?.submission).toBeUndefined();
    expect(snapshot?.tasks[0]?.writeup?.length).toBeLessThanOrEqual(16 * 1024);
    expect(snapshot?.tasks[0]?.writeup).toContain("[truncated]");
    expect(requests.every((request) => request.task.includes("Markdown task report"))).toBe(true);
    expect(requests.every((request) => request.task.includes("finish_task"))).toBe(true);
  });

  it("still requests a structured answer when writeup generation is disabled", async () => {
    let request: TaskRequest | undefined;
    const runManager = {
      start: vi.fn((task: TaskRequest) => {
        request = task;
        return "run-no-writeup";
      }),
      wait: vi.fn(async () => {
        const state = fakeState("run-no-writeup", request as TaskRequest);
        state.submission = "answer-only";
        state.summary = "Verified answer.";
        return state;
      }),
      stop: vi.fn(() => true),
    };
    const manager = new ManualJobManager({ runManager });
    const started = manager.start({ tasks: ["no wp"], concurrency: 1, writeup: false });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    expect(request?.task).toContain("set submission to the exact final result only");
    expect(request?.task).not.toContain("Markdown task report");
    expect(manager.get(started.id)).toMatchObject({ writeup: false, tasks: [{ submission: "answer-only" }] });
    expect(manager.get(started.id)?.tasks[0]?.writeup).toBeUndefined();
  });

  it("prepares and cleans a task instance around retries and settlement", async () => {
    let prepared = false;
    let cleaned = false;
    let request: TaskRequest | undefined;
    const manager = new ManualJobManager({
      runManager: {
        start: vi.fn((task: TaskRequest) => {
          request = task;
          return "run-prepared";
        }),
        wait: vi.fn(async () => fakeState("run-prepared", request as TaskRequest)),
        stop: vi.fn(() => true),
      },
    });
    const started = manager.start({ tasks: ["service task"], concurrency: 1 }, {
      prepareTask: async (original) => {
        prepared = true;
        return {
          request: { ...original, scope: { mode: "controlled", allowedHosts: ["127.0.0.1:31337"] } },
          cleanup: async () => { cleaned = true; },
        };
      },
    });
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    expect(prepared).toBe(true);
    expect(cleaned).toBe(true);
    expect(request?.scope).toMatchObject({ allowedHosts: ["127.0.0.1:31337"] });
  });

  it("races independent agents and stops the slower agents after the first verified winner", async () => {
    const resolvers = new Map<string, (state: RunState) => void>();
    const requests: TaskRequest[] = [];
    const options: Array<{ sharedEvidence?: SharedEvidenceBoard }> = [];
    let nextRun = 0;
    const runManager = {
      start: vi.fn((task: TaskRequest, runOptions?: { sharedEvidence?: SharedEvidenceBoard }) => {
        const id = `run-race-${++nextRun}`;
        requests.push(task);
        options.push(runOptions ?? {});
        if (id === "run-race-2") {
          runOptions?.sharedEvidence?.publish(id, {
            kind: "fact",
            claim: "Second agent observed a candidate in deterministic output",
            evidence: ["command output contained verified-result"],
            confidence: 0.9,
          });
        }
        return id;
      }),
      wait: vi.fn((id: string) => new Promise<RunState>((resolve) => {
        resolvers.set(id, resolve);
        if (id === "run-race-2") {
          const state = fakeState(id, requests[1] as TaskRequest, "completed");
          state.submission = "verified-result";
          state.verification = ["command output contained verified-result"];
          state.independentlyVerified = true;
          setTimeout(() => resolve(state), 5);
        }
      })),
      stop: vi.fn((id: string) => {
        const resolve = resolvers.get(id);
        if (resolve) resolve(fakeState(id, requests[0] as TaskRequest, "aborted"));
        return true;
      }),
    };
    const manager = new ManualJobManager({ runManager });
    const started = manager.start({ tasks: ["race challenge"], concurrency: 1, raceAgents: 2 });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    const snapshot = manager.get(started.id);
    expect(snapshot).toMatchObject({ raceAgents: 2, completed: 1, failed: 0 });
    expect(snapshot?.tasks[0]).toMatchObject({
      status: "completed",
      submission: "verified-result",
      race: { agentCount: 2, winnerAgent: 1, cancelledAgents: 1, sharedEvidenceEntries: 1 },
    });
    expect(runManager.start).toHaveBeenCalledTimes(2);
    expect(runManager.stop).toHaveBeenCalledWith("run-race-1");
    expect(requests[0]?.task).toContain("race agent 1 of 2");
    expect(requests[1]?.task).toContain("race agent 2 of 2");
    expect(requests[0]?.task).toContain("read the shared board");
    expect(options[0]?.sharedEvidence).toBeDefined();
    expect(options[0]?.sharedEvidence).toBe(options[1]?.sharedEvidence);
  });

  it("does not accept an unverified race submission as the winner", async () => {
    const states = new Map<string, RunState>();
    let nextRun = 0;
    const runManager = {
      start: vi.fn((task: TaskRequest) => {
        const id = `run-unverified-${++nextRun}`;
        const state = fakeState(id, task, "completed");
        state.submission = "unverified-result";
        states.set(id, state);
        return id;
      }),
      wait: vi.fn(async (id: string) => states.get(id) as RunState),
      stop: vi.fn(() => true),
    };
    const manager = new ManualJobManager({ runManager });
    const started = manager.start({ tasks: ["unverified race"], concurrency: 1, raceAgents: 2, skipBlocked: true });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    expect(manager.get(started.id)?.tasks[0]).toMatchObject({ status: "skipped", submission: "unverified-result" });
    expect(runManager.stop).not.toHaveBeenCalled();
  });

  it("marks blocked question-bank work as skipped and continues the batch", async () => {
    let nextRun = 0;
    const states = new Map<string, RunState>();
    const runManager = {
      start: vi.fn((task: TaskRequest) => {
        const id = `run-skip-${++nextRun}`;
        states.set(id, fakeState(id, task, nextRun === 1 ? "blocked" : "completed"));
        return id;
      }),
      wait: vi.fn(async (id: string) => states.get(id) as RunState),
      stop: vi.fn(() => true),
    };
    const manager = new ManualJobManager({ runManager });
    const started = manager.start({ tasks: ["unknown", "solvable"], concurrency: 1, skipBlocked: true });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    expect(manager.get(started.id)).toMatchObject({ completed: 1, skipped: 1, failed: 0 });
    expect(manager.get(started.id)?.tasks.map((task) => task.status)).toEqual(["skipped", "completed"]);
    expect(runManager.start).toHaveBeenCalledTimes(2);
  });

  it("retries bounded transient model failures before classifying a task", async () => {
    let nextRun = 0;
    const states = new Map<string, RunState>();
    const runManager = {
      start: vi.fn((task: TaskRequest) => {
        const id = `run-retry-${++nextRun}`;
        const state = fakeState(id, task, nextRun === 1 ? "failed" : "completed");
        if (nextRun === 1) state.stopReason = "429 TooManyRequests";
        states.set(id, state);
        return id;
      }),
      wait: vi.fn(async (id: string) => states.get(id) as RunState),
      stop: vi.fn(() => true),
    };
    const delay = vi.fn(async () => {});
    const manager = new ManualJobManager({ runManager, delay });
    const started = manager.start({ tasks: ["retry once"], concurrency: 1, transientRetryLimit: 1 });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    expect(manager.get(started.id)?.tasks[0]).toMatchObject({ status: "completed", runAttempts: 2 });
    expect(runManager.start).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
    expect(isRetryableManualRunFailure("429 TooManyRequests")).toBe(true);
    expect(isRetryableManualRunFailure("tool-call budget exhausted")).toBe(false);
  });

  it("notifies per-task bookkeeping only after a final run state is available", async () => {
    const request: TaskRequest = { task: "solved", metadata: { source: "question-bank", questionId: "example" } };
    const result = fakeState("run-callback", request);
    result.submission = "answer";
    const onTaskSettled = vi.fn(async () => {});
    const manager = new ManualJobManager({
      runManager: {
        start: vi.fn(() => "run-callback"),
        wait: vi.fn(async () => result),
        stop: vi.fn(() => true),
      },
    });
    const started = manager.start({ tasks: [request], concurrency: 1 }, { onTaskSettled });

    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("completed"));
    expect(onTaskSettled).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ metadata: request.metadata }),
      snapshot: expect.objectContaining({ status: "completed", runId: "run-callback" }),
      state: result,
    }));
  });

  it("stops queued work and aborts running runs", async () => {
    let resolveRun: ((state: RunState) => void) | undefined;
    const runManager = {
      start: vi.fn((task: TaskRequest) => {
        const id = "run-stop";
        resolveRun = (state) => state;
        return id;
      }),
      wait: vi.fn(() => new Promise<RunState>((resolve) => {
        resolveRun = resolve;
      })),
      stop: vi.fn(() => {
        resolveRun?.(fakeState("run-stop", { task: "stoppable" }, "aborted"));
        return true;
      }),
    };
    const manager = new ManualJobManager({ runManager });
    const started = manager.start({ tasks: ["one", "two"], concurrency: 1 });
    await vi.waitFor(() => expect(manager.get(started.id)?.running).toBe(1));
    const stopping = manager.stop(started.id);
    expect(stopping?.status).toBe("stopping");
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe("aborted"));
    expect(runManager.stop).toHaveBeenCalledWith("run-stop");
    expect(manager.get(started.id)?.tasks.every((task) => task.status === "aborted")).toBe(true);
  });
});

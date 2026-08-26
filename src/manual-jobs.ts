import { randomUUID } from "node:crypto";
import type { RunState, TaskRequest } from "./types.js";
import type { RunManager } from "./run-manager.js";
import { SharedEvidenceBoard } from "./shared-evidence.js";

const MAX_TASKS = 20;
const MAX_CONCURRENCY = 8;
const MAX_RACE_AGENTS = 8;
const MAX_JOB_HISTORY = 50;
const MAX_TASK_PREVIEW = 180;
const MAX_SUBMISSION_LENGTH = 512;
const MAX_WRITEUP_LENGTH = 16 * 1024;

export type ManualJobStatus = "queued" | "running" | "stopping" | "completed" | "aborted";
export type ManualTaskStatus = "queued" | "running" | "completed" | "blocked" | "skipped" | "failed" | "aborted";

export type ManualTaskInput = TaskRequest | string;

export interface ManualJobStartInput {
  tasks: ManualTaskInput[];
  concurrency: number;
  raceAgents?: number;
  writeup?: boolean;
  skipBlocked?: boolean;
  transientRetryLimit?: number;
}

export interface ManualTaskSnapshot {
  index: number;
  task: string;
  status: ManualTaskStatus;
  attachmentCount: number;
  runId?: string;
  submission?: string;
  writeup?: string;
  error?: string;
  runAttempts?: number;
  race?: {
    agentCount: number;
    winnerAgent?: number;
    runIds: string[];
    cancelledAgents: number;
    sharedEvidenceEntries: number;
  };
  run?: { id: string; status: RunState["status"]; turns: number; toolCalls: number };
}

export interface ManualJobSnapshot {
  id: string;
  status: ManualJobStatus;
  concurrency: number;
  raceAgents: number;
  writeup: boolean;
  skipBlocked: boolean;
  transientRetryLimit: number;
  total: number;
  queued: number;
  running: number;
  completed: number;
  skipped: number;
  failed: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  tasks: ManualTaskSnapshot[];
}

export interface ManualTaskSettledInput {
  request: TaskRequest;
  snapshot: ManualTaskSnapshot;
  state: RunState;
}

export interface ManualJobStartOptions {
  onSettled?: () => void | Promise<void>;
  onTaskSettled?: (input: ManualTaskSettledInput) => void | Promise<void>;
  prepareTask?: (request: TaskRequest, signal: AbortSignal) => Promise<{
    request: TaskRequest;
    cleanup?: () => void | Promise<void>;
  }>;
}

interface ManualJobHandle {
  id: string;
  status: ManualJobStatus;
  concurrency: number;
  raceAgents: number;
  writeup: boolean;
  skipBlocked: boolean;
  transientRetryLimit: number;
  tasks: Array<{ request: TaskRequest; snapshot: ManualTaskSnapshot; runIds: Set<string> }>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  controller: AbortController;
  promise: Promise<void>;
  onSettled?: () => void | Promise<void>;
  onTaskSettled?: (input: ManualTaskSettledInput) => void | Promise<void>;
  prepareTask?: ManualJobStartOptions["prepareTask"];
}

export interface ManualJobDependencies {
  runManager: Pick<RunManager, "start" | "wait" | "stop">;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Manual batch stopped by operator"));
  return new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason ?? new Error("Manual batch stopped by operator"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryableManualRunFailure(message: string | undefined): boolean {
  return /(?:\b429\b|too\s*many\s*requests|rate\s*limit|\b5\d\d\b|econnreset|etimedout|fetch failed|socket hang up|connection error)/i.test(
    message ?? "",
  );
}

function taskPreview(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > MAX_TASK_PREVIEW ? `${compact.slice(0, MAX_TASK_PREVIEW - 1)}…` : compact;
}

function taskWithOutputContract(
  request: TaskRequest,
  writeup: boolean,
  raceAgent?: { index: number; total: number },
): TaskRequest {
  const raceLenses = [
    "Begin with broad, low-cost triage and pursue the highest-information observation first.",
    "Challenge the most consequential assumption and seek an independent route around likely dead ends.",
    "Prioritize exact constraints, reproducible transformations, and a minimal end-to-end verification path.",
    "Look for contradictions between the task, artifacts, and observed behavior before deepening any one approach.",
  ];
  const contract = [
    "Operator output contract:",
    "- When completed, call finish_task and set submission to the exact final result only, without explanation or Markdown wrappers.",
    "- Do not guess an answer. If evidence is insufficient, finish as blocked and describe the blocker.",
    ...(raceAgent
      ? [
          `- You are race agent ${raceAgent.index + 1} of ${raceAgent.total}. Coordinate only through the bounded shared evidence tools while maintaining independent verification.`,
          `- Exploration lens: ${raceLenses[raceAgent.index % raceLenses.length]}`,
          "- After submit_plan, read the shared board before committing to a direction. Publish direct observations and evidenced dead ends promptly; never publish secrets or unsupported claims.",
          "- A race winner must provide independentlyVerified=true and include the exact submission in verification evidence observed during the run.",
        ]
      : []),
    ...(writeup
      ? [
          "- Set summary to a concise submission-style Markdown task report (writeup) no longer than 12000 characters.",
          "- Use this structure: YAML front matter (title, ctf, date, category, difficulty, points, flag_format, author), # title, ## Summary, ## Solution, and ## Flag.",
          "- Keep Solution to 1-3 short steps and include one complete runnable solving script from the provided challenge data to printing the final flag whenever the artifacts support it.",
          "- Show the exact final flag in a fenced code block under ## Flag, matching submission; never invent commands, evidence, or a flag.",
          "- Preserve concrete public observations and solver constants in the report; the platform may run a dedicated writeup generation pass after settlement.",
          "- The report must cover the approach, key evidence, essential commands or scripts, verification, and exact final result.",
          "- Do not include hidden reasoning, model keys, authorization headers, cookies, credentials, or unrelated environment/configuration values.",
        ]
      : ["- Keep summary concise and include only the result and its verification."]),
  ];
  return { ...request, task: `${request.task.trimEnd()}\n\n${contract.join("\n")}` };
}

function boundedWriteup(value: string | undefined): string | undefined {
  const writeup = value?.trim();
  if (!writeup) return undefined;
  if (writeup.length <= MAX_WRITEUP_LENGTH) return writeup;
  return `${writeup.slice(0, MAX_WRITEUP_LENGTH - 12)}\n[truncated]`;
}

function cleanSubmission(value: string): string | undefined {
  let submission = value.trim();
  if (submission.length >= 2 && submission.startsWith("`") && submission.endsWith("`")) {
    submission = submission.slice(1, -1).trim();
  }
  return submission.length > 0 && submission.length <= MAX_SUBMISSION_LENGTH ? submission : undefined;
}

function extractSubmission(state: RunState): string | undefined {
  return state.submission ? cleanSubmission(state.submission) : undefined;
}

function raceWinnerState(state: RunState): boolean {
  if (state.status !== "completed") return false;
  const submission = extractSubmission(state);
  if (!submission || state.independentlyVerified !== true) return false;
  return (state.verification ?? []).some((record) => record.includes(submission));
}

function validateTaskInput(input: unknown, index: number): ManualTaskInput {
  if (typeof input === "string") {
    if (!input.trim()) throw new Error(`tasks[${index}] must not be empty`);
    return { task: input };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`tasks[${index}] must be a string or task object`);
  }
  const value = input as Record<string, unknown>;
  if (typeof value.task !== "string" || !value.task.trim()) throw new Error(`tasks[${index}].task must be a non-empty string`);
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.some((item) => typeof item !== "string"))) {
    throw new Error(`tasks[${index}].attachments must be an array of strings`);
  }
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata) || Object.entries(value.metadata).some(([key, item]) => typeof key !== "string" || typeof item !== "string"))) {
    throw new Error(`tasks[${index}].metadata must be an object of strings`);
  }
  return {
    task: value.task,
    ...(value.attachments === undefined ? {} : { attachments: [...(value.attachments as string[])] }),
    ...(value.scope && typeof value.scope === "object" && !Array.isArray(value.scope)
      ? { scope: value.scope as NonNullable<TaskRequest["scope"]> }
      : {}),
    ...(value.metadata === undefined ? {} : { metadata: { ...(value.metadata as Record<string, string>) } }),
  };
}

export function validateManualJobInput(input: unknown): ManualJobStartInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("body must contain tasks");
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.tasks)) throw new Error("tasks must be an array");
  if (value.tasks.length < 1 || value.tasks.length > MAX_TASKS) throw new Error(`tasks must contain between 1 and ${MAX_TASKS} items`);
  const concurrency = value.concurrency === undefined ? 1 : Number(value.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  const raceAgents = value.raceAgents === undefined ? 1 : Number(value.raceAgents);
  if (!Number.isInteger(raceAgents) || raceAgents < 1 || raceAgents > MAX_RACE_AGENTS) {
    throw new Error(`raceAgents must be an integer between 1 and ${MAX_RACE_AGENTS}`);
  }
  const writeup = value.writeup === undefined ? true : value.writeup;
  if (typeof writeup !== "boolean") throw new Error("writeup must be a boolean");
  const skipBlocked = value.skipBlocked === undefined ? false : value.skipBlocked;
  if (typeof skipBlocked !== "boolean") throw new Error("skipBlocked must be a boolean");
  const transientRetryLimit = value.transientRetryLimit === undefined ? 0 : Number(value.transientRetryLimit);
  if (!Number.isInteger(transientRetryLimit) || transientRetryLimit < 0 || transientRetryLimit > 3) {
    throw new Error("transientRetryLimit must be an integer between 0 and 3");
  }
  return {
    tasks: value.tasks.map((task, index) => validateTaskInput(task, index)),
    concurrency,
    raceAgents,
    writeup,
    skipBlocked,
    transientRetryLimit,
  };
}

export class ManualJobManager {
  private readonly jobs = new Map<string, ManualJobHandle>();

  constructor(private readonly dependencies: ManualJobDependencies) {}

  start(input: ManualJobStartInput, options: ManualJobStartOptions = {}): ManualJobSnapshot {
    const validated = validateManualJobInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const handle: ManualJobHandle = {
      id,
      status: "queued",
      concurrency: validated.concurrency,
      raceAgents: validated.raceAgents ?? 1,
      writeup: validated.writeup ?? true,
      skipBlocked: validated.skipBlocked ?? false,
      transientRetryLimit: validated.transientRetryLimit ?? 0,
      tasks: validated.tasks.map((input, index) => {
        const request: TaskRequest = typeof input === "string" ? { task: input } : input;
        return {
          request,
          runIds: new Set<string>(),
          snapshot: {
            index,
            task: taskPreview(request.task),
            status: "queued",
            attachmentCount: request.attachments?.length ?? 0,
          },
        };
      }),
      createdAt: now,
      controller: new AbortController(),
      promise: Promise.resolve(),
      ...(options.onSettled ? { onSettled: options.onSettled } : {}),
      ...(options.onTaskSettled ? { onTaskSettled: options.onTaskSettled } : {}),
      ...(options.prepareTask ? { prepareTask: options.prepareTask } : {}),
    };
    handle.promise = this.execute(handle);
    void handle.promise.catch(() => undefined);
    this.jobs.set(id, handle);
    this.trimHistory();
    return this.snapshot(handle);
  }

  get(id: string): ManualJobSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : undefined;
  }

  list(): ManualJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => this.snapshot(job));
  }

  stop(id: string): ManualJobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (["completed", "aborted"].includes(job.status)) return this.snapshot(job);
    job.status = "stopping";
    job.controller.abort(new Error("Manual batch stopped by operator"));
    for (const task of job.tasks) {
      if (task.snapshot.status === "queued") task.snapshot.status = "aborted";
      for (const runId of task.runIds) this.dependencies.runManager.stop(runId);
    }
    return this.snapshot(job);
  }

  async close(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (["queued", "running", "stopping"].includes(job.status)) this.stop(job.id);
    }
    await Promise.all([...this.jobs.values()].map((job) => job.promise.catch(() => undefined)));
  }

  private async execute(job: ManualJobHandle): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    let nextIndex = 0;
    type SettledRun = { agent: number; runId: string; state?: RunState; error?: string };
    const worker = async (): Promise<void> => {
      while (!job.controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const task = job.tasks[index];
        if (!task) return;
        task.snapshot.status = "running";
        let preparedRequest = task.request;
        let cleanupPreparedTask: (() => void | Promise<void>) | undefined;
        try {
          const prepared = await job.prepareTask?.(task.request, job.controller.signal);
          if (prepared) {
            preparedRequest = prepared.request;
            cleanupPreparedTask = prepared.cleanup;
          }
        } catch (error) {
          if (job.controller.signal.aborted) break;
          task.snapshot.status = "failed";
          task.snapshot.error = errorMessage(error).slice(0, 600);
          continue;
        }
        let settled: SettledRun | undefined;
        try {
          if (job.raceAgents > 1) {
            const sharedEvidence = new SharedEvidenceBoard();
            const runs = new Map<number, Promise<SettledRun>>();
            const runIdByAgent = new Map<number, string>();
            const runIds: string[] = [];
            for (let agent = 0; agent < job.raceAgents; agent += 1) {
              if (job.controller.signal.aborted) break;
              task.snapshot.runAttempts = agent + 1;
              const request = taskWithOutputContract(preparedRequest, job.writeup, {
                index: agent,
                total: job.raceAgents,
              });
              try {
                const runId = this.dependencies.runManager.start(request, {
                  workspaceMode: "attachments-only",
                  ...(job.writeup ? {} : { writeup: false }),
                  sharedEvidence,
                });
                runIds.push(runId);
                runIdByAgent.set(agent, runId);
                task.runIds.add(runId);
                runs.set(agent, this.dependencies.runManager.wait(runId)
                  .then((state) => ({ agent, runId, state }))
                  .catch((error: unknown) => ({ agent, runId, error: errorMessage(error).slice(0, 600) }))
                  .finally(() => {
                    task.runIds.delete(runId);
                  }));
              } catch (error) {
                runs.set(agent, Promise.resolve({ agent, runId: "", error: errorMessage(error).slice(0, 600) }));
              }
            }
            task.snapshot.race = {
              agentCount: job.raceAgents,
              runIds,
              cancelledAgents: 0,
              sharedEvidenceEntries: sharedEvidence.size,
            };
            const pending = new Map(runs);
            let firstCompleted: SettledRun | undefined;
            while (pending.size > 0 && !job.controller.signal.aborted) {
              const current = await Promise.race(
                [...pending.entries()].map(async ([agent, promise]) => ({ agent, settled: await promise })),
              );
              pending.delete(current.agent);
              task.snapshot.race.sharedEvidenceEntries = sharedEvidence.size;
              if (!firstCompleted && current.settled.state) firstCompleted = current.settled;
              if (current.settled.state && raceWinnerState(current.settled.state)) {
                settled = current.settled;
                task.snapshot.race.winnerAgent = current.agent;
                task.snapshot.race.cancelledAgents = pending.size;
                for (const [pendingAgent] of pending) {
                  const pendingRunId = runIdByAgent.get(pendingAgent);
                  if (pendingRunId) this.dependencies.runManager.stop(pendingRunId);
                }
                await Promise.allSettled([...pending.values()]);
                break;
              }
            }
            if (!settled && !job.controller.signal.aborted) {
              settled = firstCompleted ?? { agent: 0, runId: "", error: "No race agent completed" };
              settled.error = settled.error ?? "No race agent produced a validated completion";
            }
          } else {
            let attempts = 0;
            while (!job.controller.signal.aborted) {
              attempts += 1;
              task.snapshot.runAttempts = attempts;
              let activeRunId: string | undefined;
              try {
                const runId = this.dependencies.runManager.start(taskWithOutputContract(preparedRequest, job.writeup), { workspaceMode: "attachments-only", ...(job.writeup ? {} : { writeup: false }) });
                activeRunId = runId;
                task.snapshot.runId = runId;
                task.runIds.add(runId);
                const state = await this.dependencies.runManager.wait(runId);
                task.runIds.delete(runId);
                settled = { agent: 0, runId, state };
                if (state.status === "failed" && attempts <= job.transientRetryLimit && isRetryableManualRunFailure(state.stopReason)) {
                  task.snapshot.error = `Transient model failure; retrying (${attempts}/${job.transientRetryLimit})`;
                  await (this.dependencies.delay ?? retryDelay)(Math.min(5_000 * 2 ** (attempts - 1), 60_000), job.controller.signal);
                  continue;
                }
                break;
              } catch (error) {
                if (job.controller.signal.aborted) break;
                const message = errorMessage(error);
                if (attempts <= job.transientRetryLimit && isRetryableManualRunFailure(message)) {
                  task.snapshot.error = `Transient model failure; retrying (${attempts}/${job.transientRetryLimit})`;
                  await (this.dependencies.delay ?? retryDelay)(Math.min(5_000 * 2 ** (attempts - 1), 60_000), job.controller.signal);
                  continue;
                }
                settled = { agent: 0, runId: "", error: message.slice(0, 600) };
                break;
              } finally {
                if (activeRunId) task.runIds.delete(activeRunId);
              }
            }
          }

          if (!settled || job.controller.signal.aborted) break;
          const state = settled.state;
          if (state) {
            task.snapshot.runId = settled.runId || state.id;
            task.snapshot.run = { id: state.id, status: state.status, turns: state.turns, toolCalls: state.toolCalls };
            const valid = job.raceAgents === 1 || raceWinnerState(state);
            task.snapshot.status = valid
              ? job.skipBlocked && state.status === "blocked"
                ? "skipped"
                : state.status === "queued"
                  ? "failed"
                  : state.status
              : job.skipBlocked
                ? "skipped"
                : "blocked";
            if (valid && !(job.skipBlocked && state.status === "blocked")) delete task.snapshot.error;
            else task.snapshot.error = settled.error ?? "No race agent produced a validated completion";
            const submission = extractSubmission(state);
            if (submission) task.snapshot.submission = submission;
            if (job.writeup) {
              const writeup = boundedWriteup(state.writeup ?? state.summary);
              if (writeup) task.snapshot.writeup = writeup;
            }
            if (valid) {
              try {
                await job.onTaskSettled?.({
                  request: {
                    ...task.request,
                    ...(task.request.attachments ? { attachments: [...task.request.attachments] } : {}),
                    ...(task.request.metadata ? { metadata: { ...task.request.metadata } } : {}),
                  },
                  snapshot: {
                    ...task.snapshot,
                    ...(task.snapshot.run ? { run: { ...task.snapshot.run } } : {}),
                    ...(task.snapshot.race ? { race: { ...task.snapshot.race, runIds: [...task.snapshot.race.runIds] } } : {}),
                  },
                  state,
                });
              } catch {
                // Progress bookkeeping must not change an already-settled solve result.
              }
            }
          } else {
            task.snapshot.status = "failed";
            task.snapshot.error = settled.error ?? "Run did not return a state";
          }
        } finally {
          if (cleanupPreparedTask) {
            try {
              await cleanupPreparedTask();
            } catch (error) {
              task.snapshot.error = `Question instance cleanup failed: ${errorMessage(error).slice(0, 520)}`;
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(job.concurrency, job.tasks.length) }, () => worker()));
    if (job.controller.signal.aborted) {
      for (const task of job.tasks) {
        if (task.snapshot.status === "queued" || task.snapshot.status === "running") task.snapshot.status = "aborted";
      }
      job.status = "aborted";
    } else {
      job.status = "completed";
    }
    job.finishedAt = new Date().toISOString();
    try {
      await job.onSettled?.();
    } catch {
      // Cleanup failures do not change an already-settled solve result.
    }
  }

  private snapshot(job: ManualJobHandle): ManualJobSnapshot {
    const tasks = job.tasks.map((task) => ({
      ...task.snapshot,
      ...(task.snapshot.run ? { run: { ...task.snapshot.run } } : {}),
      ...(task.snapshot.race ? { race: { ...task.snapshot.race, runIds: [...task.snapshot.race.runIds] } } : {}),
    }));
    return {
      id: job.id,
      status: job.status,
      concurrency: job.concurrency,
      raceAgents: job.raceAgents,
      writeup: job.writeup,
      skipBlocked: job.skipBlocked,
      transientRetryLimit: job.transientRetryLimit,
      total: tasks.length,
      queued: tasks.filter((task) => task.status === "queued").length,
      running: tasks.filter((task) => task.status === "running").length,
      completed: tasks.filter((task) => ["completed", "blocked"].includes(task.status)).length,
      skipped: tasks.filter((task) => task.status === "skipped").length,
      failed: tasks.filter((task) => ["failed", "aborted"].includes(task.status)).length,
      createdAt: job.createdAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      tasks,
    };
  }

  private trimHistory(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => ["completed", "aborted"].includes(job.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const job of finished.slice(MAX_JOB_HISTORY)) this.jobs.delete(job.id);
  }
}

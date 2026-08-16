import { randomUUID } from "node:crypto";
import type { DurableAgentStore, AgentTask, AgentTaskResult } from "./agent-store.js";
import type { RunManager } from "./run-manager.js";

export interface AgentTaskExecution {
  status: AgentTaskResult["status"];
  summary: string;
  body?: string;
  artifacts?: string[];
  tokensUsed?: number;
  costUsedMicros?: number;
}

export interface AgentTaskRunner {
  run(task: AgentTask, signal: AbortSignal): Promise<AgentTaskExecution>;
}

export interface AgentWorkerOptions {
  concurrency: number;
  leaseMs: number;
  idlePollMs: number;
}

const DEFAULT_OPTIONS: AgentWorkerOptions = { concurrency: 2, leaseMs: 30_000, idlePollMs: 100 };

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Agent worker stopped")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class BoundedAgentWorker {
  private readonly id = `agent-worker-${randomUUID()}`;
  private readonly options: AgentWorkerOptions;
  private readonly controller = new AbortController();
  private readonly active = new Map<string, AbortController>();
  private loops: Promise<void>[] = [];

  constructor(private readonly store: DurableAgentStore, private readonly runner: AgentTaskRunner, options: Partial<AgentWorkerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!Number.isInteger(this.options.concurrency) || this.options.concurrency < 1 || this.options.concurrency > 8) throw new Error("Agent worker concurrency must be between 1 and 8");
  }

  start(): void {
    if (this.loops.length > 0) return;
    this.loops = Array.from({ length: this.options.concurrency }, (_, index) => this.loop(`${this.id}-${index + 1}`));
  }

  async close(): Promise<void> {
    this.controller.abort(new Error("Agent worker stopped"));
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  async interruptAgent(agentId: string): Promise<void> {
    await this.store.interruptAgent(agentId);
    for (const [key, controller] of this.active) if (key.startsWith(`${agentId}:`)) controller.abort(new Error("Agent interrupted by operator"));
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.controller.signal.aborted) {
      const task = await this.store.claimNext(workerId, this.options.leaseMs);
      if (!task) {
        try { await abortableDelay(this.options.idlePollMs, this.controller.signal); } catch { return; }
        continue;
      }
      await this.execute(workerId, task);
    }
  }

  private async execute(workerId: string, task: AgentTask): Promise<void> {
    const taskController = new AbortController();
    const activeKey = `${task.agentId}:${task.id}`;
    this.active.set(activeKey, taskController);
    const relayAbort = () => taskController.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener("abort", relayAbort, { once: true });
    const timeout = setTimeout(() => taskController.abort(new Error("Agent task runtime budget exceeded")), task.budget.maxRuntimeMs);
    const renewEvery = Math.max(100, Math.floor(this.options.leaseMs / 3));
    const renew = setInterval(() => { void this.store.renewLease(task.id, workerId, task.leaseGeneration, this.options.leaseMs).catch(() => taskController.abort(new Error("Agent task lease lost"))); }, renewEvery);
    try {
      const result = await this.runner.run(task, taskController.signal);
      await this.store.settleTask({ taskId: task.id, workerId, generation: task.leaseGeneration, ...result });
    } catch (error) {
      const latest = await this.store.getTask(task.id);
      if (!latest || latest.result || latest.task.status === "cancelled") return;
      const summary = error instanceof Error ? error.message : String(error);
      await this.store.settleTask({ taskId: task.id, workerId, generation: task.leaseGeneration, status: taskController.signal.aborted ? "cancelled" : "failed", summary }).catch(() => undefined);
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      this.active.delete(activeKey);
      this.controller.signal.removeEventListener("abort", relayAbort);
    }
  }
}

export function runManagerAgentTaskRunner(manager: Pick<RunManager, "start" | "wait" | "stop">): AgentTaskRunner {
  return {
    async run(task, signal) {
      const context = task.context.length > 0 ? `\n\nBounded delegated context (untrusted reference):\n${task.context.join("\n")}` : "";
      const runId = manager.start({ task: `${task.message}${context}`, metadata: { agentId: task.agentId, agentTaskId: task.id } }, { workspaceMode: "configured" });
      const abort = () => { manager.stop(runId); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const state = await manager.wait(runId);
        return {
          status: state.status === "completed" ? "succeeded" : state.status === "aborted" ? "cancelled" : "failed",
          summary: state.summary ?? state.stopReason ?? state.status,
          ...(state.summary ? { body: state.summary } : {}),
          artifacts: [`run:${runId}`],
        };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

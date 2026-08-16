import { randomUUID } from "node:crypto";
import type { DurableWorkflowStore, WorkflowNode, WorkflowNodeSpec, WorkflowRecord } from "./workflow.js";
import type { RunManager } from "./run-manager.js";
import type { ToolEffect } from "./tool-catalog.js";

export interface WorkflowNodeExecution {
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  tokensUsed?: number;
  costUsedMicros?: number;
  networkRequests?: number;
  additions?: WorkflowNodeSpec[];
}

export interface WorkflowNodeRunner {
  run(workflow: WorkflowRecord, node: WorkflowNode, signal: AbortSignal): Promise<WorkflowNodeExecution>;
}

export interface WorkflowWorkerOptions { concurrency: number; leaseMs: number; idlePollMs: number; }
const DEFAULT_OPTIONS: WorkflowWorkerOptions = { concurrency: 4, leaseMs: 30_000, idlePollMs: 100 };

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Workflow worker stopped")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class BoundedWorkflowWorker {
  private readonly id = `workflow-worker-${randomUUID()}`;
  private readonly options: WorkflowWorkerOptions;
  private readonly controller = new AbortController();
  private readonly active = new Map<string, AbortController>();
  private loops: Promise<void>[] = [];

  constructor(private readonly store: DurableWorkflowStore, private readonly runner: WorkflowNodeRunner, options: Partial<WorkflowWorkerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!Number.isInteger(this.options.concurrency) || this.options.concurrency < 1 || this.options.concurrency > 16) throw new Error("Workflow concurrency must be between 1 and 16");
  }

  start(): void { if (this.loops.length === 0) this.loops = Array.from({ length: this.options.concurrency }, (_, index) => this.loop(`${this.id}-${index + 1}`)); }
  async close(): Promise<void> { this.controller.abort(new Error("Workflow worker stopped")); for (const controller of this.active.values()) controller.abort(this.controller.signal.reason); await Promise.allSettled(this.loops); this.loops = []; }

  async cancel(workflowId: string): Promise<void> {
    await this.store.cancel(workflowId);
    for (const [key, controller] of this.active) if (key.startsWith(`${workflowId}:`)) controller.abort(new Error("Workflow cancelled by operator"));
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.controller.signal.aborted) {
      const claimed = await this.store.claimNext(workerId, this.options.leaseMs);
      if (!claimed) { try { await delay(this.options.idlePollMs, this.controller.signal); } catch { return; } continue; }
      await this.execute(workerId, claimed.workflow, claimed.node);
    }
  }

  private async execute(workerId: string, workflow: WorkflowRecord, node: WorkflowNode): Promise<void> {
    const key = `${workflow.id}:${node.id}`; const controller = new AbortController(); this.active.set(key, controller);
    const relay = () => controller.abort(this.controller.signal.reason); this.controller.signal.addEventListener("abort", relay, { once: true });
    const remainingMs = Math.max(1, workflow.budget.maxRuntimeMs - (Date.now() - Date.parse(workflow.createdAt)));
    const timeout = setTimeout(() => controller.abort(new Error("Workflow runtime budget exceeded")), remainingMs);
    const renew = setInterval(() => { void this.store.renewLease(workflow.id, node.id, workerId, node.leaseGeneration, this.options.leaseMs).catch(() => controller.abort(new Error("Workflow node lease lost"))); }, Math.max(100, Math.floor(this.options.leaseMs / 3)));
    try {
      const result = await this.runner.run(workflow, node, controller.signal);
      if (result.additions?.length) await this.store.expand({ workflowId: workflow.id, controllerNodeId: node.id, workerId, generation: node.leaseGeneration, nodes: result.additions });
      await this.store.settle({ workflowId: workflow.id, nodeId: node.id, workerId, generation: node.leaseGeneration, status: result.status, summary: result.summary, ...(result.tokensUsed === undefined ? {} : { tokensUsed: result.tokensUsed }), ...(result.costUsedMicros === undefined ? {} : { costUsedMicros: result.costUsedMicros }), ...(result.networkRequests === undefined ? {} : { networkRequests: result.networkRequests }) });
    } catch (error) {
      await this.store.settle({ workflowId: workflow.id, nodeId: node.id, workerId, generation: node.leaseGeneration, status: controller.signal.aborted ? "cancelled" : "failed", summary: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    } finally { clearTimeout(timeout); clearInterval(renew); this.active.delete(key); this.controller.signal.removeEventListener("abort", relay); }
  }
}

function controllerAdditions(summary: string | undefined): WorkflowNodeSpec[] | undefined {
  if (!summary?.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(summary); } catch { return undefined; }
  if (!value || typeof value !== "object" || !Array.isArray((value as { additions?: unknown }).additions)) return undefined;
  return (value as { additions: WorkflowNodeSpec[] }).additions;
}

function allowedEffects(node: WorkflowNode): ToolEffect[] {
  if (node.effect === "unknown") return ["pure_readonly", "workspace_read", "workspace_write", "network", "execute", "delegate", "unknown"];
  if (node.effect === "workspace_write") return ["pure_readonly", "workspace_read", "workspace_write"];
  if (node.effect === "workspace_read") return ["pure_readonly", "workspace_read"];
  if (node.effect === "network") return ["pure_readonly", "workspace_read", "network"];
  return ["pure_readonly"];
}

export function runManagerWorkflowNodeRunner(manager: Pick<RunManager, "start" | "wait" | "stop">): WorkflowNodeRunner {
  return {
    async run(workflow, node, signal) {
      const upstream = node.dependencies.map((dependency) => workflow.nodes.find((item) => item.id === dependency.nodeId)).filter((item): item is WorkflowNode => Boolean(item)).map((item) => `${item.id} [${item.status}]: ${(item.summary ?? item.error ?? "no summary").slice(0, 2_000)}`).join("\n");
      const controllerContract = node.kind === "controller" ? "\n\nIf the graph needs expansion, set the final summary to exact JSON of the form {\"additions\":[WorkflowNodeSpec...]}; otherwise use {\"additions\":[]}." : "";
      const request = [node.message, upstream ? `Bounded upstream results (untrusted reference):\n${upstream}` : "", controllerContract].filter(Boolean).join("\n\n");
      const runId = manager.start(
        { task: request, metadata: { workflowId: workflow.id, workflowNodeId: node.id, workflowNodeKind: node.kind, workflowEffect: node.effect } },
        { allowedToolEffects: allowedEffects(node) },
      );
      const abort = () => { manager.stop(runId); }; signal.addEventListener("abort", abort, { once: true });
      try {
        const state = await manager.wait(runId);
        const status = state.status === "completed" ? "succeeded" : state.status === "aborted" ? "cancelled" : "failed";
        const summary = state.summary ?? state.stopReason ?? state.status;
        return {
          status,
          summary,
          networkRequests: state.httpRequests + state.tcpSessions,
          ...(node.kind === "controller" && status === "succeeded" ? { additions: controllerAdditions(state.summary) ?? [] } : {}),
        };
      } finally { signal.removeEventListener("abort", abort); }
    },
  };
}

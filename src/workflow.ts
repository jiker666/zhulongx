import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeSensitiveText } from "./sanitize.js";

export type WorkflowNodeKind = "work" | "join" | "gate" | "controller";
export type WorkflowEffect = "pure_readonly" | "workspace_read" | "workspace_write" | "network" | "unknown";
export type WorkflowNodeStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
export type WorkflowStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowDependency { nodeId: string; condition: "success" | "settled"; }

export interface WorkflowNodeSpec {
  id: string;
  kind: WorkflowNodeKind;
  message: string;
  dependencies: WorkflowDependency[];
  effect: WorkflowEffect;
  cachePolicy: "none" | "evidence";
  evidenceVersion?: string;
  maxAttempts: number;
}

export interface WorkflowNode extends WorkflowNodeSpec {
  status: WorkflowNodeStatus;
  attempts: number;
  leaseGeneration: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface WorkflowBudget {
  maxNodes: number;
  maxRuntimeMs: number;
  maxNetworkNodes: number;
  maxNetworkRequests: number;
  maxTokens: number;
  maxCostMicros: number;
  maxControllerExpansions: number;
}

export interface WorkflowUsage {
  networkNodes: number;
  networkRequests: number;
  tokens: number;
  costMicros: number;
  controllerExpansions: number;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  status: WorkflowStatus;
  nodes: WorkflowNode[];
  budget: WorkflowBudget;
  usage: WorkflowUsage;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface WorkflowEvent {
  id: string;
  workflowId: string;
  nodeId?: string;
  type: string;
  detail?: string;
  createdAt: string;
}

interface WorkflowState { version: 1; workflows: WorkflowRecord[]; events: WorkflowEvent[]; }
export interface WorkflowStoreLimits { maxWorkflows: number; maxEvents: number; maxMessageChars: number; }

const DEFAULT_LIMITS: WorkflowStoreLimits = { maxWorkflows: 64, maxEvents: 4_096, maxMessageChars: 12_000 };
const TERMINAL_NODES = new Set<WorkflowNodeStatus>(["succeeded", "failed", "cancelled", "skipped"]);
const SIDE_EFFECTS = new Set<WorkflowEffect>(["workspace_write", "network", "unknown"]);

function now(): string { return new Date().toISOString(); }
function bounded(value: string, max: number): string { return sanitizeSensitiveText(value.trim()).slice(0, max); }
function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); return value; }
function nonnegative(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); return value; }

function validateBudget(input: WorkflowBudget): WorkflowBudget {
  return {
    maxNodes: positive(input.maxNodes, "workflow maxNodes"),
    maxRuntimeMs: positive(input.maxRuntimeMs, "workflow maxRuntimeMs"),
    maxNetworkNodes: nonnegative(input.maxNetworkNodes, "workflow maxNetworkNodes"),
    maxNetworkRequests: nonnegative(input.maxNetworkRequests, "workflow maxNetworkRequests"),
    maxTokens: positive(input.maxTokens, "workflow maxTokens"),
    maxCostMicros: positive(input.maxCostMicros, "workflow maxCostMicros"),
    maxControllerExpansions: nonnegative(input.maxControllerExpansions, "workflow maxControllerExpansions"),
  };
}

function sanitizeNode(input: WorkflowNodeSpec, maxMessageChars: number): WorkflowNodeSpec {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.id)) throw new Error(`Invalid workflow node id: ${input.id}`);
  if (!input.message.trim()) throw new Error(`Workflow node ${input.id} message must not be empty`);
  if (!["work", "join", "gate", "controller"].includes(input.kind)) throw new Error(`Invalid workflow node kind: ${input.kind}`);
  if (!["pure_readonly", "workspace_read", "workspace_write", "network", "unknown"].includes(input.effect)) throw new Error(`Invalid workflow node effect: ${input.effect}`);
  if (!["none", "evidence"].includes(input.cachePolicy)) throw new Error(`Invalid workflow cache policy: ${input.cachePolicy}`);
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10) throw new Error(`Workflow node ${input.id} maxAttempts must be between 1 and 10`);
  if (input.cachePolicy === "evidence" && !input.evidenceVersion?.trim()) throw new Error(`Workflow node ${input.id} requires evidenceVersion for caching`);
  return {
    id: input.id,
    kind: input.kind,
    message: bounded(input.message, maxMessageChars),
    dependencies: input.dependencies.map((item) => ({ nodeId: item.nodeId, condition: item.condition })),
    effect: input.effect,
    cachePolicy: input.cachePolicy,
    ...(input.evidenceVersion ? { evidenceVersion: bounded(input.evidenceVersion, 256) } : {}),
    maxAttempts: input.maxAttempts,
  };
}

function validateGraph(nodes: WorkflowNodeSpec[], maxNodes: number): void {
  if (nodes.length < 1 || nodes.length > maxNodes) throw new Error(`Workflow must contain between 1 and ${maxNodes} nodes`);
  const ids = new Set<string>();
  for (const node of nodes) { if (ids.has(node.id)) throw new Error(`Duplicate workflow node: ${node.id}`); ids.add(node.id); }
  for (const node of nodes) for (const dependency of node.dependencies) {
    if (!ids.has(dependency.nodeId)) throw new Error(`Workflow node ${node.id} has unknown dependency ${dependency.nodeId}`);
    if (dependency.nodeId === node.id) throw new Error(`Workflow node ${node.id} cannot depend on itself`);
    if (!["success", "settled"].includes(dependency.condition)) throw new Error(`Invalid dependency condition on ${node.id}`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Workflow graph must be acyclic");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency.nodeId);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function workflowCacheKey(node: WorkflowNodeSpec): string | undefined {
  if (node.cachePolicy !== "evidence" || !node.evidenceVersion) return undefined;
  return createHash("sha256").update(JSON.stringify({ kind: node.kind, message: node.message, dependencies: node.dependencies, effect: node.effect, evidenceVersion: node.evidenceVersion })).digest("hex");
}

export class DurableWorkflowStore {
  readonly path: string;
  readonly limits: WorkflowStoreLimits;
  private queue = Promise.resolve();

  constructor(root: string, limits: Partial<WorkflowStoreLimits> = {}) { this.path = join(root, "workflows.json"); this.limits = { ...DEFAULT_LIMITS, ...limits }; }

  async create(input: { name: string; nodes: WorkflowNodeSpec[]; budget: WorkflowBudget }): Promise<WorkflowRecord> {
    return await this.mutate((state) => {
      if (state.workflows.length >= this.limits.maxWorkflows) throw new Error("Workflow store budget exhausted");
      if (!input.name.trim()) throw new Error("Workflow name must not be empty");
      const budget = validateBudget(input.budget);
      const specs = input.nodes.map((node) => sanitizeNode(node, this.limits.maxMessageChars));
      validateGraph(specs, budget.maxNodes);
      const createdAt = now(); const id = randomUUID();
      const workflow: WorkflowRecord = {
        id, name: bounded(input.name, 200), status: "queued",
        nodes: specs.map((node) => ({ ...node, status: "queued", attempts: 0, leaseGeneration: 0, updatedAt: createdAt })),
        budget, usage: { networkNodes: 0, networkRequests: 0, tokens: 0, costMicros: 0, controllerExpansions: 0 },
        createdAt, updatedAt: createdAt,
      };
      state.workflows.push(workflow); this.event(state, workflow.id, "workflow.created", undefined, `${workflow.nodes.length} nodes`); return workflow;
    });
  }

  async get(id: string): Promise<WorkflowRecord | undefined> { return (await this.read()).workflows.find((item) => item.id === id); }
  async snapshot(): Promise<WorkflowState> { return await this.read(); }

  async claimNext(workerId: string, leaseMs: number): Promise<{ workflow: WorkflowRecord; node: WorkflowNode } | undefined> {
    return await this.mutate((state) => {
      for (const workflow of state.workflows.filter((item) => item.status === "queued" || item.status === "running")) {
        this.recoverExpired(state, workflow);
        this.skipUnreachable(state, workflow);
        if (Date.now() - Date.parse(workflow.createdAt) >= workflow.budget.maxRuntimeMs) { this.cancelWorkflow(state, workflow, "Workflow runtime budget exceeded"); continue; }
        const node = workflow.nodes.find((candidate) => candidate.status === "queued" && this.dependenciesReady(workflow, candidate) && this.effectAvailable(workflow, candidate.effect));
        if (!node) { this.finishIfSettled(state, workflow); continue; }
        if (node.effect === "network" && workflow.usage.networkNodes >= workflow.budget.maxNetworkNodes) {
          node.status = "failed"; node.error = "Workflow network node budget exceeded"; node.finishedAt = now(); node.updatedAt = node.finishedAt;
          this.event(state, workflow.id, "workflow.node_failed", node.id, node.error); this.skipUnreachable(state, workflow); this.finishIfSettled(state, workflow); continue;
        }
        const timestamp = now(); node.status = "running"; node.attempts += 1; node.leaseGeneration += 1; node.leaseOwner = bounded(workerId, 128); node.leaseExpiresAt = new Date(Date.now() + positive(leaseMs, "workflow leaseMs")).toISOString(); node.startedAt ??= timestamp; node.updatedAt = timestamp;
        workflow.status = "running"; workflow.updatedAt = timestamp; if (node.effect === "network") workflow.usage.networkNodes += 1;
        this.event(state, workflow.id, "workflow.node_claimed", node.id, `generation=${node.leaseGeneration}`);
        return { workflow, node };
      }
      return undefined;
    });
  }

  async renewLease(workflowId: string, nodeId: string, workerId: string, generation: number, leaseMs: number): Promise<WorkflowNode> {
    return await this.mutate((state) => { const { workflow, node } = this.assertLease(state, workflowId, nodeId, workerId, generation); node.leaseExpiresAt = new Date(Date.now() + positive(leaseMs, "workflow leaseMs")).toISOString(); node.updatedAt = now(); workflow.updatedAt = node.updatedAt; return node; });
  }

  async settle(input: { workflowId: string; nodeId: string; workerId: string; generation: number; status: "succeeded" | "failed" | "cancelled"; summary: string; tokensUsed?: number; costUsedMicros?: number; networkRequests?: number }): Promise<WorkflowNode> {
    return await this.mutate((state) => {
      const { workflow, node } = this.assertLease(state, input.workflowId, input.nodeId, input.workerId, input.generation);
      workflow.usage.tokens += nonnegative(input.tokensUsed ?? 0, "workflow tokensUsed"); workflow.usage.costMicros += nonnegative(input.costUsedMicros ?? 0, "workflow costUsedMicros"); workflow.usage.networkRequests += nonnegative(input.networkRequests ?? 0, "workflow networkRequests");
      const overBudget = workflow.usage.tokens > workflow.budget.maxTokens || workflow.usage.costMicros > workflow.budget.maxCostMicros || workflow.usage.networkRequests > workflow.budget.maxNetworkRequests;
      const status = overBudget ? "failed" : input.status;
      const timestamp = now(); delete node.leaseOwner; delete node.leaseExpiresAt;
      if (status === "failed" && node.attempts < node.maxAttempts && !overBudget) { node.status = "queued"; node.error = bounded(input.summary, 4_000); }
      else { node.status = status; node.finishedAt = timestamp; if (status === "succeeded") node.summary = bounded(input.summary, 8_000); else node.error = bounded(overBudget ? "Workflow aggregate budget exceeded" : input.summary, 4_000); }
      node.updatedAt = timestamp; workflow.updatedAt = timestamp;
      this.event(state, workflow.id, node.status === "queued" ? "workflow.node_retry" : `workflow.node_${node.status}`, node.id, node.summary ?? node.error);
      this.skipUnreachable(state, workflow); this.finishIfSettled(state, workflow); return node;
    });
  }

  async expand(input: { workflowId: string; controllerNodeId: string; workerId: string; generation: number; nodes: WorkflowNodeSpec[] }): Promise<WorkflowRecord> {
    return await this.mutate((state) => {
      const { workflow, node: controller } = this.assertLease(state, input.workflowId, input.controllerNodeId, input.workerId, input.generation);
      if (controller.kind !== "controller") throw new Error("Only controller nodes may expand a workflow");
      if (workflow.usage.controllerExpansions >= workflow.budget.maxControllerExpansions) throw new Error("Workflow controller expansion budget exceeded");
      const additions = input.nodes.map((node) => sanitizeNode(node, this.limits.maxMessageChars));
      const combined: WorkflowNodeSpec[] = [
        ...workflow.nodes.map((current) => ({
          id: current.id, kind: current.kind, message: current.message,
          dependencies: current.dependencies, effect: current.effect,
          cachePolicy: current.cachePolicy,
          ...(current.evidenceVersion ? { evidenceVersion: current.evidenceVersion } : {}),
          maxAttempts: current.maxAttempts,
        })),
        ...additions,
      ];
      validateGraph(combined, workflow.budget.maxNodes);
      const timestamp = now(); workflow.nodes.push(...additions.map((node) => ({ ...node, status: "queued" as const, attempts: 0, leaseGeneration: 0, updatedAt: timestamp }))); workflow.usage.controllerExpansions += 1; workflow.updatedAt = timestamp;
      this.event(state, workflow.id, "workflow.expanded", controller.id, `${additions.length} nodes`); return workflow;
    });
  }

  async cancel(id: string, reason = "Workflow cancelled by operator"): Promise<WorkflowRecord> {
    return await this.mutate((state) => { const workflow = state.workflows.find((item) => item.id === id); if (!workflow) throw new Error("Workflow not found"); this.cancelWorkflow(state, workflow, reason); return workflow; });
  }

  private dependenciesReady(workflow: WorkflowRecord, node: WorkflowNode): boolean {
    return node.dependencies.every((dependency) => { const upstream = workflow.nodes.find((item) => item.id === dependency.nodeId)!; return dependency.condition === "success" ? upstream.status === "succeeded" : TERMINAL_NODES.has(upstream.status); });
  }

  private effectAvailable(workflow: WorkflowRecord, effect: WorkflowEffect): boolean {
    const running = workflow.nodes.filter((node) => node.status === "running");
    if (effect === "unknown") return running.length === 0;
    if (effect === "pure_readonly" || effect === "network") return !running.some((node) => node.effect === "unknown");
    if (effect === "workspace_read") return !running.some((node) => node.effect === "workspace_write" || node.effect === "unknown");
    return !running.some((node) => node.effect === "workspace_read" || node.effect === "workspace_write" || node.effect === "unknown");
  }

  private skipUnreachable(state: WorkflowState, workflow: WorkflowRecord): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of workflow.nodes.filter((item) => item.status === "queued")) {
        const unreachable = node.dependencies.some((dependency) => dependency.condition === "success" && TERMINAL_NODES.has(workflow.nodes.find((item) => item.id === dependency.nodeId)!.status) && workflow.nodes.find((item) => item.id === dependency.nodeId)!.status !== "succeeded");
        if (unreachable) { node.status = "skipped"; node.error = "Required successful dependency did not succeed"; node.finishedAt = now(); node.updatedAt = node.finishedAt; this.event(state, workflow.id, "workflow.node_skipped", node.id, node.error); changed = true; }
      }
    }
  }

  private recoverExpired(state: WorkflowState, workflow: WorkflowRecord): void {
    const timestamp = now();
    for (const node of workflow.nodes.filter((item) => item.status === "running" && Date.parse(item.leaseExpiresAt ?? "") <= Date.now())) {
      delete node.leaseOwner; delete node.leaseExpiresAt; node.updatedAt = timestamp;
      if (SIDE_EFFECTS.has(node.effect)) { node.status = "failed"; node.error = "Lease expired; side-effecting node was not replayed"; node.finishedAt = timestamp; this.event(state, workflow.id, "workflow.node_no_replay", node.id, node.error); }
      else if (node.attempts >= node.maxAttempts) { node.status = "failed"; node.error = "Workflow node attempt budget exhausted"; node.finishedAt = timestamp; this.event(state, workflow.id, "workflow.node_failed", node.id, node.error); }
      else { node.status = "queued"; this.event(state, workflow.id, "workflow.node_requeued", node.id, "lease expired"); }
    }
  }

  private finishIfSettled(state: WorkflowState, workflow: WorkflowRecord): void {
    if (!workflow.nodes.every((node) => TERMINAL_NODES.has(node.status))) return;
    workflow.status = workflow.nodes.every((node) => node.status === "succeeded") ? "succeeded" : workflow.nodes.some((node) => node.status === "cancelled") ? "cancelled" : "failed";
    workflow.finishedAt = now(); workflow.updatedAt = workflow.finishedAt; this.event(state, workflow.id, `workflow.${workflow.status}`);
  }

  private cancelWorkflow(state: WorkflowState, workflow: WorkflowRecord, reason: string): void {
    if (["succeeded", "failed", "cancelled"].includes(workflow.status)) return;
    const timestamp = now(); for (const node of workflow.nodes.filter((item) => !TERMINAL_NODES.has(item.status))) { node.status = "cancelled"; node.error = bounded(reason, 4_000); node.finishedAt = timestamp; node.updatedAt = timestamp; delete node.leaseOwner; delete node.leaseExpiresAt; }
    workflow.status = "cancelled"; workflow.finishedAt = timestamp; workflow.updatedAt = timestamp; this.event(state, workflow.id, "workflow.cancelled", undefined, reason);
  }

  private assertLease(state: WorkflowState, workflowId: string, nodeId: string, workerId: string, generation: number): { workflow: WorkflowRecord; node: WorkflowNode } {
    const workflow = state.workflows.find((item) => item.id === workflowId); if (!workflow) throw new Error("Workflow not found");
    const node = workflow.nodes.find((item) => item.id === nodeId); if (!node) throw new Error("Workflow node not found");
    if (node.status !== "running" || node.leaseOwner !== workerId || node.leaseGeneration !== generation) throw new Error("Stale workflow node lease");
    if (Date.parse(node.leaseExpiresAt ?? "") <= Date.now()) throw new Error("Workflow node lease expired");
    return { workflow, node };
  }

  private event(state: WorkflowState, workflowId: string, type: string, nodeId?: string, detail?: string): void { state.events.push({ id: randomUUID(), workflowId, type, ...(nodeId ? { nodeId } : {}), ...(detail ? { detail: bounded(detail, 500) } : {}), createdAt: now() }); state.events = state.events.slice(-this.limits.maxEvents); }

  private async mutate<T>(operation: (state: WorkflowState) => T): Promise<T> { let result!: T; const pending = this.queue.then(async () => { const state = await this.read(); result = operation(state); await this.write(state); }); this.queue = pending.then(() => undefined, () => undefined); await pending; return result; }
  private async read(): Promise<WorkflowState> { try { const value = JSON.parse(await readFile(this.path, "utf8")) as WorkflowState; return { version: 1, workflows: value.workflows ?? [], events: value.events ?? [] }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workflows: [], events: [] }; throw error; } }
  private async write(state: WorkflowState): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`; try { await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, this.path); } finally { await rm(temporary, { force: true }); } }
}

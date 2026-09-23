import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeSensitiveText } from "./sanitize.js";

export type AgentPurpose = "joined" | "addressable";
export type AgentStatus = "initializing" | "idle" | "running" | "interrupted" | "error" | "closed";
export type AgentTaskStatus = "queued" | "starting" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface AgentNode {
  id: string;
  rootAgentId: string;
  parentAgentId?: string;
  path: string;
  purpose: AgentPurpose;
  status: AgentStatus;
  profileId: string;
  depth: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskBudget {
  maxRuntimeMs: number;
  maxTokens: number;
  maxCostMicros: number;
}

export interface AgentTask {
  id: string;
  agentId: string;
  parentTaskId?: string;
  ownerTurnId?: string;
  kind: "delegation" | "workflow_node" | "team_turn";
  awaitPolicy: "join" | "background";
  cancelPolicy: "linked" | "detached";
  status: AgentTaskStatus;
  message: string;
  context: string[];
  leaseGeneration: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attempts: number;
  providerTokensUsed: number;
  providerCostUsedMicros: number;
  budget: AgentTaskBudget;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskResult {
  taskId: string;
  agentId: string;
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  body?: string;
  artifacts: string[];
  unread: boolean;
  leaseGeneration: number;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface AgentMailboxMessage {
  id: string;
  agentId: string;
  senderAgentId?: string;
  text: string;
  createdAt: string;
  delivered: boolean;
}

export interface AgentStoreEvent {
  id: string;
  type: string;
  agentId?: string;
  taskId?: string;
  detail?: string;
  createdAt: string;
}

export interface AgentStoreState {
  version: 1;
  agents: AgentNode[];
  tasks: AgentTask[];
  results: AgentTaskResult[];
  messages: AgentMailboxMessage[];
  events: AgentStoreEvent[];
}

export interface AgentStoreLimits {
  maxAgents: number;
  maxTasks: number;
  maxDepth: number;
  maxContextItems: number;
  maxMessageChars: number;
  maxMailboxMessages: number;
  maxEvents: number;
}

const TERMINAL_TASKS = new Set<AgentTaskStatus>(["succeeded", "failed", "cancelled"]);
const DEFAULT_LIMITS: AgentStoreLimits = { maxAgents: 64, maxTasks: 512, maxDepth: 3, maxContextItems: 12, maxMessageChars: 12_000, maxMailboxMessages: 256, maxEvents: 2_048 };

function now(): string { return new Date().toISOString(); }
function bounded(value: string, length: number): string {
  return sanitizeSensitiveText(value.trim()).slice(0, length);
}
function positiveBudget(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export class DurableAgentStore {
  readonly path: string;
  readonly limits: AgentStoreLimits;
  private queue = Promise.resolve();

  constructor(root: string, limits: Partial<AgentStoreLimits> = {}) {
    this.path = join(root, "agents.json");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async createAgent(input: { parentAgentId?: string; purpose: AgentPurpose; profileId: string }): Promise<AgentNode> {
    return await this.mutate((state) => {
      if (!input.profileId.trim()) throw new Error("Agent profileId must not be empty");
      if (state.agents.length >= this.limits.maxAgents) throw new Error("Agent budget exhausted");
      const parent = input.parentAgentId ? state.agents.find((item) => item.id === input.parentAgentId) : undefined;
      if (input.parentAgentId && !parent) throw new Error("Parent agent not found");
      const depth = parent ? parent.depth + 1 : 0;
      if (depth > this.limits.maxDepth) throw new Error("Agent nesting limit reached");
      const id = randomUUID();
      const createdAt = now();
      const agent: AgentNode = {
        id,
        rootAgentId: parent?.rootAgentId ?? id,
        ...(parent ? { parentAgentId: parent.id } : {}),
        path: parent ? `${parent.path}/${id}` : `/agents/${id}`,
        purpose: input.purpose,
        status: "idle",
        profileId: bounded(input.profileId, 128),
        depth,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      };
      state.agents.push(agent);
      this.event(state, { type: "agent.created", agentId: agent.id, detail: agent.purpose });
      return agent;
    });
  }

  async enqueueTask(input: Omit<AgentTask, "id" | "status" | "leaseGeneration" | "attempts" | "providerTokensUsed" | "providerCostUsedMicros" | "version" | "createdAt" | "updatedAt" | "context" | "message"> & { message: string; context?: string[] }): Promise<AgentTask> {
    return await this.mutate((state) => {
      if (!input.message.trim()) throw new Error("Agent task message must not be empty");
      if (state.tasks.length >= this.limits.maxTasks) throw new Error("Agent task budget exhausted");
      const agent = state.agents.find((item) => item.id === input.agentId);
      if (!agent || ["closed", "interrupted"].includes(agent.status)) throw new Error("Agent is unavailable");
      if (input.parentTaskId && !state.tasks.some((item) => item.id === input.parentTaskId)) throw new Error("Parent task not found");
      const createdAt = now();
      const task: AgentTask = {
        id: randomUUID(), agentId: input.agentId,
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.ownerTurnId ? { ownerTurnId: input.ownerTurnId } : {}),
        kind: input.kind, awaitPolicy: input.awaitPolicy, cancelPolicy: input.cancelPolicy,
        status: "queued", message: bounded(input.message, this.limits.maxMessageChars),
        context: (input.context ?? []).slice(-this.limits.maxContextItems).map((item) => bounded(item, 2_000)),
        leaseGeneration: 0, attempts: 0, providerTokensUsed: 0, providerCostUsedMicros: 0,
        budget: {
          maxRuntimeMs: positiveBudget(input.budget.maxRuntimeMs, "Agent task maxRuntimeMs"),
          maxTokens: positiveBudget(input.budget.maxTokens, "Agent task maxTokens"),
          maxCostMicros: positiveBudget(input.budget.maxCostMicros, "Agent task maxCostMicros"),
        }, version: 1, createdAt, updatedAt: createdAt,
      };
      state.tasks.push(task);
      this.event(state, { type: "agent.task_queued", agentId: task.agentId, taskId: task.id, detail: task.awaitPolicy });
      return task;
    });
  }

  async followupTask(agentId: string, message: string, input: { parentTaskId?: string; ownerTurnId?: string; awaitPolicy?: AgentTask["awaitPolicy"]; cancelPolicy?: AgentTask["cancelPolicy"]; context?: string[]; budget: AgentTaskBudget }): Promise<AgentTask> {
    return await this.enqueueTask({ agentId, ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), ...(input.ownerTurnId ? { ownerTurnId: input.ownerTurnId } : {}), kind: "delegation", awaitPolicy: input.awaitPolicy ?? "background", cancelPolicy: input.cancelPolicy ?? "linked", message, ...(input.context ? { context: input.context } : {}), budget: input.budget });
  }

  async claimNext(workerId: string, leaseMs: number): Promise<AgentTask | undefined> {
    return await this.mutate((state) => {
      const current = Date.now();
      const task = state.tasks.find((item) => item.status === "queued" || (["starting", "running", "waiting"].includes(item.status) && Date.parse(item.leaseExpiresAt ?? "") <= current));
      if (!task) return undefined;
      task.status = "starting"; task.leaseGeneration += 1; task.leaseOwner = bounded(workerId, 128); task.leaseExpiresAt = new Date(current + leaseMs).toISOString(); task.attempts += 1; task.version += 1; task.updatedAt = now();
      const agent = state.agents.find((item) => item.id === task.agentId);
      if (agent) { agent.status = "running"; agent.version += 1; agent.updatedAt = task.updatedAt; }
      this.event(state, { type: "agent.task_claimed", agentId: task.agentId, taskId: task.id, detail: `generation=${task.leaseGeneration}` });
      return task;
    });
  }

  async renewLease(taskId: string, workerId: string, generation: number, leaseMs: number): Promise<AgentTask> {
    return await this.updateTask(taskId, workerId, generation, (task) => { task.status = "running"; task.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString(); });
  }

  async settleTask(input: { taskId: string; workerId: string; generation: number; status: AgentTaskResult["status"]; summary: string; body?: string; artifacts?: string[]; tokensUsed?: number; costUsedMicros?: number }): Promise<AgentTaskResult> {
    return await this.mutate((state) => {
      const task = this.assertLease(state, input.taskId, input.workerId, input.generation);
      task.providerTokensUsed += Math.max(0, input.tokensUsed ?? 0);
      task.providerCostUsedMicros += Math.max(0, input.costUsedMicros ?? 0);
      if (task.providerTokensUsed > task.budget.maxTokens || task.providerCostUsedMicros > task.budget.maxCostMicros) throw new Error("Agent task provider budget exceeded");
      task.status = input.status; task.version += 1; task.updatedAt = now(); delete task.leaseOwner; delete task.leaseExpiresAt;
      const result: AgentTaskResult = { taskId: task.id, agentId: task.agentId, status: input.status, summary: bounded(input.summary, 4_000), ...(input.body ? { body: bounded(input.body, this.limits.maxMessageChars) } : {}), artifacts: (input.artifacts ?? []).slice(0, 32).map((item) => bounded(item, 500)), unread: true, leaseGeneration: input.generation, createdAt: task.updatedAt };
      state.results = state.results.filter((item) => item.taskId !== task.id);
      state.results.push(result);
      const agent = state.agents.find((item) => item.id === task.agentId);
      if (agent) { agent.status = input.status === "failed" ? "error" : "idle"; agent.version += 1; agent.updatedAt = task.updatedAt; }
      this.event(state, { type: "agent.task_settled", agentId: task.agentId, taskId: task.id, detail: input.status });
      return result;
    });
  }

  async acknowledge(taskId: string): Promise<AgentTaskResult> {
    return await this.mutate((state) => {
      const result = state.results.find((item) => item.taskId === taskId);
      if (!result) throw new Error("Agent task result not found");
      result.unread = false; result.acknowledgedAt = now(); return result;
    });
  }

  async sendMessage(agentId: string, text: string, senderAgentId?: string): Promise<AgentMailboxMessage> {
    return await this.mutate((state) => {
      if (!state.agents.some((item) => item.id === agentId)) throw new Error("Agent not found");
      const message: AgentMailboxMessage = { id: randomUUID(), agentId, ...(senderAgentId ? { senderAgentId } : {}), text: bounded(text, this.limits.maxMessageChars), createdAt: now(), delivered: false };
      state.messages.push(message); state.messages = state.messages.slice(-this.limits.maxMailboxMessages);
      this.event(state, { type: "agent.message_sent", agentId, detail: message.id });
      return message;
    });
  }

  async drainMessages(agentId: string): Promise<AgentMailboxMessage[]> {
    return await this.mutate((state) => { const messages = state.messages.filter((item) => item.agentId === agentId && !item.delivered); for (const item of messages) item.delivered = true; return messages; });
  }

  async interruptAgent(agentId: string): Promise<AgentNode> {
    return await this.mutate((state) => {
      const agent = state.agents.find((item) => item.id === agentId); if (!agent) throw new Error("Agent not found");
      agent.status = "interrupted"; agent.version += 1; agent.updatedAt = now();
      for (const task of state.tasks.filter((item) => item.agentId === agentId && !TERMINAL_TASKS.has(item.status))) {
        task.status = "cancelled"; task.version += 1; task.updatedAt = agent.updatedAt; delete task.leaseOwner; delete task.leaseExpiresAt;
        if (!state.results.some((item) => item.taskId === task.id)) state.results.push({ taskId: task.id, agentId, status: "cancelled", summary: "Interrupted by operator", artifacts: [], unread: true, leaseGeneration: task.leaseGeneration, createdAt: agent.updatedAt });
      }
      this.event(state, { type: "agent.interrupted", agentId });
      return agent;
    });
  }

  async snapshot(): Promise<AgentStoreState> { return await this.read(); }

  async getAgent(agentId: string): Promise<{ agent: AgentNode; tasks: AgentTask[]; results: AgentTaskResult[]; messages: AgentMailboxMessage[] } | undefined> {
    const state = await this.read();
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) return undefined;
    return { agent, tasks: state.tasks.filter((item) => item.agentId === agentId), results: state.results.filter((item) => item.agentId === agentId), messages: state.messages.filter((item) => item.agentId === agentId) };
  }

  async getTask(taskId: string): Promise<{ task: AgentTask; result?: AgentTaskResult } | undefined> {
    const state = await this.read();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return undefined;
    const result = state.results.find((item) => item.taskId === taskId);
    return { task, ...(result ? { result } : {}) };
  }

  async waitResult(taskId: string, options: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }): Promise<AgentTaskResult | undefined> {
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    const pollMs = Math.max(10, Math.min(options.pollMs ?? 100, 1_000));
    while (true) {
      options.signal?.throwIfAborted();
      const value = await this.getTask(taskId);
      if (!value) throw new Error("Agent task not found");
      if (value.result) return value.result;
      if (Date.now() >= deadline) return undefined;
      await new Promise<void>((resolveDelay, rejectDelay) => {
        const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolveDelay(); }, Math.min(pollMs, deadline - Date.now()));
        const abort = () => { clearTimeout(timer); rejectDelay(options.signal?.reason ?? new Error("Agent result wait aborted")); };
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  private async updateTask(taskId: string, workerId: string, generation: number, update: (task: AgentTask) => void): Promise<AgentTask> {
    return await this.mutate((state) => { const task = this.assertLease(state, taskId, workerId, generation); update(task); task.version += 1; task.updatedAt = now(); return task; });
  }

  private assertLease(state: AgentStoreState, taskId: string, workerId: string, generation: number): AgentTask {
    const task = state.tasks.find((item) => item.id === taskId); if (!task) throw new Error("Agent task not found");
    if (task.leaseOwner !== workerId || task.leaseGeneration !== generation) throw new Error("Stale agent task lease");
    if (Date.parse(task.leaseExpiresAt ?? "") <= Date.now()) throw new Error("Agent task lease expired");
    return task;
  }

  private event(state: AgentStoreState, input: Omit<AgentStoreEvent, "id" | "createdAt">): void {
    state.events.push({ id: randomUUID(), ...input, ...(input.detail ? { detail: bounded(input.detail, 500) } : {}), createdAt: now() });
    state.events = state.events.slice(-this.limits.maxEvents);
  }

  private async mutate<T>(operation: (state: AgentStoreState) => T): Promise<T> {
    let result!: T;
    const pending = this.queue.then(async () => { const state = await this.read(); result = operation(state); await this.write(state); });
    this.queue = pending.then(() => undefined, () => undefined);
    await pending; return result;
  }

  private async read(): Promise<AgentStoreState> {
    try { const value = JSON.parse(await readFile(this.path, "utf8")) as AgentStoreState; return { version: 1, agents: value.agents ?? [], tasks: value.tasks ?? [], results: value.results ?? [], messages: value.messages ?? [], events: value.events ?? [] }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, agents: [], tasks: [], results: [], messages: [], events: [] };
      // A truncated store (e.g. zero-byte file left by an unclean shutdown) must not
      // crash-loop the whole API process: quarantine the file and start from empty state.
      if (error instanceof SyntaxError) {
        await rename(this.path, `${this.path}.corrupt-${randomUUID()}`).catch(() => {});
        return { version: 1, agents: [], tasks: [], results: [], messages: [], events: [] };
      }
      throw error;
    }
  }

  private async write(state: AgentStoreState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
  }
}

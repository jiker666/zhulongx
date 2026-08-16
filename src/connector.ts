import { randomUUID } from "node:crypto";
import type { Executor, ExecutorDirEntry, ExecutorExecResult, ExecutorFileStat, ExecutorHealth, ExecutorPath, ExecutorReadResult } from "./executor.js";
import type { SandboxExecRequest, SandboxExecResult } from "./sandbox.js";
import { sanitizeSensitiveText } from "./sanitize.js";

export type ConnectorOperation =
  | { type: "exec"; input: SandboxExecRequest }
  | { type: "read_file"; path: ExecutorPath; offset: number; maxBytes: number }
  | { type: "write_file"; path: ExecutorPath; dataBase64: string; append: boolean; maxBytes: number }
  | { type: "list_dir"; path: ExecutorPath; depth: number; maxEntries: number }
  | { type: "stat"; path: ExecutorPath };

export interface ConnectorTask {
  id: string;
  connectorId: string;
  connectionGeneration: number;
  leaseGeneration: number;
  operation: ConnectorOperation;
  createdAt: string;
  leaseExpiresAt?: string;
}

export interface ConnectorConfig {
  id: string;
  capabilities: string[];
  allowedPrograms: string[];
  networkAccess: boolean;
  heartbeatTimeoutMs: number;
  maxPendingTasks: number;
  maxOutputBytes: number;
}

export interface ConnectorSnapshot {
  id: string;
  status: "online" | "offline";
  generation: number;
  instanceId?: string;
  capabilities: string[];
  allowedPrograms: string[];
  networkAccess: boolean;
  connectedAt?: string;
  lastHeartbeatAt?: string;
  pendingTasks: number;
}

interface PendingTask {
  task: ConnectorTask;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

interface ConnectorState {
  config: ConnectorConfig;
  generation: number;
  instanceId?: string;
  connectedAt?: string;
  lastHeartbeatAt?: string;
  queue: PendingTask[];
  active: Map<string, PendingTask>;
}

function bounded(value: string, max: number): string { return sanitizeSensitiveText(value).slice(0, max); }
function safeId(value: string, label: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}`); return value; }
function safePath(path: ExecutorPath): ExecutorPath { if (!path.path || path.path.includes("\0") || path.path.startsWith("/") || path.path.split(/[\\/]/).includes("..")) throw new Error("Connector paths must be safe relative paths"); return path; }

export class ConnectorBroker {
  private readonly connectors = new Map<string, ConnectorState>();

  constructor(configs: ConnectorConfig[]) {
    for (const config of configs) {
      const id = safeId(config.id, "connector id"); if (this.connectors.has(id)) throw new Error(`Duplicate connector id: ${id}`);
      if (!Number.isSafeInteger(config.heartbeatTimeoutMs) || config.heartbeatTimeoutMs <= 0) throw new Error("Connector heartbeatTimeoutMs must be positive");
      if (!Number.isSafeInteger(config.maxPendingTasks) || config.maxPendingTasks <= 0) throw new Error("Connector maxPendingTasks must be positive");
      if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes <= 0) throw new Error("Connector maxOutputBytes must be positive");
      this.connectors.set(id, { config: { ...config, capabilities: [...new Set(config.capabilities)], allowedPrograms: [...new Set(config.allowedPrograms)] }, generation: 0, queue: [], active: new Map() });
    }
  }

  register(id: string, instanceId: string): ConnectorSnapshot {
    const state = this.required(id); safeId(instanceId, "connector instance id");
    const timestamp = new Date().toISOString();
    if (state.instanceId !== instanceId) {
      state.generation += 1;
      this.rejectOutstanding(state, new Error("Connector rebound to a new instance"));
    }
    state.instanceId = instanceId; state.connectedAt = timestamp; state.lastHeartbeatAt = timestamp;
    return this.snapshotOf(state);
  }

  heartbeat(id: string, instanceId: string, generation: number): ConnectorSnapshot {
    const state = this.assertConnection(id, instanceId, generation); state.lastHeartbeatAt = new Date().toISOString(); return this.snapshotOf(state);
  }

  list(): ConnectorSnapshot[] { return [...this.connectors.values()].map((state) => this.snapshotOf(state)); }
  get(id: string): ConnectorSnapshot | undefined { const state = this.connectors.get(id); return state ? this.snapshotOf(state) : undefined; }

  async dispatch(id: string, operation: ConnectorOperation, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted(); const state = this.required(id);
    if (!this.online(state)) throw new Error("Connector is offline");
    if (state.queue.length + state.active.size >= state.config.maxPendingTasks) throw new Error("Connector pending task budget exhausted");
    const task: ConnectorTask = { id: randomUUID(), connectorId: id, connectionGeneration: state.generation, leaseGeneration: 0, operation: this.validateOperation(state, operation), createdAt: new Date().toISOString() };
    return await new Promise((resolve, reject) => {
      const pending: PendingTask = { task, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) { pending.abort = () => { state.queue = state.queue.filter((item) => item !== pending); state.active.delete(task.id); reject(signal.reason ?? new Error("Connector operation aborted")); }; signal.addEventListener("abort", pending.abort, { once: true }); }
      state.queue.push(pending);
    });
  }

  claim(id: string, instanceId: string, generation: number, leaseMs: number): ConnectorTask | undefined {
    const state = this.assertConnection(id, instanceId, generation); this.requeueExpired(state);
    const pending = state.queue.shift(); if (!pending) return undefined;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Connector task leaseMs must be positive");
    pending.task.leaseGeneration += 1; pending.task.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString(); state.active.set(pending.task.id, pending); return structuredClone(pending.task);
  }

  resolve(id: string, instanceId: string, generation: number, taskId: string, leaseGeneration: number, input: { result?: unknown; error?: string }): void {
    const state = this.assertConnection(id, instanceId, generation); const pending = state.active.get(taskId);
    if (!pending || pending.task.leaseGeneration !== leaseGeneration) throw new Error("Stale connector task lease");
    if (Date.parse(pending.task.leaseExpiresAt ?? "") <= Date.now()) throw new Error("Connector task lease expired");
    state.active.delete(taskId); if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
    if (input.error) pending.reject(new Error(bounded(input.error, 2_000))); else pending.resolve(this.boundResult(state, pending.task.operation, input.result));
  }

  disconnect(id: string, instanceId: string, generation: number): void {
    const state = this.assertConnection(id, instanceId, generation); delete state.instanceId; delete state.lastHeartbeatAt; this.rejectOutstanding(state, new Error("Connector disconnected"));
  }

  private validateOperation(state: ConnectorState, operation: ConnectorOperation): ConnectorOperation {
    if (operation.type === "exec") {
      if (!state.config.allowedPrograms.includes(operation.input.program)) throw new Error("Connector program is not operator-allowed");
      const maxOutputBytes = Math.min(operation.input.maxOutputBytes ?? state.config.maxOutputBytes, state.config.maxOutputBytes);
      return { type: "exec", input: { ...operation.input, args: operation.input.args.slice(0, 256).map((item) => bounded(item, 8_192)), ...(operation.input.stdin ? { stdin: bounded(operation.input.stdin, 256 * 1024) } : {}), maxOutputBytes } };
    }
    const path = safePath(operation.path);
    if (operation.type === "read_file") return { ...operation, path, maxBytes: Math.min(operation.maxBytes, state.config.maxOutputBytes) };
    if (operation.type === "write_file") { if (path.root !== "scratch") throw new Error("Connector writes are restricted to scratch"); if (Buffer.byteLength(operation.dataBase64, "base64") > operation.maxBytes) throw new Error("Connector write exceeds file budget"); return { ...operation, path }; }
    if (operation.type === "list_dir") return { ...operation, path, depth: Math.max(0, Math.min(operation.depth, 8)), maxEntries: Math.max(1, Math.min(operation.maxEntries, 1_000)) };
    return { ...operation, path };
  }

  private boundResult(state: ConnectorState, operation: ConnectorOperation, result: unknown): unknown {
    if (operation.type === "exec") {
      const value = (result ?? {}) as SandboxExecResult; const maximum = operation.input.maxOutputBytes ?? state.config.maxOutputBytes;
      const stdout = bounded(String(value.stdout ?? ""), maximum); const remaining = Math.max(0, maximum - Buffer.byteLength(stdout)); const stderr = bounded(String(value.stderr ?? ""), remaining);
      return { exitCode: value.exitCode ?? null, signal: value.signal ?? null, stdout, stderr, stdoutBase64: "", stderrBase64: "", truncated: Boolean(value.truncated) || stdout !== value.stdout || stderr !== value.stderr, timedOut: Boolean(value.timedOut), durationMs: Math.max(0, Number(value.durationMs) || 0) } satisfies SandboxExecResult;
    }
    if (operation.type === "read_file") { const value = (result ?? {}) as { path?: string; dataBase64?: string; offset?: number; totalBytes?: number; truncated?: boolean }; const bytes = Buffer.from(String(value.dataBase64 ?? ""), "base64").subarray(0, operation.maxBytes); return { path: bounded(String(value.path ?? operation.path.path), 1_000), bytes, offset: Number(value.offset) || 0, totalBytes: Number(value.totalBytes) || bytes.length, truncated: Boolean(value.truncated) || bytes.length >= operation.maxBytes } satisfies ExecutorReadResult; }
    if (operation.type === "list_dir") return ((Array.isArray(result) ? result : []) as ExecutorDirEntry[]).slice(0, operation.maxEntries).map((item) => ({ path: bounded(String(item.path), 1_000), kind: ["file", "directory", "other"].includes(item.kind) ? item.kind : "other" }));
    return result;
  }

  private online(state: ConnectorState): boolean { return Boolean(state.instanceId && state.lastHeartbeatAt && Date.now() - Date.parse(state.lastHeartbeatAt) <= state.config.heartbeatTimeoutMs); }
  private snapshotOf(state: ConnectorState): ConnectorSnapshot { return { id: state.config.id, status: this.online(state) ? "online" : "offline", generation: state.generation, ...(state.instanceId ? { instanceId: state.instanceId } : {}), capabilities: [...state.config.capabilities], allowedPrograms: [...state.config.allowedPrograms], networkAccess: state.config.networkAccess, ...(state.connectedAt ? { connectedAt: state.connectedAt } : {}), ...(state.lastHeartbeatAt ? { lastHeartbeatAt: state.lastHeartbeatAt } : {}), pendingTasks: state.queue.length + state.active.size }; }
  private required(id: string): ConnectorState { const state = this.connectors.get(id); if (!state) throw new Error("Connector is not operator-configured"); return state; }
  private assertConnection(id: string, instanceId: string, generation: number): ConnectorState { const state = this.required(id); if (state.instanceId !== instanceId || state.generation !== generation) throw new Error("Stale connector connection"); if (!this.online(state)) throw new Error("Connector is offline"); return state; }
  private requeueExpired(state: ConnectorState): void { for (const [id, pending] of state.active) if (Date.parse(pending.task.leaseExpiresAt ?? "") <= Date.now()) { state.active.delete(id); state.queue.unshift(pending); } }
  private rejectOutstanding(state: ConnectorState, error: Error): void { for (const pending of [...state.queue, ...state.active.values()]) { if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort); pending.reject(error); } state.queue = []; state.active.clear(); }
}

export class ConnectorExecutor implements Executor {
  readonly kind = "connector" as const;
  readonly networkAccess: boolean;
  constructor(readonly id: string, private readonly broker: ConnectorBroker) { const snapshot = broker.get(id); if (!snapshot) throw new Error("Connector is not operator-configured"); this.networkAccess = snapshot.networkAccess; }
  async exec(input: SandboxExecRequest, signal?: AbortSignal): Promise<ExecutorExecResult> { const startedAt = Date.now(); const result = await this.broker.dispatch(this.id, { type: "exec", input }, signal) as SandboxExecResult; return { ...result, startedAt, finishedAt: Date.now() }; }
  async readFile(path: ExecutorPath, options: { offset?: number; maxBytes: number }, signal?: AbortSignal): Promise<ExecutorReadResult> { return await this.broker.dispatch(this.id, { type: "read_file", path, offset: options.offset ?? 0, maxBytes: options.maxBytes }, signal) as ExecutorReadResult; }
  async readFileBytes(path: ExecutorPath, maxBytes: number, signal?: AbortSignal): Promise<ExecutorReadResult> { return await this.readFile(path, { maxBytes }, signal); }
  async writeFile(path: ExecutorPath, data: Uint8Array, options: { append?: boolean; maxBytes: number }, signal?: AbortSignal): Promise<void> { await this.broker.dispatch(this.id, { type: "write_file", path, dataBase64: Buffer.from(data).toString("base64"), append: options.append ?? false, maxBytes: options.maxBytes }, signal); }
  async listDir(path: ExecutorPath, options: { depth: number; maxEntries: number }, signal?: AbortSignal): Promise<ExecutorDirEntry[]> { return await this.broker.dispatch(this.id, { type: "list_dir", path, ...options }, signal) as ExecutorDirEntry[]; }
  async stat(path: ExecutorPath, signal?: AbortSignal): Promise<ExecutorFileStat> { return await this.broker.dispatch(this.id, { type: "stat", path }, signal) as ExecutorFileStat; }
  async health(): Promise<ExecutorHealth> { const snapshot = this.broker.get(this.id)!; return { status: snapshot.status, kind: "connector", networkAccess: snapshot.networkAccess, network: snapshot.networkAccess ? "operator-configured" : "none", capabilities: snapshot.capabilities, allowedPrograms: snapshot.allowedPrograms, missingPrograms: [], ...(snapshot.status === "offline" ? { detail: "Connector heartbeat is stale or disconnected" } : {}) }; }
  async dispose(): Promise<void> {}
}

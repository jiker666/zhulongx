import { randomUUID } from "node:crypto";
import type { RunOptions, XuanShuRuntime } from "./runtime.js";
import type { RunEvent, RunState, RunStatus, TaskRequest } from "./types.js";

export interface RunSnapshot {
  id: string;
  status: RunStatus;
  state?: RunState;
  error?: string;
  events: RunEvent[];
}

const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "blocked", "failed", "aborted"];

interface RunHandle extends RunSnapshot {
  controller: AbortController;
  promise: Promise<RunState>;
}

export interface RunManagerStats {
  total: number;
  active: number;
  queued: number;
  evicted: number;
}

export interface RunManagerOptions {
  /** Max simultaneously executing runs; excess starts stay "queued" in FIFO order. 0 = unlimited. */
  maxConcurrent?: number;
  /** Terminal run handles kept in memory (bounded for 10-hour sessions); older ones are evicted. */
  retainedRuns?: number;
}

function positiveEnvInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * In-memory run registry. Two one-shot-endurance properties:
 *  - a concurrency ceiling keeps a platform burst from exhausting the process
 *    (excess starts sit at "queued" and launch FIFO as slots free);
 *  - terminal handles are evicted past retainedRuns so a 10-hour session
 *    cannot grow the Map (and its 1000-event rings) without bound — the API
 *    falls back to persisted state for evicted ids.
 */
export class RunManager {
  private readonly runs = new Map<string, RunHandle>();
  private readonly maxConcurrent: number;
  private readonly retainedRuns: number;
  private active = 0;
  private evicted = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (error: unknown) => void; abort: AbortSignal }> = [];

  constructor(private readonly runtime: XuanShuRuntime, options: RunManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? positiveEnvInt("XUANSHU_MAX_CONCURRENT_RUNS") ?? 8;
    this.retainedRuns = options.retainedRuns ?? positiveEnvInt("XUANSHU_RETAINED_RUNS") ?? 40;
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.maxConcurrent <= 0 || this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, abort: signal };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason ?? new Error("Run aborted while queued"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const originalResolve = entry.resolve;
      entry.resolve = () => { signal.removeEventListener("abort", onAbort); originalResolve(); };
      this.waiting.push(entry);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.maxConcurrent > 0) {
      while (this.active < this.maxConcurrent) {
        const next = this.waiting.shift();
        if (!next) break;
        this.active += 1;
        next.resolve();
      }
    }
  }

  private evictTerminal(): void {
    if (this.runs.size <= this.retainedRuns) return;
    for (const [id, handle] of this.runs) {
      if (this.runs.size <= this.retainedRuns) break;
      if (TERMINAL_STATUSES.includes(handle.status)) {
        this.runs.delete(id);
        this.evicted += 1;
      }
    }
  }

  start(request: TaskRequest, options: Pick<RunOptions, "workspaceMode" | "sharedEvidence" | "allowedToolEffects" | "contextSections" | "lineage" | "writeup" | "discipline" | "thinkingLevel" | "modelRole"> = {}): string {
    const id = randomUUID();
    // Attachments belong to the isolated per-run input mount by default. An
    // operator can still explicitly request the configured workspace when a
    // task needs both a shared workspace and supplied files.
    const workspaceMode = options.workspaceMode ?? (request.attachments?.length ? "attachments-only" : undefined);
    const handle: RunHandle = {
      id,
      status: "queued",
      events: [],
      controller: new AbortController(),
      promise: Promise.resolve(undefined as never),
    };
    const events: RunEvent[] = handle.events;
    handle.promise = (async () => {
      await this.acquire(handle.controller.signal);
      handle.status = "running"; // launch confirmed; events may refine state later
      try {
        return await this.runtime.run(request, {
          id,
          ...(workspaceMode ? { workspaceMode } : {}),
          ...(options.sharedEvidence ? { sharedEvidence: options.sharedEvidence } : {}),
          ...(options.discipline ? { discipline: options.discipline } : {}),
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
          ...(options.modelRole ? { modelRole: options.modelRole } : {}),
          ...(options.allowedToolEffects ? { allowedToolEffects: options.allowedToolEffects } : {}),
          ...(options.contextSections ? { contextSections: options.contextSections } : {}),
          ...(options.lineage ? { lineage: options.lineage } : {}),
          writeup: options.writeup !== false,
          signal: handle.controller.signal,
          onEvent: (event) => {
            events.push(event);
            if (events.length > 1000) events.shift();
            if (event.type === "run.started") handle.status = "running";
          },
        });
      } finally {
        this.release();
        this.evictTerminal();
      }
    })()
      .then((state) => {
        handle.state = state;
        handle.status = state.status;
        return state;
      })
      .catch((error: unknown) => {
        handle.status = "failed";
        handle.error = error instanceof Error ? error.message : String(error);
        throw error;
      });
    void handle.promise.catch(() => undefined);
    this.runs.set(id, handle);
    return id;
  }

  get(id: string): RunSnapshot | undefined {
    const handle = this.runs.get(id);
    if (!handle) return undefined;
    return {
      id: handle.id,
      status: handle.status,
      ...(handle.state ? { state: handle.state } : {}),
      ...(handle.error ? { error: handle.error } : {}),
      events: [...handle.events],
    };
  }

  stop(id: string): boolean {
    const handle = this.runs.get(id);
    if (!handle || TERMINAL_STATUSES.includes(handle.status)) return false;
    handle.controller.abort(new Error("Run stopped by operator"));
    return true;
  }

  list(): RunSnapshot[] {
    return [...this.runs.keys()].map((id) => this.get(id)).filter((run): run is RunSnapshot => Boolean(run));
  }

  stats(): RunManagerStats {
    let active = 0;
    let queued = 0;
    for (const handle of this.runs.values()) {
      if (handle.status === "running") active += 1;
      else if (handle.status === "queued") queued += 1;
    }
    return { total: this.runs.size, active, queued, evicted: this.evicted };
  }

  async wait(id: string): Promise<RunState> {
    const handle = this.runs.get(id);
    if (!handle) throw new Error(`Unknown run: ${id}`);
    return await handle.promise;
  }
}

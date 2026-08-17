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

interface RunHandle extends RunSnapshot {
  controller: AbortController;
  promise: Promise<RunState>;
}

export class RunManager {
  private readonly runs = new Map<string, RunHandle>();

  constructor(private readonly runtime: XuanShuRuntime) {}

  start(request: TaskRequest, options: Pick<RunOptions, "workspaceMode" | "sharedEvidence" | "allowedToolEffects" | "contextSections" | "lineage"> = {}): string {
    const id = randomUUID();
    const handle: RunHandle = {
      id,
      status: "queued",
      events: [],
      controller: new AbortController(),
      promise: Promise.resolve(undefined as never),
    };
    handle.promise = this.runtime
      .run(request, {
        id,
        ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
        ...(options.sharedEvidence ? { sharedEvidence: options.sharedEvidence } : {}),
        ...(options.allowedToolEffects ? { allowedToolEffects: options.allowedToolEffects } : {}),
        ...(options.contextSections ? { contextSections: options.contextSections } : {}),
        ...(options.lineage ? { lineage: options.lineage } : {}),
        signal: handle.controller.signal,
        onEvent: (event) => {
          handle.events.push(event);
          if (handle.events.length > 1000) handle.events.shift();
          if (event.type === "run.started") handle.status = "running";
        },
      })
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
    if (!handle || ["completed", "blocked", "failed", "aborted"].includes(handle.status)) return false;
    handle.controller.abort(new Error("Run stopped by operator"));
    return true;
  }

  list(): RunSnapshot[] {
    return [...this.runs.keys()].map((id) => this.get(id)).filter((run): run is RunSnapshot => Boolean(run));
  }

  async wait(id: string): Promise<RunState> {
    const handle = this.runs.get(id);
    if (!handle) throw new Error(`Unknown run: ${id}`);
    return await handle.promise;
  }
}

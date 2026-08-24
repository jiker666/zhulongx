import { hostMatches, PolicyEngine } from "./policy.js";
import type { DascConfig, ScopeConfig } from "./types.js";

const API_PREFIX = "/slab-match/api/v1/agent";

export interface DascEnvelope<T> {
  code?: string;
  message?: string;
  data?: T;
}

export interface DascExerciseGroup {
  id?: number;
  name?: string;
  order?: number;
  corpus?: Array<{
    id?: number;
    name?: string;
    order?: number;
    isOpen?: boolean;
    hasSolved?: boolean;
  }>;
}

export interface DascEndpoint {
  exposeIps?: string[];
  ports?: string[];
  users?: Array<{ username?: string; password?: string }>;
  portMappings?: Array<{ type?: string; port?: string; proxy?: string }>;
  proxyIps?: string[];
  isProxy?: boolean;
  expireTime?: number;
}

export interface DascExercise {
  id?: number;
  name?: string;
  description?: string;
  hasSolved?: boolean;
  score?: string | number;
  difficulty?: string;
  attachment?: { files?: Array<{ name?: string; url?: string; ext?: string }> };
  endpoints?: DascEndpoint[];
  canRefreshEndpoint?: boolean;
  isNeedInit?: boolean;
  endpointType?: string;
  currentTime?: number;
  isNeedCheck?: boolean;
}

export interface DascAnswerResult {
  isCorrect?: boolean;
}

export interface DascAuditEvent {
  type: "dasc.request";
  method: "GET" | "POST";
  path: string;
  requestNumber: number;
  allowed: true;
}

export interface DascClientOptions {
  onAudit?: (event: DascAuditEvent) => void;
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return await reader.read();
  if (signal.aborted) throw signal.reason ?? new Error("DASC response read aborted");
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      const reason = signal.reason ?? new Error("DASC response read aborted");
      finish(() => reject(reason));
      void Promise.resolve().then(() => reader.cancel()).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await readResponseChunk(reader, signal);
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0 || value.length > remaining) {
      await reader.cancel();
      throw new Error(`DASC API response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function boundedAbortScope(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timeout: Promise<never>; dispose: () => void } {
  const controller = new AbortController();
  let rejectTimeout!: (reason: unknown) => void;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    rejectTimeout(reason);
  };
  const onParentAbort = () => abort(parent?.reason ?? new Error("DASC request aborted"));
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => abort(new Error(`DASC API request timed out after ${timeoutMs} ms`)), timeoutMs);
  return {
    signal: controller.signal,
    timeout: timeoutPromise,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function messageOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const envelope = value as DascEnvelope<unknown>;
  return typeof envelope.message === "string" ? envelope.message.slice(0, 500) : "";
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export class DascClient {
  private requestCount = 0;

  constructor(
    readonly config: DascConfig | undefined,
    readonly scope: ScopeConfig,
    readonly options: DascClientOptions = {},
  ) {}

  private accessKey(): string {
    const envName = this.config?.accessKeyEnv;
    if (!envName) throw new Error("DASC integration is not configured");
    const value = process.env[envName];
    if (!value) throw new Error(`Missing DASC AccessKey in environment variable ${envName}`);
    return value;
  }

  private url(path: string, query?: Record<string, string | number>): URL {
    if (!this.config) throw new Error("DASC integration is not configured");
    const target = new URL(path, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, String(value));
    return target;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    query?: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.config) throw new Error("DASC integration is not configured");
    const url = this.url(path, query);
    const decision = PolicyEngine.evaluateDascRequest(this.config, this.scope, method, url.toString(), this.requestCount);
    if (!decision.allowed) throw new Error(decision.reason);
    const accessKey = this.accessKey();
    const requestNumber = ++this.requestCount;
    this.options.onAudit?.({ type: "dasc.request", method, path: url.pathname, requestNumber, allowed: true });
    const abortScope = boundedAbortScope(signal, this.config.timeoutMs);
    try {
      const response = await Promise.race([
        fetch(url, {
          method,
          redirect: "manual",
          signal: abortScope.signal,
          headers: {
            accept: "application/json",
            "X-Agent-AccessKey": accessKey,
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        abortScope.timeout,
      ]);
      const text = await Promise.race([
        boundedResponseText(response, this.config.maxResponseBytes, abortScope.signal),
        abortScope.timeout,
      ]);
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`DASC API returned non-JSON response with HTTP ${response.status}`);
      }
      if (!response.ok) {
        const message = messageOf(parsed).split(accessKey).join("[REDACTED]");
        throw new Error(`DASC API HTTP ${response.status}${message ? `: ${message}` : ""}`);
      }
      const envelope = parsed && typeof parsed === "object" && "code" in parsed ? parsed as DascEnvelope<T> : undefined;
      if (envelope && envelope.code !== undefined && envelope.code !== "00000") {
        const message = messageOf(envelope).split(accessKey).join("[REDACTED]");
        throw new Error(`DASC API code ${envelope.code}${message ? `: ${message}` : ""}`);
      }
      return envelope ? envelope.data as T : parsed as T;
    } finally {
      abortScope.dispose();
    }
  }

  matchInfo(signal?: AbortSignal): Promise<{ note?: string; rule?: string }> {
    return this.request("GET", `${API_PREFIX}/match/notice/match-info`, undefined, undefined, signal);
  }

  overview(signal?: AbortSignal): Promise<{ stagePoint?: number; stageRank?: number }> {
    return this.request("GET", `${API_PREFIX}/answer-panel/overview`, undefined, undefined, signal);
  }

  exerciseList(signal?: AbortSignal): Promise<DascExerciseGroup[]> {
    return this.request("GET", `${API_PREFIX}/ctf/exercise-list`, undefined, undefined, signal);
  }

  exercise(exerciseId: number, signal?: AbortSignal): Promise<DascExercise> {
    requirePositiveInteger(exerciseId, "exerciseId");
    return this.request("GET", `${API_PREFIX}/ctf/exercise`, undefined, { exerciseId }, signal);
  }

  buildExerciseEnv(exerciseId: number, signal?: AbortSignal): Promise<unknown> {
    requirePositiveInteger(exerciseId, "exerciseId");
    return this.request("POST", `${API_PREFIX}/ctf/build-exercise-env`, { exerciseId }, undefined, signal);
  }

  recoverExerciseEnv(exerciseId: number, signal?: AbortSignal): Promise<unknown> {
    requirePositiveInteger(exerciseId, "exerciseId");
    return this.request("POST", `${API_PREFIX}/ctf/recover-exercise-env`, { exerciseId }, undefined, signal);
  }

  answer(exerciseId: number, flag: string, signal?: AbortSignal): Promise<DascAnswerResult> {
    requirePositiveInteger(exerciseId, "exerciseId");
    if (typeof flag !== "string" || flag.length === 0 || flag.length > 256) {
      throw new Error("flag must be between 1 and 256 characters");
    }
    return this.request("POST", `${API_PREFIX}/answer-panel/answer`, { exerciseId, flag }, undefined, signal);
  }

  noticeList(signal?: AbortSignal): Promise<unknown[]> {
    return this.request("GET", `${API_PREFIX}/match/notice/now-list`, undefined, undefined, signal);
  }

  notice(id: number, signal?: AbortSignal): Promise<unknown> {
    requirePositiveInteger(id, "notice id");
    return this.request("GET", `${API_PREFIX}/match/notice/detail`, undefined, { id }, signal);
  }
}

function endpointAuthorities(endpoint: DascEndpoint): string[] {
  const authorities: string[] = [];
  for (const ip of endpoint.proxyIps ?? []) {
    for (const mapping of endpoint.portMappings ?? []) {
      if (mapping.proxy) authorities.push(`${ip}:${mapping.proxy}`);
    }
    if (!(endpoint.portMappings ?? []).length) authorities.push(ip);
  }
  for (const ip of endpoint.exposeIps ?? []) {
    for (const port of endpoint.ports ?? []) authorities.push(`${ip}:${port}`);
    if (!(endpoint.ports ?? []).length) authorities.push(ip);
  }
  return authorities;
}

export function extractDascExerciseHosts(exercise: DascExercise): string[] {
  return [...new Set((exercise.endpoints ?? []).flatMap(endpointAuthorities))].slice(0, 64);
}

export function scopeForDascExercise(scope: ScopeConfig, exercise: DascExercise): Partial<ScopeConfig> | undefined {
  if (scope.mode !== "controlled") throw new Error("DASC exercise access requires scope.mode=controlled");
  const hosts = extractDascExerciseHosts(exercise);
  const unauthorized = hosts.filter((host) => !scope.allowedHosts.some((allowed) => hostMatches(host, allowed)));
  if (unauthorized.length > 0) {
    throw new Error(`DASC exercise hosts are outside configured scope.allowedHosts: ${unauthorized.join(", ")}`);
  }
  return hosts.length > 0 ? { mode: "controlled", allowedHosts: hosts } : undefined;
}

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditChain } from "./audit.js";
import { PolicyEngine } from "./policy.js";
import type { RunState, RuntimeConfig, ScopeConfig } from "./types.js";

const DEFAULT_ACCEPTS = ["application/json", "text/plain", "application/xml"] as const;
const TOKEN_PATTERN = /^[A-Za-z0-9]{8,}$/;
const MAX_IDS_FILE_BYTES = 1 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface ResourceExportOptions {
  endpoint: string;
  appId: string;
  authKey: string;
  modelRoutes: Record<string, string>;
  modelName: string;
  resourceIds: string[];
  scope: ScopeConfig;
  runtime: RuntimeConfig;
  audit: AuditChain;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  signal?: AbortSignal;
}

export interface ResourceExportSuccess {
  id: string;
  token: string;
}

export interface ResourceExportFailure {
  id: string;
  reason: string;
}

export interface ResourceExportReport {
  startedAt: string;
  finishedAt: string;
  total: number;
  successful: ResourceExportSuccess[];
  failed: ResourceExportFailure[];
  successRate: number;
  warning?: string;
}

interface ResourceResponse {
  status: number;
  body: string;
  contentType: string;
  truncated: boolean;
}

function createRunState(runtime: RuntimeConfig): RunState {
  const now = new Date().toISOString();
  return {
    id: `resource-export-${randomUUID()}`,
    status: "running",
    phase: "planning",
    task: { task: "Scoped resource export", attachments: [], metadata: { source: "resource-export" } },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "resource-export",
    scratchRoot: runtime.scratchRoot,
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
    plan: {
      goal: "Fetch one token for each resource ID",
      assumptions: ["The configured endpoint returns data.token"],
      hypotheses: ["Each resource can be fetched independently"],
      steps: [{ id: "export", objective: "Fetch and validate resource tokens", successCriteria: ["A token matches /^[A-Za-z0-9]{8,}$/"], tools: ["http_request"] }],
    },
  };
}

function endpointUrl(endpoint: string): URL {
  const value = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Endpoint must use HTTP or HTTPS");
  return url;
}

function validateResourceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("task_ids.json must contain an array of non-empty string IDs");
  }
  return value as string[];
}

export async function loadResourceIds(path: string, signal?: AbortSignal): Promise<string[]> {
  const info = await stat(path);
  if (signal?.aborted) throw abortError(signal);
  if (!info.isFile()) throw new Error("task_ids.json must be a regular file");
  if (info.size > MAX_IDS_FILE_BYTES) throw new Error(`task_ids.json exceeds ${MAX_IDS_FILE_BYTES} bytes`);
  const content = await readFile(path, { encoding: "utf8", signal });
  return validateResourceIds(JSON.parse(content));
}

async function readResponse(response: Response, maxBytes: number, signal?: AbortSignal): Promise<ResourceResponse> {
  if (!response.body) return { status: response.status, body: "", contentType: response.headers.get("content-type") ?? "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Export aborted");
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value.subarray(0, remaining));
      total += Math.min(value.length, remaining);
      if (value.length > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    status: response.status,
    body: new TextDecoder().decode(bytes),
    contentType: response.headers.get("content-type") ?? "",
    truncated,
  };
}

function extractToken(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const data = (parsed as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const token = (data as Record<string, unknown>).token;
  return typeof token === "string" && TOKEN_PATTERN.test(token) ? token : undefined;
}

function errorForResponse(result: ResourceResponse): string {
  if (result.truncated) return `response exceeded ${MAX_RESPONSE_BYTES} bytes`;
  if (result.status !== 200) return `HTTP ${result.status}`;
  return "response did not contain a valid data.token";
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Export aborted");
}

async function waitForInterval(lastStartedAt: number | undefined, minIntervalMs: number, signal?: AbortSignal): Promise<void> {
  if (lastStartedAt === undefined) return;
  const remaining = minIntervalMs - (Date.now() - lastStartedAt);
  if (remaining <= 0) return;
  await new Promise<void>((resolveWait, rejectWait) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectWait(abortError(signal));
    };
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    };
    timer = setTimeout(finish, remaining + 5);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function checkpoint(policy: PolicyEngine, state: RunState, audit: AuditChain): Promise<void> {
  const decision = policy.evaluate("checkpoint", {}, state);
  if (!decision.allowed) throw new Error(decision.reason);
  policy.recordAllowed("checkpoint", decision, state);
  await audit.append("resource.export.checkpoint", { actionsSinceCheckpoint: state.actionsSinceCheckpoint });
}

export async function exportResources(options: ResourceExportOptions): Promise<ResourceExportReport> {
  const startedAt = new Date().toISOString();
  const route = options.modelRoutes[options.modelName];
  if (!route) throw new Error(`No model route configured for ${options.modelName}`);
  const target = endpointUrl(options.endpoint);
  const policy = new PolicyEngine(options.scope, options.runtime);
  const state = createRunState(options.runtime);
  const fetcher = options.fetchImpl ?? fetch;
  const minIntervalMs = Math.max(500, options.minIntervalMs ?? 500);
  const successful: ResourceExportSuccess[] = [];
  const failed: ResourceExportFailure[] = [];
  let lastStartedAt: number | undefined;

  for (const id of options.resourceIds) {
    let lastError = "No valid token returned";
    let completed = false;
    for (let attempt = 0; attempt < DEFAULT_ACCEPTS.length; attempt += 1) {
      if (options.signal?.aborted) throw abortError(options.signal);
      const accept: string = DEFAULT_ACCEPTS[attempt] ?? "application/xml";
      const requestUrl = new URL(target.href);
      requestUrl.searchParams.set("resource_id", id);
      requestUrl.searchParams.set("model", route);
      const requestArgs = {
        method: "GET" as const,
        url: requestUrl.href,
        headers: { Accept: accept },
      };
      const decision = policy.evaluate("http_request", requestArgs, state);
      await options.audit.append("resource.export.policy", {
        id,
        attempt: attempt + 1,
        accept,
        allowed: decision.allowed,
        reason: decision.reason,
      });
      if (!decision.allowed) {
        lastError = decision.reason;
        break;
      }
      await waitForInterval(lastStartedAt, minIntervalMs, options.signal);
      policy.recordAllowed("http_request", decision, state);
      lastStartedAt = Date.now();
      const requestHeaders = {
        Accept: accept,
        "X-App-Id": options.appId,
        Authorization: `Bearer ${options.authKey}`,
      };
      await options.audit.append("resource.export.request", { id, attempt: attempt + 1, accept, url: requestUrl.href });
      try {
        const timeout = AbortSignal.timeout(options.runtime.httpTimeoutMs);
        const combined = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await fetcher(requestUrl.href, { method: "GET", headers: requestHeaders, redirect: "manual", signal: combined });
        const result = await readResponse(response, Math.min(options.runtime.maxOutputBytes, MAX_RESPONSE_BYTES), options.signal);
        const token = response.status === 200 && !result.truncated ? extractToken(result.body) : undefined;
        await options.audit.append("resource.export.result", { id, attempt: attempt + 1, status: result.status, validToken: Boolean(token), truncated: result.truncated });
        if (token) {
          successful.push({ id, token });
          completed = true;
          break;
        }
        lastError = errorForResponse(result);
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal);
        lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        await options.audit.append("resource.export.error", { id, attempt: attempt + 1, reason: lastError });
      }
      await checkpoint(policy, state, options.audit);
    }
    if (state.actionsSinceCheckpoint > 0) await checkpoint(policy, state, options.audit);
    if (!completed) failed.push({ id, reason: lastError });
  }

  const finishedAt = new Date().toISOString();
  const successRate = options.resourceIds.length === 0 ? 0 : successful.length / options.resourceIds.length;
  return {
    startedAt,
    finishedAt,
    total: options.resourceIds.length,
    successful,
    failed,
    successRate,
    ...(successRate < 0.8 ? { warning: "部分资源失败，请检查网络或联系管理员" } : {}),
  };
}

export async function writeResourceExportReport(path: string, report: ResourceExportReport): Promise<string> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return output;
}

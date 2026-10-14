import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { ProxyAgent } from "undici";
import { estimateAnthropicRequestTokens, ModelRequestGate, type ModelRequestReservation } from "./model-rate-limit.js";
import { modelContextSnapshot, type ModelContextView } from "./session-trajectory.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const HELLO_PATH = "/api/hello";
const RUN_PATH_PREFIX = "/run/";
const RUN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const FORWARDED_REQUEST_HEADERS = ["accept", "anthropic-version", "anthropic-beta"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "request-id", "retry-after"];

/**
 * Injected credentials and endpoint for one registered run route. Credentials
 * live only here and in outgoing upstream headers — never in audit records,
 * logs, or gateway error responses.
 */
export interface ModelGatewayUpstream {
  baseUrl: string;
  apiKey?: string;
  authScheme?: "bearer" | "api-key";
  headers?: Record<string, string>;
  /** Overrides the request body's model field, guarding against subprocess env leakage. */
  modelId?: string;
}

export interface ModelRouteLimits {
  minimumIntervalMs: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

/** Structural subset of AuditChain.append; keeps this module off the audit layer. */
export interface GatewayAuditSink {
  append(
    type: string,
    data: unknown,
    metadata?: { source?: string; actor?: string; correlationId?: string; parentSequence?: number },
  ): Promise<{ sequence: number }>;
}

export interface ModelRouteEvent {
  type: string;
  data: unknown;
}

export interface ModelRouteOptions {
  upstream: ModelGatewayUpstream;
  /** Zero values disable a limit; routes without limits are unlimited. */
  limits?: ModelRouteLimits;
  audit?: GatewayAuditSink;
  emit?: (event: ModelRouteEvent) => void | Promise<void>;
  /** Extra model.context fields per request (turn counter, model info, thinking level). */
  contextMeta?: () => Record<string, unknown>;
}

export type GatewayFetch = (input: string | URL, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

export interface ModelGatewayOptions {
  gate?: ModelRequestGate;
  fetch?: GatewayFetch;
  /** Rescue upstream (DPSK etc.): transparently takes over when the primary errors or is rate-limited. */
  fallbackUpstream?: ModelGatewayUpstream | undefined;
  /** Consecutive primary failures before requests skip the primary for cooldownMs. */
  failureThreshold?: number | undefined;
  /** How long a degraded primary is bypassed before the next request probes it again. */
  cooldownMs?: number | undefined;
}

interface ModelRouteState {
  runKey: string;
  options: ModelRouteOptions;
  requestCount: number;
  usage: UsageDetail;
  consecutiveFailures: number;
  fallbackUntil: number;
}

interface MatchedRoute {
  route: ModelRouteState;
  upstreamPath: string;
}

class RequestBodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function joinUrl(baseUrl: string, pathWithQuery: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`}`;
}

function pickHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function anthropicContextView(body: Record<string, unknown>): ModelContextView {
  const system = body.system;
  const systemPrompt = typeof system === "string"
    ? system
    : Array.isArray(system)
      ? system
        .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : ""))
        .join("\n")
      : undefined;
  const messages = Array.isArray(body.messages)
    ? body.messages.filter((message): message is { role: unknown; content: unknown } =>
        Boolean(message) && typeof message === "object" && "role" in message)
    : [];
  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((tool): tool is { name?: unknown; description?: unknown; input_schema?: unknown } =>
          Boolean(tool) && typeof tool === "object" && "name" in tool)
        .map((tool) => ({
          name: String(tool.name ?? ""),
          description: String(tool.description ?? ""),
          parameters: tool.input_schema,
        }))
    : undefined;
  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages: messages.map((message) => ({ role: String(message.role), content: message.content })),
    ...(tools ? { tools } : {}),
  };
}

/** Provider usage split, kept per field so runs can report cache economics
 * (Tsecbench-style accounting: the cache-read share dominates cheap-model runs). */
export interface UsageDetail {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface UsageSummary extends UsageDetail {
  requests: number;
}

function emptyUsage(): UsageDetail {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function addUsage(target: UsageDetail, source: UsageDetail): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
}

function extractJsonUsage(text: string): number | undefined {
  const detail = extractJsonUsageDetail(text);
  if (!detail) return undefined;
  const tokens = detail.inputTokens + detail.outputTokens + detail.cacheReadTokens + detail.cacheCreationTokens;
  return tokens > 0 ? tokens : undefined;
}

function extractJsonUsageDetail(text: string): UsageDetail | undefined {
  try {
    const body = JSON.parse(text) as { usage?: Record<string, unknown> };
    const usage = body.usage;
    if (!usage || typeof usage !== "object") return undefined;
    const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const detail = {
      inputTokens: readNumber(usage.input_tokens),
      outputTokens: readNumber(usage.output_tokens),
      cacheReadTokens: readNumber(usage.cache_read_input_tokens),
      cacheCreationTokens: readNumber(usage.cache_creation_input_tokens),
    };
    return (detail.inputTokens + detail.outputTokens + detail.cacheReadTokens + detail.cacheCreationTokens) > 0 ? detail : undefined;
  } catch {
    return undefined;
  }
}

/** Incremental SSE scan that pulls provider usage out of a pass-through stream. */
class SseUsageParser {
  private buffer = "";
  private detail = emptyUsage();

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  finish(): void {
    if (this.buffer) {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
  }

  totalTokens(): number | undefined {
    const total = this.detail.inputTokens + this.detail.outputTokens + this.detail.cacheReadTokens + this.detail.cacheCreationTokens;
    return total > 0 ? total : undefined;
  }

  usageDetail(): UsageDetail | undefined {
    return this.totalTokens() === undefined ? undefined : { ...this.detail };
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") return;
    let event: { type?: unknown; message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type === "message_start" && event.message?.usage) {
      const usage = event.message.usage;
      const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      this.detail.inputTokens = readNumber(usage.input_tokens);
      this.detail.cacheReadTokens = readNumber(usage.cache_read_input_tokens);
      this.detail.cacheCreationTokens = readNumber(usage.cache_creation_input_tokens);
    } else if (event.type === "message_delta" && event.usage) {
      const output = typeof event.usage.output_tokens === "number" ? event.usage.output_tokens : 0;
      this.detail.outputTokens = Math.max(this.detail.outputTokens, output);
    }
  }
}

async function readRequestBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limitBytes) throw new RequestBodyError(413, "Request body exceeds the gateway size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class ModelGateway {
  private readonly routes = new Map<string, ModelRouteState>();
  private readonly server: Server;
  private readonly gate: ModelRequestGate;
  private readonly fetcher: GatewayFetch;
  private readonly fallbackUpstream: ModelGatewayUpstream | undefined;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private port = 0;

  constructor(options: ModelGatewayOptions = {}) {
    this.gate = options.gate ?? new ModelRequestGate();
    this.fallbackUpstream = options.fallbackUpstream;
    this.failureThreshold = options.failureThreshold ?? (Number(process.env.XUANSHU_FAILOVER_THRESHOLD ?? "") || 3);
    this.cooldownMs = options.cooldownMs ?? (Number(process.env.XUANSHU_FAILOVER_COOLDOWN_MS ?? "") || 300_000);
    const customFetch = options.fetch;
    if (customFetch) {
      this.fetcher = customFetch;
    } else {
      const proxyUrl = process.env.XUANSHU_MODEL_PROXY?.trim();
      const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
      // Per-request hard timeout (29070 quota outage): an exhausted upstream
      // can accept the connection and never answer — the hung request then
      // sits for the SDK's own long deadline while the lane burns its budget
      // waiting. Timing out fast reclassifies as a network error, which the
      // SDK retries — so the moment quota returns, the next retry lands.
      const requestTimeoutMs = Number(process.env.XUANSHU_MODEL_TIMEOUT_MS ?? "") || 180_000;
      this.fetcher = (input, init) => {
        const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal as AbortSignal, timeoutSignal]) : timeoutSignal;
        return fetch(input, (dispatcher ? { ...init, dispatcher, signal } : { ...init, signal }) as RequestInit);
      };
    }
    this.server = createServer((request, response) => {
      response.on("error", () => {});
      void this.handle(request, response);
    });
    this.server.unref();
  }

  get requestGate(): ModelRequestGate {
    return this.gate;
  }

  async start(): Promise<string> {
    if (this.port > 0) return this.origin();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, LOOPBACK_HOST, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.port = address.port;
    return this.origin();
  }

  private origin(): string {
    if (this.port <= 0) throw new Error("Model gateway has not been started");
    return `http://${LOOPBACK_HOST}:${this.port}`;
  }

  routeUrl(runKey: string): string {
    return `${this.origin()}${RUN_PATH_PREFIX}${runKey}`;
  }

  setRoute(runKey: string, options: ModelRouteOptions): void {
    if (!RUN_KEY_PATTERN.test(runKey)) throw new Error("Run key must match [A-Za-z0-9][A-Za-z0-9:_-]*");
    let parsed: URL;
    try {
      parsed = new URL(options.upstream.baseUrl);
    } catch {
      throw new Error("Upstream baseUrl must be an absolute http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Upstream baseUrl must use http or https");
    }
    this.routes.set(runKey, { runKey, options, requestCount: 0, usage: emptyUsage(), consecutiveFailures: 0, fallbackUntil: 0 });
  }

  releaseRoute(runKey: string): void {
    this.routes.delete(runKey);
  }

  /** Accumulated provider usage for a live route; read before releaseRoute. */
  routeUsage(runKey: string): UsageSummary | undefined {
    const route = this.routes.get(runKey);
    if (!route || route.requestCount === 0) return undefined;
    return { ...route.usage, requests: route.requestCount };
  }

  async stop(): Promise<void> {
    this.routes.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (url.pathname === HELLO_PATH) {
        this.sendJson(response, 200, { status: "ok" }, request.method === "HEAD");
        return;
      }
      const matched = this.matchRoute(url);
      if (!matched) {
        this.sendJson(response, 404, { type: "error", error: { type: "not_found_error", message: "Unknown model route" } });
        return;
      }
      if (request.method !== "POST") {
        this.sendJson(response, 405, { type: "error", error: { type: "invalid_request_error", message: "Method not allowed" } });
        return;
      }
      await this.handleModelRequest(request, response, matched.route, matched.upstreamPath);
    } catch (error) {
      // Error bodies carry a bounded, sanitized message only — never headers or credentials.
      const message = error instanceof Error ? error.message.slice(0, 300) : "Model gateway request failed";
      this.sendJson(response, 502, { type: "error", error: { type: "api_error", message } });
    }
  }

  private matchRoute(url: URL): MatchedRoute | undefined {
    if (!url.pathname.startsWith(RUN_PATH_PREFIX)) return undefined;
    const afterPrefix = url.pathname.slice(RUN_PATH_PREFIX.length);
    const separator = afterPrefix.indexOf("/");
    const encodedKey = separator === -1 ? afterPrefix : afterPrefix.slice(0, separator);
    let runKey: string;
    try {
      runKey = decodeURIComponent(encodedKey);
    } catch {
      return undefined;
    }
    const route = this.routes.get(runKey);
    if (!route) return undefined;
    const upstreamPath = `${separator === -1 ? "/v1/messages" : afterPrefix.slice(separator)}${url.search}`;
    return { route, upstreamPath };
  }

  private async handleModelRequest(
    request: IncomingMessage,
    response: ServerResponse,
    route: ModelRouteState,
    upstreamPath: string,
  ): Promise<void> {
    const clientGone = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) clientGone.abort();
    });

    let body: Record<string, unknown>;
    try {
      const raw = await readRequestBody(request, MAX_REQUEST_BYTES);
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RequestBodyError(400, "Request body must be a JSON object");
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      const status = error instanceof RequestBodyError ? error.status : 400;
      const message = error instanceof SyntaxError
        ? "Request body must be valid JSON"
        : error instanceof RequestBodyError || error instanceof Error
          ? error.message
          : "Invalid request body";
      this.sendJson(response, status, { type: "error", error: { type: "invalid_request_error", message } });
      return;
    }
    if (route.options.upstream.modelId) body.model = route.options.upstream.modelId;

    route.requestCount += 1;
    const requestId = `${route.runKey}:request:${route.requestCount}`;
    const limits = route.options.limits ?? { minimumIntervalMs: 0, requestsPerMinute: 0, tokensPerMinute: 0 };
    let contextSequence: number | undefined;
    if (route.options.audit) {
      const contextRecord = await route.options.audit.append("model.context", {
        requestId,
        attempt: 1,
        ...route.options.contextMeta?.(),
        ...modelContextSnapshot(anthropicContextView(body)),
      }, { source: "context", actor: "primary-agent", correlationId: requestId });
      contextSequence = contextRecord.sequence;
    }

    let reservation: ModelRequestReservation;
    try {
      reservation = await this.gate.wait({
        ...limits,
        estimatedTokens: estimateAnthropicRequestTokens(body),
      }, clientGone.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Model request not admitted";
      this.sendJson(response, 429, { type: "error", error: { type: "rate_limit_error", message } });
      return;
    }
    if (route.options.audit) {
      await route.options.audit.append("model.request_reserved", {
        requestId,
        attempt: 1,
        estimatedTokens: reservation.estimatedTokens,
        waitedMs: reservation.waitedMs,
        requestsPerMinute: limits.requestsPerMinute,
        tokensPerMinute: limits.tokensPerMinute,
      }, {
        source: "orchestrator",
        actor: "model-request-gate",
        correlationId: requestId,
        ...(contextSequence !== undefined ? { parentSequence: contextSequence } : {}),
      });
    }
    if (reservation.waitedMs > 0) {
      await route.options.emit?.({
        type: "model.request_throttled",
        data: { estimatedTokens: reservation.estimatedTokens, waitedMs: reservation.waitedMs },
      });
    }

    const baseHeaders: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": pickHeader(request, "anthropic-version") ?? DEFAULT_ANTHROPIC_VERSION,
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = pickHeader(request, name);
      if (value) baseHeaders[name] = value;
    }
    const attemptUpstream = async (upstream: ModelGatewayUpstream): Promise<Response> => {
      const attemptHeaders: Record<string, string> = { ...baseHeaders };
      if (upstream.apiKey) {
        if ((upstream.authScheme ?? "bearer") === "bearer") attemptHeaders.authorization = `Bearer ${upstream.apiKey}`;
        else attemptHeaders["x-api-key"] = upstream.apiKey;
      }
      // Client-supplied credential headers are never forwarded; operator headers win.
      Object.assign(attemptHeaders, upstream.headers);
      const payload = upstream.modelId ? { ...body, model: upstream.modelId } : body;
      return await this.fetcher(joinUrl(upstream.baseUrl, upstreamPath), {
        method: "POST",
        headers: attemptHeaders,
        body: JSON.stringify(payload),
        signal: clientGone.signal,
      });
    };
    /**
     * One-shot endurance failover: a primary failure (network throw / 5xx /
     * 429) is transparently retried once on the rescue upstream BEFORE any
     * response byte is written, so the SDK never sees the outage; after
     * failureThreshold consecutive failures the route bypasses the primary
     * entirely for cooldownMs. 4xx is a config problem failover cannot fix
     * and passes through untouched.
     */
    const failoverActive = this.fallbackUpstream !== undefined && route.fallbackUntil > Date.now();
    const primaryChoice = failoverActive ? this.fallbackUpstream! : route.options.upstream;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await attemptUpstream(primaryChoice);
      const retriable = upstreamResponse.status >= 500 || upstreamResponse.status === 429;
      if (retriable) {
        if (!failoverActive) {
          route.consecutiveFailures += 1;
          if (route.consecutiveFailures >= this.failureThreshold) route.fallbackUntil = Date.now() + this.cooldownMs;
        }
        if (this.fallbackUpstream && primaryChoice === route.options.upstream) {
          await upstreamResponse.body?.cancel().catch(() => undefined);
          void route.options.emit?.({
            type: "model.failover",
            data: { reason: `HTTP ${upstreamResponse.status}`, consecutiveFailures: route.consecutiveFailures, fallbackUntil: route.fallbackUntil },
          });
          try {
            upstreamResponse = await attemptUpstream(this.fallbackUpstream);
          } catch {
            this.sendJson(response, 502, { type: "error", error: { type: "api_error", message: "Upstream model request failed (primary and fallback)" } });
            return;
          }
        }
      } else if (!failoverActive) {
        route.consecutiveFailures = 0;
      }
    } catch {
      if (!failoverActive && this.fallbackUpstream) {
        route.consecutiveFailures += 1;
        if (route.consecutiveFailures >= this.failureThreshold) route.fallbackUntil = Date.now() + this.cooldownMs;
        void route.options.emit?.({
          type: "model.failover",
          data: { reason: "network", consecutiveFailures: route.consecutiveFailures, fallbackUntil: route.fallbackUntil },
        });
        try {
          upstreamResponse = await attemptUpstream(this.fallbackUpstream);
        } catch {
          this.sendJson(response, 502, { type: "error", error: { type: "api_error", message: "Upstream model request failed (primary and fallback)" } });
          return;
        }
      } else {
        this.sendJson(response, 502, { type: "error", error: { type: "api_error", message: "Upstream model request failed" } });
        return;
      }
    }

    const responseHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    responseHeaders["content-type"] ??= "application/json";
    response.writeHead(upstreamResponse.status, responseHeaders);

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && upstreamResponse.body) {
      await this.pipeStream(upstreamResponse, response, reservation.entryId, route);
      return;
    }
    const text = await upstreamResponse.text();
    response.end(text);
    const usageDetail = extractJsonUsageDetail(text);
    if (usageDetail) {
      addUsage(route.usage, usageDetail);
      const usage = usageDetail.inputTokens + usageDetail.outputTokens + usageDetail.cacheReadTokens + usageDetail.cacheCreationTokens;
      this.gate.recordActualTokens(reservation.entryId, usage);
    }
  }

  private async pipeStream(upstream: Response, response: ServerResponse, entryId: string, route?: ModelRouteState): Promise<void> {
    const decoder = new TextDecoder();
    const usageParser = new SseUsageParser();
    const source = Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream);
    try {
      for await (const chunk of source) {
        if (response.destroyed || response.writableEnded) break;
        usageParser.push(decoder.decode(chunk as Uint8Array, { stream: true }));
        if (!response.write(chunk)) {
          await Promise.race([once(response, "drain"), once(response, "close")]);
        }
      }
      usageParser.push(decoder.decode());
      usageParser.finish();
    } finally {
      response.end();
    }
    const usageDetail = usageParser.usageDetail();
    if (usageDetail) {
      if (route) addUsage(route.usage, usageDetail);
      const usage = usageDetail.inputTokens + usageDetail.outputTokens + usageDetail.cacheReadTokens + usageDetail.cacheCreationTokens;
      this.gate.recordActualTokens(entryId, usage);
    }
  }

  private sendJson(response: ServerResponse, status: number, value: unknown, emptyBody = false): void {
    if (response.headersSent || response.writableEnded || response.destroyed) {
      response.end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(emptyBody ? undefined : JSON.stringify(value));
  }
}

/**
 * Process-wide gateway: one loopback listener and one shared request gate per
 * API process. Routes are registered per run (and per writeup attempt).
 */
/**
 * Build the rescue upstream from the optional model.fallback config; returns
 * undefined when the config or its API key is absent (single-model deploy).
 */
export function fallbackUpstreamFromConfig(model: { baseUrl: string; id: string; apiKeyEnv: string; authScheme?: "bearer" | "api-key" } | undefined): ModelGatewayUpstream | undefined {
  if (!model) return undefined;
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) return undefined;
  return {
    baseUrl: model.baseUrl,
    apiKey,
    ...(model.authScheme ? { authScheme: model.authScheme } : {}),
    modelId: model.id,
  };
}

export async function startModelGateway(options?: ModelGatewayOptions): Promise<ModelGateway> {
  const gateway = new ModelGateway(options ?? {});
  await gateway.start();
  return gateway;
}

/**
 * One-shot raw completion through a gateway route for non-agent callers (the
 * challenge classifier etc.): direct loopback POST, no subprocess, so a dead
 * or unavailable upstream fails in milliseconds instead of stalling intake.
 * Callers own retry and audit policy.
 */
export async function gatewayTextQuery(
  gateway: ModelGateway,
  runKey: string,
  modelId: string,
  system: string,
  prompt: string,
  signal?: AbortSignal | undefined,
  maxTokens = 300,
): Promise<string> {
  const response = await fetch(gateway.routeUrl(runKey), {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: modelId, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`model query failed with status ${response.status}`);
  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const text = (payload.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  if (!text) throw new Error("model query response contained no text");
  return text;
}

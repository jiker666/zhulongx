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
  /**
   * R25 key pool: opt this route into the gateway's same-model key pool
   * (multi-account quota rotation). Default off — session-model and rescue
   * routes keep their own single credentials.
   */
  useKeyPool?: boolean;
}

export type GatewayFetch = (input: string | URL, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

export interface ModelGatewayOptions {
  gate?: ModelRequestGate;
  fetch?: GatewayFetch;
  /** Rescue upstream (DPSK etc.): transparently takes over when the primary errors or is rate-limited. */
  fallbackUpstream?: ModelGatewayUpstream | undefined;
  /**
   * R25 same-model key pool (multi-account quota rotation, competition 10h
   * finals): every entry shares the primary endpoint with its own API key.
   * Requests round-robin across healthy keys and rotate on 429/5xx/network
   * failures inside the same request — before the rescue upstream (self-funded
   * DPSK) is ever touched. Auth failures (401/403) disable that key only.
   * Undefined/empty = pre-R25 single-key behaviour.
   */
  keyPool?: ModelGatewayUpstream[] | undefined;
  /** Consecutive primary failures before requests skip the primary for cooldownMs. */
  failureThreshold?: number | undefined;
  /** How long a degraded primary is bypassed before the next request probes it again. */
  cooldownMs?: number | undefined;
}

/** One rotating account in the R25 key pool: the upstream plus its own health. */
interface PoolKeyState {
  upstream: ModelGatewayUpstream;
  consecutiveFailures: number;
  cooldownUntil: number;
  disabled: boolean;
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

function forwardedResponseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
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
  private readonly pool: PoolKeyState[] = [];
  private poolCursor = 0;
  private port = 0;

  constructor(options: ModelGatewayOptions = {}) {
    this.gate = options.gate ?? new ModelRequestGate();
    this.fallbackUpstream = options.fallbackUpstream;
    this.pool = (options.keyPool ?? [])
      .filter((upstream) => upstream.apiKey)
      .map((upstream) => ({ upstream, consecutiveFailures: 0, cooldownUntil: 0, disabled: false }));
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
     * One-shot endurance failover + R25 key pool. Primary candidates: a
     * pool-opted route draws them from a gateway-wide round-robin over
     * same-model keys — a 429/5xx/network failure on one account rotates to
     * the next account inside the SAME request, before the rescue upstream
     * (self-funded DPSK) is ever touched; auth failures (401/403) disable
     * that key only. When every candidate fails retriably, the request takes
     * one rung up the R19 ladder: route failure counter, then cooldown
     * bypass, then one transparent rescue attempt. Without a pool the ladder
     * is the pre-R25 single-candidate one. Non-retriable 4xx is a config
     * problem failover cannot fix and passes through untouched.
     */
    const failoverActive = this.fallbackUpstream !== undefined && route.fallbackUntil > Date.now();
    const poolActive = this.pool.length > 0 && route.options.useKeyPool === true && !failoverActive;
    const candidates: ModelGatewayUpstream[] = failoverActive
      ? [this.fallbackUpstream!]
      : poolActive
        ? this.poolCandidates()
        : [route.options.upstream];
    let upstreamResponse: Response | undefined;
    let lastPrimaryError: { status: number; text: string; headers: Record<string, string> } | undefined;
    let primaryFailed = false;
    for (const candidate of candidates) {
      let attempted: Response;
      try {
        attempted = await attemptUpstream(candidate);
      } catch {
        primaryFailed = true;
        if (poolActive) this.notePoolFailure(candidate, "network");
        continue;
      }
      const credentialFailure = poolActive && (attempted.status === 401 || attempted.status === 403);
      // R38: >=400 (not just >=500/429) rotates keys and counts toward DPSK
      // failover — providers wrap quota/balance exhaustion in 400-class
      // bodies (zhipu 1113/1302), and passing those through stalled every
      // run instead of letting the unmetered fallback carry the load.
      if (attempted.status >= 400 || credentialFailure) {
        primaryFailed = true;
        lastPrimaryError = { status: attempted.status, text: await attempted.text(), headers: forwardedResponseHeaders(attempted) };
        if (poolActive) this.notePoolFailure(candidate, `HTTP ${attempted.status}`);
        continue;
      }
      upstreamResponse = attempted;
      if (!failoverActive) {
        route.consecutiveFailures = 0;
        if (poolActive) this.notePoolSuccess(candidate);
      }
      break;
    }
    if (!upstreamResponse) {
      if (!failoverActive && primaryFailed) {
        route.consecutiveFailures += 1;
        if (route.consecutiveFailures >= this.failureThreshold) route.fallbackUntil = Date.now() + this.cooldownMs;
        void route.options.emit?.({
          type: "model.failover",
          data: {
            reason: poolActive ? "pool exhausted" : lastPrimaryError ? `HTTP ${lastPrimaryError.status}` : "network",
            ...(poolActive ? { poolSize: this.pool.length } : {}),
            consecutiveFailures: route.consecutiveFailures,
            fallbackUntil: route.fallbackUntil,
          },
        });
      }
      if (this.fallbackUpstream && !failoverActive) {
        try {
          upstreamResponse = await attemptUpstream(this.fallbackUpstream);
        } catch {
          this.sendJson(response, 502, { type: "error", error: { type: "api_error", message: "Upstream model request failed (primary and fallback)" } });
          return;
        }
      } else if (lastPrimaryError) {
        // No rescue upstream (or the request already ran on it): surface the
        // upstream's own error untouched so the SDK retry ladder can react.
        response.writeHead(lastPrimaryError.status, { "content-type": "application/json", ...lastPrimaryError.headers });
        response.end(lastPrimaryError.text);
        return;
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

  /**
   * R25 pool pick order: active keys round-robin (healthy first), then
   * cooling keys sorted by soonest expiry as a last resort — when every key
   * is cooling, probing the soonest one still prefers a refilled free-tier
   * window over spending rescue quota.
   */
  private poolCandidates(): ModelGatewayUpstream[] {
    const now = Date.now();
    const active = this.pool.filter((entry) => !entry.disabled);
    if (active.length === 0) return [];
    this.poolCursor = (this.poolCursor + 1) % active.length;
    const ordered = active.map((_, index) => active[(this.poolCursor + index) % active.length]!);
    const healthy = ordered.filter((entry) => entry.cooldownUntil <= now);
    const cooling = ordered.filter((entry) => entry.cooldownUntil > now).sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return [...healthy, ...cooling].map((entry) => entry.upstream);
  }

  private notePoolFailure(candidate: ModelGatewayUpstream, reason: string): void {
    const state = this.pool.find((entry) => entry.upstream === candidate);
    if (!state) return;
    if (reason === "HTTP 401" || reason === "HTTP 403") {
      if (!state.disabled) {
        state.disabled = true;
        // Slot index only — key material never reaches logs or audit records.
        console.warn(`[model-gateway] key-pool slot ${this.pool.indexOf(state)} disabled (${reason}) and excluded from rotation`);
      }
      return;
    }
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.failureThreshold) state.cooldownUntil = Date.now() + this.cooldownMs;
  }

  private notePoolSuccess(candidate: ModelGatewayUpstream): void {
    const state = this.pool.find((entry) => entry.upstream === candidate);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
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

/**
 * R25 multi-account key pool from model.apiKeyPoolEnv: a comma-separated list
 * of same-plan API keys (10h finals: two GLM coding-plan accounts whose 5h
 * windows cannot cover the run alone). Each key becomes a pool upstream on
 * the primary endpoint; the gateway drains the windows in parallel
 * (round-robin) and rotates on quota exhaustion before the self-funded
 * rescue model is ever touched. Undefined/empty pool env → undefined →
 * single-key behaviour.
 */
export function keyPoolUpstreamsFromConfig(
  model: { baseUrl: string; id: string; apiKeyPoolEnv?: string; authScheme?: "bearer" | "api-key" } | undefined,
): ModelGatewayUpstream[] | undefined {
  if (!model?.apiKeyPoolEnv) return undefined;
  const raw = process.env[model.apiKeyPoolEnv] ?? "";
  const keys = [...new Set(raw.split(",").map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return undefined;
  return keys.map((apiKey) => ({
    baseUrl: model.baseUrl,
    apiKey,
    ...(model.authScheme ? { authScheme: model.authScheme } : {}),
    modelId: model.id,
  }));
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

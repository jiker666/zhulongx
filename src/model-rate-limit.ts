const RATE_WINDOW_MS = 60_000;
const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_TOKENS = 1_200;
const DEFAULT_OUTPUT_TOKEN_BUDGET = 4_096;

export interface ModelRequestLimits {
  minimumIntervalMs: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  estimatedTokens: number;
}

export interface ModelRequestReservation {
  entryId: string;
  estimatedTokens: number;
  startedAt: number;
  waitedMs: number;
}

interface ModelRequestGateOptions {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface ModelRequestEntry {
  id: string;
  startedAt: number;
  tokens: number;
}

// Structural subsets of the legacy agent-loop message shapes still consumed by
// runtime.ts. They carry no framework dependency and disappear with the legacy
// loop; the gateway estimates from raw request bodies instead.
export interface EstimateModel {
  maxTokens?: number;
}

export interface EstimateUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface EstimateContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  data?: unknown;
  name?: string;
  arguments?: unknown;
}

export interface EstimateMessage {
  role: string;
  content: string | EstimateContentBlock[];
  usage?: EstimateUsage;
  timestamp?: number;
  stopReason?: string;
}

export interface EstimateContext {
  systemPrompt?: string;
  messages: EstimateMessage[];
  tools?: unknown[];
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function estimateContentTokens(content: EstimateMessage["content"]): number {
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  let tokens = 0;
  for (const block of content) {
    if (block?.type === "text") tokens += Math.ceil(String(block.text ?? "").length / CHARS_PER_TOKEN);
    else if (block?.type === "image") tokens += ESTIMATED_IMAGE_TOKENS;
    else if (block?.type === "thinking") tokens += Math.ceil(String(block.thinking ?? "").length / CHARS_PER_TOKEN);
    else tokens += Math.ceil((String(block?.name ?? "").length + safeJsonStringify(block?.arguments).length) / CHARS_PER_TOKEN);
  }
  return tokens;
}

function reportedContextTokens(usage: EstimateUsage): number {
  return usage.totalTokens
    || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function estimateContextInputTokens(context: EstimateContext): number {
  let lastUsageIndex = -1;
  let lastUsageTokens = 0;
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;

  for (const [index, message] of context.messages.entries()) {
    if (message.role === "assistant") {
      const tokens = message.usage ? reportedContextTokens(message.usage) : 0;
      if (
        typeof message.timestamp === "number"
        && message.timestamp >= latestPrefixTimestamp
        && tokens > 0
        && !["aborted", "error"].includes(String(message.stopReason ?? ""))
      ) {
        lastUsageIndex = index;
        lastUsageTokens = tokens;
      }
    }
    if (typeof message.timestamp === "number") latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  }

  if (lastUsageIndex >= 0) {
    return lastUsageTokens + context.messages
      .slice(lastUsageIndex + 1)
      .reduce((total, message) => total + estimateContentTokens(message.content), 0);
  }

  const messageTokens = context.messages.reduce(
    (total, message) => total + estimateContentTokens(message.content),
    0,
  );
  const systemTokens = Math.ceil((context.systemPrompt?.length ?? 0) / CHARS_PER_TOKEN);
  const toolTokens = Math.ceil(safeJsonStringify(context.tools ?? []).length / CHARS_PER_TOKEN);
  return messageTokens + systemTokens + toolTokens;
}

export function estimateModelRequestTokens(
  model: EstimateModel,
  context: EstimateContext,
  options?: { maxTokens?: number },
): number {
  const inputTokens = estimateContextInputTokens(context);
  const outputBudget = options?.maxTokens ?? model.maxTokens ?? DEFAULT_OUTPUT_TOKEN_BUDGET;
  return Math.max(1, Math.ceil(Math.max(inputTokens, outputBudget)));
}

/**
 * Estimate the token footprint of a raw Anthropic Messages API request body.
 * This is the gateway admission estimate: serialized characters / 4 plus a
 * fixed allowance per image, floored by the requested output budget, matching
 * the legacy estimator's admission policy. Actual usage from the response
 * true-ups the rolling window via ModelRequestGate.recordActualTokens.
 */
export function estimateAnthropicRequestTokens(request: unknown, fallbackOutputTokens = DEFAULT_OUTPUT_TOKEN_BUDGET): number {
  if (!request || typeof request !== "object") return fallbackOutputTokens;
  const body = request as Record<string, unknown>;
  let chars = 0;
  let images = 0;
  const addText = (value: unknown): void => {
    if (typeof value === "string") chars += value.length;
  };
  const walkContent = (content: unknown): void => {
    if (typeof content === "string") {
      addText(content);
      return;
    }
    if (!Array.isArray(content)) {
      chars += safeJsonStringify(content).length;
      return;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const part = block as Record<string, unknown>;
      if (part.type === "text") addText(part.text);
      else if (part.type === "thinking") addText(part.thinking);
      else if (part.type === "image") images += 1;
      else if (part.type === "tool_use") chars += String(part.name ?? "").length + safeJsonStringify(part.input).length;
      else if (part.type === "tool_result") walkContent(part.content);
      else chars += safeJsonStringify(part).length;
    }
  };
  if (typeof body.system === "string") addText(body.system);
  else if (Array.isArray(body.system)) walkContent(body.system);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && typeof message === "object") walkContent((message as Record<string, unknown>).content);
    }
  }
  if (Array.isArray(body.tools)) chars += safeJsonStringify(body.tools).length;
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN) + images * ESTIMATED_IMAGE_TOKENS;
  const outputBudget = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens) && body.max_tokens > 0
    ? body.max_tokens
    : fallbackOutputTokens;
  return Math.max(1, Math.ceil(Math.max(inputTokens, outputBudget)));
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw signal.reason ?? new Error("Model request aborted");
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(signal?.reason ?? new Error("Model request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  if (signal.aborted) throw signal.reason ?? new Error("Model request aborted");
  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => rejectWait(signal.reason ?? new Error("Model request aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => finish(resolveWait), (error: unknown) => finish(() => rejectWait(error)));
  });
}

export class ModelRequestGate {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly requests: ModelRequestEntry[] = [];
  private entryCounter = 0;
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(options: ModelRequestGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async wait(limits: ModelRequestLimits, signal?: AbortSignal): Promise<ModelRequestReservation> {
    const queuedAt = this.now();
    const estimatedTokens = Math.max(1, Math.ceil(limits.estimatedTokens));
    if (limits.tokensPerMinute > 0 && estimatedTokens > limits.tokensPerMinute) {
      throw new Error(
        `Estimated model request (${estimatedTokens} tokens) exceeds configured modelTokensPerMinute (${limits.tokensPerMinute})`,
      );
    }

    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });

    try {
      await waitForPrevious(previous, signal);
      while (true) {
        const now = this.now();
        this.prune(now);
        const waitMs = Math.max(
          this.intervalWaitMs(now, limits.minimumIntervalMs),
          this.requestBudgetWaitMs(now, limits.requestsPerMinute),
          this.tokenBudgetWaitMs(now, limits.tokensPerMinute, estimatedTokens),
        );
        if (waitMs <= 0) {
          this.lastStartedAt = now;
          const entryId = `model-request-${this.requests.length + 1}-${++this.entryCounter}`;
          this.requests.push({ id: entryId, startedAt: now, tokens: estimatedTokens });
          return { entryId, estimatedTokens, startedAt: now, waitedMs: Math.max(0, now - queuedAt) };
        }
        await this.sleep(Math.max(1, Math.ceil(waitMs)), signal);
      }
    } finally {
      release();
    }
  }

  /**
   * Replace a reservation's estimate with the usage the provider actually
   * reported, keeping the rolling token window honest. Late true-ups for
   * entries that already fell out of the window are no-ops.
   */
  recordActualTokens(entryId: string, actualTokens: number): void {
    if (!Number.isFinite(actualTokens) || actualTokens <= 0) return;
    const entry = this.requests.find((request) => request.id === entryId);
    if (entry) entry.tokens = Math.ceil(actualTokens);
  }

  private prune(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;
    while (this.requests[0] && this.requests[0].startedAt <= cutoff) this.requests.shift();
  }

  private intervalWaitMs(now: number, minimumIntervalMs: number): number {
    return Math.max(0, minimumIntervalMs - (now - this.lastStartedAt));
  }

  private requestBudgetWaitMs(now: number, requestsPerMinute: number): number {
    if (requestsPerMinute <= 0 || this.requests.length < requestsPerMinute) return 0;
    const expirationIndex = this.requests.length - Math.floor(requestsPerMinute);
    const limitingRequest = this.requests[expirationIndex];
    return limitingRequest ? Math.max(0, limitingRequest.startedAt + RATE_WINDOW_MS - now) : 0;
  }

  private tokenBudgetWaitMs(now: number, tokensPerMinute: number, estimatedTokens: number): number {
    if (tokensPerMinute <= 0) return 0;
    let remainingTokens = this.requests.reduce((total, request) => total + request.tokens, 0);
    if (remainingTokens + estimatedTokens <= tokensPerMinute) return 0;
    for (const request of this.requests) {
      remainingTokens -= request.tokens;
      if (remainingTokens + estimatedTokens <= tokensPerMinute) {
        return Math.max(0, request.startedAt + RATE_WINDOW_MS - now);
      }
    }
    return RATE_WINDOW_MS;
  }
}

import type { Context, Message, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";

const RATE_WINDOW_MS = 60_000;
const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_TOKENS = 1_200;

export interface ModelRequestLimits {
  minimumIntervalMs: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  estimatedTokens: number;
}

export interface ModelRequestReservation {
  estimatedTokens: number;
  startedAt: number;
  waitedMs: number;
}

interface ModelRequestGateOptions {
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface ModelRequestEntry {
  startedAt: number;
  tokens: number;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function estimateContentTokens(content: Message["content"]): number {
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  let tokens = 0;
  for (const block of content) {
    if (block.type === "text") tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN);
    else if (block.type === "image") tokens += ESTIMATED_IMAGE_TOKENS;
    else if (block.type === "thinking") tokens += Math.ceil(block.thinking.length / CHARS_PER_TOKEN);
    else tokens += Math.ceil((block.name.length + safeJsonStringify(block.arguments).length) / CHARS_PER_TOKEN);
  }
  return tokens;
}

function reportedContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function estimateContextInputTokens(context: Context): number {
  let lastUsageIndex = -1;
  let lastUsageTokens = 0;
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;

  for (const [index, message] of context.messages.entries()) {
    if (message.role === "assistant") {
      const tokens = reportedContextTokens(message.usage);
      if (message.timestamp >= latestPrefixTimestamp && tokens > 0 && !["aborted", "error"].includes(message.stopReason)) {
        lastUsageIndex = index;
        lastUsageTokens = tokens;
      }
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
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
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
): number {
  const inputTokens = estimateContextInputTokens(context);
  const outputBudget = options?.maxTokens ?? model.maxTokens;
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
          this.requests.push({ startedAt: now, tokens: estimatedTokens });
          return { estimatedTokens, startedAt: now, waitedMs: Math.max(0, now - queuedAt) };
        }
        await this.sleep(Math.max(1, Math.ceil(waitMs)), signal);
      }
    } finally {
      release();
    }
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

import { hostMatches, PolicyEngine } from "./policy.js";
import type { AppConfig, ArenaConfig, RunState, ScopeConfig, TaskRequest } from "./types.js";

export interface ArenaAgent {
  id?: number;
  name?: string;
  model_provider?: string;
  model_name?: string;
  rating?: number;
  attempt_count?: number;
  solved_count?: number;
  failed_count?: number;
  wrong_count?: number;
  success_rate?: number;
}

export interface ArenaProblem {
  type?: number;
  type_label?: string;
  content?: string;
  hint?: string | null;
  flag_type?: number;
  container_enabled?: boolean;
  container?: {
    url?: string[];
    remaining_seconds?: number;
  } | null;
  rating?: number;
  annex?: unknown;
}

export interface ArenaAttempt {
  id: number;
  state_label?: string;
  wrong_count?: number;
  max_wrong_count?: number;
  remaining_seconds?: number;
  rating_delta?: number;
  agent_rating_after?: number;
  problem_rating_after?: number;
  problem?: ArenaProblem;
}

export interface ArenaNextData {
  reused?: boolean;
  agent?: ArenaAgent;
  attempt?: ArenaAttempt;
}

export interface ArenaSubmitData extends ArenaNextData {
  correct?: boolean;
}

export interface ArenaAnnexDescriptor {
  name: string;
  url: string;
  size?: number;
}

export interface ArenaEnvelope<T> {
  code?: number;
  data?: T;
  message?: string;
  msg?: string;
  error?: unknown;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function envelopeMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const envelope = value as ArenaEnvelope<unknown>;
  if (envelope.message ?? envelope.msg ?? envelope.error) return String(envelope.message ?? envelope.msg ?? envelope.error);
  if (envelope.data && typeof envelope.data === "object") {
    const data = envelope.data as Record<string, unknown>;
    return String(data.message ?? data.msg ?? data.reason ?? "");
  }
  return "";
}

function requireAttempt(value: ArenaNextData, label: string): ArenaAttempt {
  if (!value.attempt?.id) throw new Error(`${label} response did not include an active attempt`);
  return value.attempt;
}

function cleanFlagCandidate(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function compactJson(value: unknown, maxLength = 8192): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated]` : text;
}

async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Arena request aborted");
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Arena request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ArenaClient {
  constructor(readonly config: ArenaConfig | undefined) {}

  private token(): string {
    const tokenEnv = this.config?.tokenEnv;
    const token = tokenEnv ? process.env[tokenEnv] : undefined;
    if (!tokenEnv) throw new Error("Arena integration is not configured");
    if (!token) throw new Error(`Missing NSSCTF Arena token in environment variable ${tokenEnv}`);
    return token;
  }

  private url(path: string): string {
    if (!this.config) throw new Error("Arena integration is not configured");
    return new URL(path, `${this.config.baseUrl}/`).toString();
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.config) throw new Error("Arena integration is not configured");
    const url = this.url(path);
    const decision = PolicyEngine.evaluateArenaRequest(this.config, method, url);
    if (!decision.allowed) throw new Error(decision.reason);
    for (let retry = 0; ; retry += 1) {
      const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(url, {
        method,
        redirect: "manual",
        signal: combined,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token()}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const { text, truncated } = await boundedResponseText(response, this.config.maxResponseBytes);
      if (truncated) throw new Error(`Arena API response exceeded ${this.config.maxResponseBytes} bytes`);
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Arena API returned non-JSON response with HTTP ${response.status}`);
      }
      const envelope = parsed && typeof parsed === "object" && "code" in parsed ? (parsed as ArenaEnvelope<T>) : undefined;
      const rateLimited = response.status === 429 || envelope?.code === 429;
      if (rateLimited && retry < 5) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const data = envelope?.data && typeof envelope.data === "object" ? (envelope.data as Record<string, unknown>) : {};
        const bodyRetryAfter = Number(data.retry_after_seconds ?? data.retryAfterSeconds);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Number.isFinite(bodyRetryAfter) && bodyRetryAfter > 0
            ? bodyRetryAfter * 1000 + 1000
            : Math.min(10000 * 2 ** retry, 60000);
        await retryDelay(waitMs, signal);
        continue;
      }
      if (!response.ok) {
        const message = envelopeMessage(parsed);
        throw new Error(`Arena API HTTP ${response.status}${message ? `: ${message}` : ""}`);
      }
      if (envelope) {
        if (envelope.code !== undefined && envelope.code !== 200) {
          const message = envelopeMessage(envelope);
          throw new Error(`Arena API code ${envelope.code}${message ? `: ${message}` : ""}`);
        }
        return envelope.data as T;
      }
      return parsed as T;
    }
  }

  async current(signal?: AbortSignal): Promise<ArenaNextData> {
    return await this.request<ArenaNextData>("GET", "/api/skill/agent/arena/current/", undefined, signal);
  }

  async next(signal?: AbortSignal): Promise<ArenaNextData> {
    return await this.request<ArenaNextData>("POST", "/api/skill/agent/arena/next/", undefined, signal);
  }

  async attempt(id: number, signal?: AbortSignal): Promise<ArenaNextData> {
    return await this.request<ArenaNextData>("GET", `/api/skill/agent/arena/attempt/${id}/`, undefined, signal);
  }

  async submit(id: number, flag: string, signal?: AbortSignal): Promise<ArenaSubmitData> {
    return await this.request<ArenaSubmitData>("POST", `/api/skill/agent/arena/attempt/${id}/submit/`, { flag }, signal);
  }

  async abandon(id: number, signal?: AbortSignal): Promise<ArenaNextData> {
    return await this.request<ArenaNextData>("POST", `/api/skill/agent/arena/attempt/${id}/abandon/`, undefined, signal);
  }

  async downloadAnnex(
    annexUrl: string,
    scope: ScopeConfig,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!this.config) throw new Error("Arena integration is not configured");
    const url = new URL(annexUrl, `${this.config.baseUrl}/`).toString();
    const decision = PolicyEngine.evaluateArenaAnnexRequest(this.config, scope, url);
    if (!decision.allowed) throw new Error(decision.reason);
    const target = new URL(url);
    const base = new URL(this.config.baseUrl);
    const arenaControlPlane =
      target.protocol === base.protocol &&
      target.host === base.host &&
      target.pathname.startsWith("/api/skill/agent/arena/");
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: combined,
      headers: {
        accept: "application/octet-stream, application/zip, */*",
        ...(arenaControlPlane ? { authorization: `Bearer ${this.token()}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`Arena annex download returned HTTP ${response.status}`);
    const { bytes, truncated } = await boundedResponseBytes(response, maxBytes);
    if (truncated) throw new Error(`Arena annex exceeded ${maxBytes} bytes`);
    return bytes;
  }
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function annexName(value: Record<string, unknown>, url: string, index: number): string {
  for (const key of ["name", "filename", "file_name", "title"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  try {
    const pathName = new URL(url, "https://arena.invalid/").pathname.split("/").filter(Boolean).at(-1);
    if (pathName) return decodeURIComponent(pathName);
  } catch {
    // Fall through to a deterministic bounded name.
  }
  return `annex-${index + 1}.bin`;
}

export function extractArenaAnnexes(attempt: ArenaAttempt): ArenaAnnexDescriptor[] {
  const results: ArenaAnnexDescriptor[] = [];
  const visit = (value: unknown): void => {
    if (results.length >= 20 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) || value.startsWith("/")) {
        results.push({ name: annexName({}, value, results.length), url: value });
      }
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const url = [record.url, record.download_url, record.downloadUrl].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    if (url) {
      const size = Number(record.size ?? record.file_size ?? record.fileSize);
      results.push({
        name: annexName(record, url, results.length),
        url,
        ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
      });
      return;
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(attempt.problem?.annex);
  return results;
}

export function arenaSubmissionCorrect(data: ArenaSubmitData): boolean | undefined {
  if (typeof data.correct === "boolean") return data.correct;
  const state = data.attempt?.state_label?.toLowerCase();
  if (state === "solved" || state === "accepted" || state === "correct") return true;
  if (state === "active") return false;
  return undefined;
}

export function extractChallengeHosts(attempt: ArenaAttempt): string[] {
  const urls = attempt.problem?.container?.url ?? [];
  const hosts: string[] = [];
  for (const value of urls) {
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (url.protocol === "http:" || url.protocol === "https:") hosts.push(url.host);
    } catch {
      // Preserve forward progress; malformed URLs remain visible in the task text.
    }
  }
  return [...new Set(hosts)];
}

export function scopeForArenaAttempt(config: AppConfig, attempt: ArenaAttempt): Partial<ScopeConfig> | undefined {
  const hosts = extractChallengeHosts(attempt);
  if (config.scope.mode !== "controlled") {
    throw new Error("Arena container challenges require a full config with scope.mode=controlled");
  }
  const unauthorized = hosts.filter((host) => !config.scope.allowedHosts.some((allowed) => hostMatches(host, allowed)));
  if (unauthorized.length > 0) {
    throw new Error(`Arena challenge hosts are outside configured scope.allowedHosts: ${unauthorized.join(", ")}`);
  }
  return { mode: "controlled", allowedHosts: hosts };
}

export function arenaAttemptToTask(attempt: ArenaAttempt): TaskRequest {
  const problem = attempt.problem ?? {};
  const containerUrls = problem.container?.url ?? [];
  const lines = [
    "NSSCTF Agent Arena challenge. Solve it as a generic CTF task without using challenge IDs, memorized answers, or fixed flag templates.",
    "Arena skill guidance: use the current attempt when active; use only registered tools and evidence-preserving scratch files; submit only after independent verification; abandon instead of guessing or retrying indefinitely.",
    "",
    `Attempt state: ${attempt.state_label ?? "unknown"}`,
    `Wrong submissions: ${attempt.wrong_count ?? 0}/${attempt.max_wrong_count ?? "unknown"}`,
    `Attempt remaining seconds: ${attempt.remaining_seconds ?? "unknown"}`,
    `Category: ${problem.type_label ?? problem.type ?? "unknown"}`,
    `Problem rating: ${problem.rating ?? "unknown"}`,
    `Container enabled: ${Boolean(problem.container_enabled)}`,
    `Container URLs: ${containerUrls.length ? containerUrls.join(", ") : "none"}`,
    `Container remaining seconds: ${problem.container?.remaining_seconds ?? "unknown"}`,
    "",
    "Problem statement:",
    problem.content ?? "",
    "",
    "Hint:",
    problem.hint ?? "none",
    "",
    "Annex metadata:",
    problem.annex === null || problem.annex === undefined
      ? "none"
      : compactJson(
          extractArenaAnnexes(attempt).map(({ name, size }) => ({
            name,
            ...(size === undefined ? {} : { size }),
            downloadedAsTaskAttachment: true,
          })),
        ),
    "",
    "Submission contract:",
    "- Use the available CTF tools to triage and solve independently.",
    "- Do not guess. If evidence is insufficient, finish as blocked.",
    "- When you have high confidence, call finish_task with submission set to the exact flag value and also include a line exactly like: FLAG: <exact flag value>.",
    "- The submission field is the machine-readable answer used for automatic Arena submission; do not put explanations in it.",
    "- Set independentlyVerified=true only after a second evidence path or a reproducible round trip supports the exact candidate; include that evidence in verification.",
    "- Distinguish recovered plaintext from encoded display output and infer wrappers only from evidence. Do not re-encode or wrap a candidate merely because it looks plausible.",
    "- Keep generated scripts, decoded files, payloads, and notes under scratchRoot.",
    ...(problem.container_enabled && containerUrls.length === 0
      ? [
          "- The platform did not provide an active container URL. Do not guess service hosts or probe platform APIs; perform offline analysis and finish blocked if remote verification is required.",
        ]
      : []),
  ];
  return {
    task: lines.join("\n"),
    metadata: {
      source: "nssctf-agent-arena",
      attemptId: String(attempt.id),
      category: String(problem.type_label ?? problem.type ?? "unknown"),
    },
  };
}

export function extractFlagCandidate(state: RunState): string | undefined {
  if (state.submission?.trim()) return cleanFlagCandidate(state.submission);
  const sources = [
    state.summary,
    ...state.findings.flatMap((finding) => [finding.title, finding.description, ...finding.evidence]),
  ].filter((item): item is string => Boolean(item));
  for (const source of sources) {
    const match = source.match(/(?:^|\n)\s*FLAG\s*[:：=]\s*(.+?)\s*(?:\n|$)/i);
    if (!match?.[1]) continue;
    const candidate = cleanFlagCandidate(match[1]);
    if (candidate.length > 0 && candidate.length <= 512) return candidate;
  }
  for (const source of sources) {
    const match = source.match(/\b[A-Za-z][A-Za-z0-9_-]{1,63}\{[^{}\r\n]{1,448}\}/);
    if (match?.[0]) return cleanFlagCandidate(match[0]);
  }
  return undefined;
}

export function summarizeArenaAttempt(data: ArenaNextData): Record<string, unknown> {
  const attempt = requireAttempt(data, "Arena");
  return {
    reused: Boolean(data.reused),
    agent: data.agent ?? {},
    attempt: {
      id: attempt.id,
      state: attempt.state_label ?? "unknown",
      wrong: `${attempt.wrong_count ?? 0}/${attempt.max_wrong_count ?? "unknown"}`,
      remainingSeconds: attempt.remaining_seconds ?? null,
      type: attempt.problem?.type_label ?? attempt.problem?.type ?? "unknown",
      rating: attempt.problem?.rating ?? null,
      containerUrls: attempt.problem?.container?.url ?? [],
      hasAnnex: attempt.problem?.annex !== null && attempt.problem?.annex !== undefined,
    },
  };
}

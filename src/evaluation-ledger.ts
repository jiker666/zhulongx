import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ProviderErrorCode } from "./types.js";
import { sanitizeSensitiveText } from "./sanitize.js";

export interface EvaluationBudget {
  maxAttempts: number;
  maxRuntimeMsPerAttempt: number;
  maxTokensPerAttempt: number;
  maxCostMicrosPerAttempt: number;
  networkAllowed: boolean;
}

export interface EvaluationManifest {
  id: string;
  suite: string;
  datasetVersion: string;
  split: "development" | "validation" | "hidden";
  model: { provider: string; id: string; thinkingLevel: string };
  runtime: { node: string; platform: string; arch: string };
  budget: EvaluationBudget;
  artifacts: Array<{ name: string; sha256: string; bytes: number }>;
  containerDigests: Record<string, string>;
  manifestHash: string;
  createdAt: string;
}

export interface EvaluationAttempt {
  id: string;
  manifestId: string;
  taskId: string;
  runId: string;
  outcome: "success" | "partial" | "failed" | "blocked";
  durationMs: number;
  tokensUsed: number;
  costMicros: number;
  toolCalls: number;
  timeToFirstHypothesisMs?: number;
  errorCode?: ProviderErrorCode | "policy" | "evidence" | "infrastructure";
  trace: { auditPath?: string; auditSha256?: string; runArtifactId: string };
  createdAt: string;
}

export interface EvaluationReport {
  manifest: EvaluationManifest;
  attempts: number;
  successes: number;
  successRate: number;
  outcomes: Record<string, number>;
  errors: Record<string, number>;
  durationMs: { mean: number; min: number; max: number };
  tokens: { total: number; mean: number };
  costMicros: { total: number; mean: number };
  traceReferences: Array<{ runId: string; runArtifactId: string; auditSha256?: string }>;
}

interface EvaluationState { version: 1; manifests: EvaluationManifest[]; attempts: EvaluationAttempt[]; }
export interface EvaluationLimits { maxManifests: number; maxAttempts: number; maxArtifactFiles: number; maxArtifactBytes: number; }
const DEFAULT_LIMITS: EvaluationLimits = { maxManifests: 64, maxAttempts: 10_000, maxArtifactFiles: 32, maxArtifactBytes: 8 * 1024 * 1024 };

function bounded(value: string, max: number): string { return sanitizeSensitiveText(value.trim()).slice(0, max); }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); return value; }
function nonnegative(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); return value; }
function average(values: number[]): number { return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : 0; }

export class EvaluationLedger {
  readonly path: string;
  readonly limits: EvaluationLimits;
  private queue = Promise.resolve();

  constructor(root: string, limits: Partial<EvaluationLimits> = {}) { this.path = join(root, "evaluations.json"); this.limits = { ...DEFAULT_LIMITS, ...limits }; }

  async createManifest(input: { suite: string; datasetVersion: string; split: EvaluationManifest["split"]; model: EvaluationManifest["model"]; budget: EvaluationBudget; artifactPaths?: string[]; containerDigests?: Record<string, string>; signal?: AbortSignal }): Promise<EvaluationManifest> {
    input.signal?.throwIfAborted();
    if (!input.suite.trim() || !input.datasetVersion.trim()) throw new Error("Evaluation suite and datasetVersion are required");
    if (!["development", "validation", "hidden"].includes(input.split)) throw new Error("Evaluation split is invalid");
    if (!Array.isArray(input.artifactPaths ?? [] ) || (input.artifactPaths?.length ?? 0) > this.limits.maxArtifactFiles) throw new Error("Evaluation artifact file budget exceeded");
    const artifacts: EvaluationManifest["artifacts"] = []; let totalBytes = 0;
    for (const path of input.artifactPaths ?? []) {
      input.signal?.throwIfAborted();
      const details = await stat(path); if (!details.isFile() || details.size > this.limits.maxArtifactBytes || totalBytes + details.size > this.limits.maxArtifactBytes) throw new Error("Evaluation artifact byte budget exceeded");
      const bytes = await readFile(path); totalBytes += bytes.length; artifacts.push({ name: basename(path), sha256: sha256(bytes), bytes: bytes.length });
    }
    const budget = { maxAttempts: positive(input.budget.maxAttempts, "evaluation maxAttempts"), maxRuntimeMsPerAttempt: positive(input.budget.maxRuntimeMsPerAttempt, "evaluation maxRuntimeMsPerAttempt"), maxTokensPerAttempt: positive(input.budget.maxTokensPerAttempt, "evaluation maxTokensPerAttempt"), maxCostMicrosPerAttempt: positive(input.budget.maxCostMicrosPerAttempt, "evaluation maxCostMicrosPerAttempt"), networkAllowed: input.budget.networkAllowed === true };
    const stable = { suite: bounded(input.suite, 200), datasetVersion: bounded(input.datasetVersion, 200), split: input.split, model: { provider: bounded(input.model.provider, 100), id: bounded(input.model.id, 200), thinkingLevel: bounded(input.model.thinkingLevel, 50) }, runtime: { node: process.version, platform: process.platform, arch: process.arch }, budget, artifacts, containerDigests: Object.fromEntries(Object.entries(input.containerDigests ?? {}).slice(0, 16).map(([key, value]) => [bounded(key, 100), bounded(value, 256)])) };
    const manifest: EvaluationManifest = { id: randomUUID(), ...stable, manifestHash: sha256(JSON.stringify(stable)), createdAt: new Date().toISOString() };
    return await this.mutate((state) => { if (state.manifests.length >= this.limits.maxManifests) throw new Error("Evaluation manifest budget exhausted"); state.manifests.push(manifest); return manifest; });
  }

  async record(input: Omit<EvaluationAttempt, "id" | "createdAt">): Promise<EvaluationAttempt> {
    return await this.mutate((state) => {
      if (state.attempts.length >= this.limits.maxAttempts) throw new Error("Evaluation attempt store budget exhausted");
      const manifest = state.manifests.find((item) => item.id === input.manifestId); if (!manifest) throw new Error("Evaluation manifest not found");
      if (!["success", "partial", "failed", "blocked"].includes(input.outcome)) throw new Error("Evaluation outcome is invalid");
      if (input.errorCode && !["rate_limit", "quota", "provider_config", "request_rejected", "network_policy", "network", "server", "tool_denied", "aborted", "unknown", "policy", "evidence", "infrastructure"].includes(input.errorCode)) throw new Error("Evaluation errorCode is invalid");
      const currentAttempts = state.attempts.filter((item) => item.manifestId === manifest.id).length; if (currentAttempts >= manifest.budget.maxAttempts) throw new Error("Evaluation attempt budget exhausted");
      const durationMs = nonnegative(input.durationMs, "evaluation durationMs"); const tokensUsed = nonnegative(input.tokensUsed, "evaluation tokensUsed"); const costMicros = nonnegative(input.costMicros, "evaluation costMicros");
      if (durationMs > manifest.budget.maxRuntimeMsPerAttempt || tokensUsed > manifest.budget.maxTokensPerAttempt || costMicros > manifest.budget.maxCostMicrosPerAttempt) throw new Error("Evaluation attempt exceeded manifest budget");
      if (input.trace.auditPath && !isAbsolute(input.trace.auditPath)) throw new Error("Evaluation auditPath must be absolute");
      if (!input.taskId.trim() || !input.runId.trim() || !input.trace.runArtifactId.trim()) throw new Error("Evaluation taskId, runId, and runArtifactId are required");
      if (input.trace.auditSha256 && !/^[a-f0-9]{64}$/i.test(input.trace.auditSha256)) throw new Error("Evaluation auditSha256 is invalid");
      const attempt: EvaluationAttempt = { id: randomUUID(), ...input, taskId: bounded(input.taskId, 256), runId: bounded(input.runId, 128), durationMs, tokensUsed, costMicros, toolCalls: nonnegative(input.toolCalls, "evaluation toolCalls"), ...(input.timeToFirstHypothesisMs === undefined ? {} : { timeToFirstHypothesisMs: nonnegative(input.timeToFirstHypothesisMs, "evaluation timeToFirstHypothesisMs") }), trace: { ...(input.trace.auditPath ? { auditPath: input.trace.auditPath } : {}), ...(input.trace.auditSha256 ? { auditSha256: input.trace.auditSha256.toLowerCase() } : {}), runArtifactId: bounded(input.trace.runArtifactId, 256) }, createdAt: new Date().toISOString() };
      state.attempts.push(attempt); return attempt;
    });
  }

  async listManifests(limit = 64): Promise<EvaluationManifest[]> {
    return (await this.read()).manifests.slice(-Math.max(0, Math.min(limit, this.limits.maxManifests))).reverse();
  }

  async listAttempts(manifestId: string, limit = 100): Promise<EvaluationAttempt[]> {
    return (await this.read()).attempts.filter((attempt) => attempt.manifestId === manifestId).slice(-Math.max(0, Math.min(limit, 1_000))).reverse();
  }

  async report(manifestId: string): Promise<EvaluationReport> {
    const state = await this.read(); const manifest = state.manifests.find((item) => item.id === manifestId); if (!manifest) throw new Error("Evaluation manifest not found");
    const attempts = state.attempts.filter((item) => item.manifestId === manifestId); const outcomes: Record<string, number> = {}; const errors: Record<string, number> = {};
    for (const attempt of attempts) { outcomes[attempt.outcome] = (outcomes[attempt.outcome] ?? 0) + 1; if (attempt.errorCode) errors[attempt.errorCode] = (errors[attempt.errorCode] ?? 0) + 1; }
    const durations = attempts.map((item) => item.durationMs); const tokens = attempts.map((item) => item.tokensUsed); const costs = attempts.map((item) => item.costMicros); const successes = outcomes.success ?? 0;
    return { manifest, attempts: attempts.length, successes, successRate: attempts.length ? Number((successes / attempts.length).toFixed(4)) : 0, outcomes, errors, durationMs: { mean: average(durations), min: durations.length ? Math.min(...durations) : 0, max: durations.length ? Math.max(...durations) : 0 }, tokens: { total: tokens.reduce((sum, value) => sum + value, 0), mean: average(tokens) }, costMicros: { total: costs.reduce((sum, value) => sum + value, 0), mean: average(costs) }, traceReferences: attempts.map((attempt) => ({ runId: attempt.runId, runArtifactId: attempt.trace.runArtifactId, ...(attempt.trace.auditSha256 ? { auditSha256: attempt.trace.auditSha256 } : {}) })) };
  }

  private async mutate<T>(operation: (state: EvaluationState) => T): Promise<T> { let result!: T; const pending = this.queue.then(async () => { const state = await this.read(); result = operation(state); await this.write(state); }); this.queue = pending.then(() => undefined, () => undefined); await pending; return result; }
  private async read(): Promise<EvaluationState> { try { const value = JSON.parse(await readFile(this.path, "utf8")) as EvaluationState; return { version: 1, manifests: value.manifests ?? [], attempts: value.attempts ?? [] }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, manifests: [], attempts: [] }; throw error; } }
  private async write(state: EvaluationState): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`; try { await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, this.path); } finally { await rm(temporary, { force: true }); } }
}

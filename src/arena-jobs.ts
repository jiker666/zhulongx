import { randomUUID } from "node:crypto";
import { ArenaClient, type ArenaAgent } from "./arena.js";
import {
  buildArenaEvaluationReport,
  solveArenaOnce,
  writeArenaEvaluationReport,
  type ArenaAttemptEvaluation,
  type ArenaEvaluationReport,
  type ArenaSolveResult,
  type SolveArenaOptions,
} from "./arena-evaluation.js";
import {
  ArenaWrongQuestionStore,
  type ArenaWrongQuestionRecord,
  type ArenaWrongQuestionSummary,
} from "./arena-wrong-questions.js";
import { SandboxClient, startSandboxServer } from "./sandbox.js";
import type { AppConfig, RunEvent } from "./types.js";

const MAX_JOB_HISTORY = 20;
const MAX_ACTIVITY_EVENTS = 100;
const MAX_ATTEMPT_HISTORY = 200;
const MAX_SEEN_ATTEMPTS = 1000;

export type ArenaJobStatus = "queued" | "running" | "stopping" | "completed" | "failed" | "aborted";

export interface ArenaJobStartInput {
  maxAttempts: number;
  autoSubmit: boolean;
  idleSeconds: number;
  continuous?: boolean;
}

export interface ArenaJobOptions {
  maxAttempts: number;
  autoSubmit: boolean;
  idleSeconds: number;
  continuous: boolean;
}

export interface ArenaJobActivity {
  timestamp: string;
  type: string;
  runId: string;
  detail: string;
}

export interface ArenaCapabilitySummary {
  solved: number;
  evaluated: number;
  accuracyPercent: number | null;
  averageTurns: number;
  averageToolCalls: number;
  promotedLessons: number;
  outcomes: Record<string, number>;
  strengths: string[];
  gaps: string[];
  nextActions: string[];
}

export interface ArenaJobSnapshot {
  id: string;
  status: ArenaJobStatus;
  options: ArenaJobOptions;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  completedAttempts: number;
  currentRunId?: string;
  attempts: ArenaAttemptEvaluation[];
  activity: ArenaJobActivity[];
  summary?: ArenaCapabilitySummary;
  report?: ArenaEvaluationReport;
  reportPath?: string;
  error?: string;
}

export interface ArenaJobListItem {
  id: string;
  status: ArenaJobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  targetAttempts: number | null;
  continuous: boolean;
  completedAttempts: number;
  currentRunId?: string;
  accuracyPercent?: number | null;
  error?: string;
}

export interface ArenaReadiness {
  ready: boolean;
  issues: string[];
  model: { provider: string; id: string; name: string };
  arenaConfigured: boolean;
  arenaCredentialConfigured: boolean;
  modelCredentialConfigured: boolean;
  modelHeadersConfigured: boolean;
  scopeControlled: boolean;
  allowedCategories: string[];
  maxCategorySkips: number;
  sandbox: {
    reachable: boolean;
    network: string;
    availablePrograms: number;
    configuredPrograms: number;
  };
}

interface ArenaJobHandle extends ArenaJobSnapshot {
  controller: AbortController;
  promise: Promise<void>;
}

interface ArenaJobDependencies {
  solveOnce?: (
    config: AppConfig,
    client: ArenaClient,
    options: SolveArenaOptions,
  ) => Promise<ArenaSolveResult>;
  clientFactory?: (config: AppConfig) => ArenaClient;
  ensureSandbox?: (config: AppConfig) => Promise<{ owned: boolean; close: () => Promise<void> }>;
  writeReport?: (config: AppConfig, report: ArenaEvaluationReport) => Promise<string>;
  readAgent?: (client: ArenaClient, signal: AbortSignal) => Promise<ArenaAgent | undefined>;
  wrongQuestionStore?: Pick<ArenaWrongQuestionStore, "record" | "get" | "list">;
}

function configurationIssues(config: AppConfig): string[] {
  const issues: string[] = [];
  if (!config.arena?.enabled) issues.push("Arena integration is disabled");
  else if (!process.env[config.arena.tokenEnv]) issues.push(`Missing ${config.arena.tokenEnv}`);
  if (!process.env[config.model.apiKeyEnv]) issues.push(`Missing ${config.model.apiKeyEnv}`);
  for (const envName of Object.values(config.model.headersFromEnv ?? {})) {
    if (!process.env[envName]) issues.push(`Missing ${envName}`);
  }
  if (config.scope.mode !== "controlled") issues.push("Arena requires scope.mode=controlled");
  if (config.scope.allowedHosts.length === 0) issues.push("Arena requires operator-owned allowedHosts");
  return issues;
}

function safeError(error: unknown, config: AppConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  const credentialEnvironments = [
    config.model.apiKeyEnv,
    ...Object.values(config.model.headersFromEnv ?? {}),
    ...(config.arena ? [config.arena.tokenEnv] : []),
    config.server.tokenEnv,
  ];
  for (const environment of credentialEnvironments) {
    const credential = process.env[environment];
    if (credential) message = message.split(credential).join("[REDACTED]");
  }
  return message
    .replace(/(authorization|api[-_ ]?key|cookie|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .slice(0, 1000);
}

function activityFor(event: RunEvent): ArenaJobActivity {
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  let detail = event.type;
  if (typeof data.toolName === "string") detail = data.toolName;
  else if (typeof data.status === "string") detail = data.status;
  else if (typeof data.phase === "string") detail = data.phase;
  return { timestamp: event.timestamp, type: event.type, runId: event.runId, detail: detail.slice(0, 160) };
}

function roundAverage(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(1));
}

export function buildArenaCapabilitySummary(attempts: ArenaAttemptEvaluation[]): ArenaCapabilitySummary {
  const settled = attempts.filter((attempt) => attempt.settled);
  const solved = settled.filter((attempt) => attempt.correct === true).length;
  const outcomes: Record<string, number> = {};
  for (const attempt of attempts) outcomes[attempt.outcome] = (outcomes[attempt.outcome] ?? 0) + 1;
  const promotedLessons = attempts.reduce((total, attempt) => total + (attempt.run.promotedLessons ?? 0), 0);
  const strengths: string[] = [];
  const gaps: string[] = [];
  const nextActions: string[] = [];

  if (solved > 0) strengths.push(`${solved} 次解题结果通过平台验真`);
  if (promotedLessons > 0) strengths.push(`${promotedLessons} 条通用经验已自动晋升，后续任务仍会重新验证`);
  const solvedCategories = [...new Set(settled.filter((attempt) => attempt.correct).map((attempt) => attempt.category))];
  if (solvedCategories.length > 0) strengths.push(`已验证题型：${solvedCategories.join("、")}`);
  if (solved === 0) gaps.push("当前作业尚无平台验真的成功解");
  if ((outcomes.wrong ?? 0) > 0) gaps.push(`${outcomes.wrong} 次候选答案被拒绝，精确变换或独立验证仍需加强`);
  if ((outcomes.blocked ?? 0) > 0) gaps.push(`${outcomes.blocked} 次未形成可提交结论，平台题目已保留供后续重试`);
  if ((outcomes.abandoned ?? 0) > 0) gaps.push(`${outcomes.abandoned} 次未形成可提交结论，需要改善证据到答案的收敛`);
  if ((outcomes.skipped ?? 0) > 0) gaps.push(`${outcomes.skipped} 次题型不在当前优化范围内，已自动跳过且未计入目标题数`);
  if ((outcomes["infrastructure-error"] ?? 0) > 0) gaps.push(`${outcomes["infrastructure-error"]} 次基础设施失败，应先排除容器、模型或网络问题`);
  if (attempts.some((attempt) => attempt.submissionAttempts > 1)) {
    nextActions.push("复盘多次提交题目的候选生成与二次验证路径");
  }
  if ((outcomes.abandoned ?? 0) > 0) nextActions.push("按题型检查阻塞点，并补充可复现的最小验证步骤");
  if ((outcomes.blocked ?? 0) > 0) nextActions.push("复用已归档附件重试当前题目，避免提前放弃触发平台冷却");
  if ((outcomes["infrastructure-error"] ?? 0) > 0) nextActions.push("先修复基础设施错误，再评估模型策略质量");
  if ((outcomes.skipped ?? 0) > 0) nextActions.push("继续在 Crypto 和 Misc 范围内取题，达到跳过预算后停止作业");
  if (promotedLessons === 0) nextActions.push("仅从平台成功运行中提炼通用经验，避免把失败猜测写入经验库");
  if (nextActions.length === 0) nextActions.push("在隐藏题型上复测已晋升经验，确认收益可泛化");

  return {
    solved,
    evaluated: settled.length,
    accuracyPercent: settled.length === 0 ? null : Number(((solved / settled.length) * 100).toFixed(2)),
    averageTurns: roundAverage(attempts.map((attempt) => attempt.run.turns)),
    averageToolCalls: roundAverage(attempts.map((attempt) => attempt.run.toolCalls)),
    promotedLessons,
    outcomes,
    strengths,
    gaps,
    nextActions,
  };
}

async function defaultEnsureSandbox(config: AppConfig): Promise<{ owned: boolean; close: () => Promise<void> }> {
  const client = new SandboxClient(config.runtime.sandbox.socketPath, config.runtime.sandbox.connectTimeoutMs);
  try {
    await client.health();
    return { owned: false, close: async () => {} };
  } catch {
    const running = await startSandboxServer({
      socketPath: config.runtime.sandbox.socketPath,
      workspaceRoot: config.scope.workspaceRoot,
      scratchRoot: config.runtime.scratchRoot,
      allowedPrograms: config.scope.allowedPrograms,
      defaultTimeoutMs: config.runtime.commandTimeoutMs,
      maxOutputBytes: config.runtime.maxOutputBytes,
      network: process.env.XUANSHU_SANDBOX_NETWORK ?? "external",
    });
    return { owned: true, close: running.close };
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal.aborted) throw signal.reason ?? new Error("Arena job stopped by operator");
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(signal.reason ?? new Error("Arena job stopped by operator"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ArenaJobManager {
  private readonly jobs = new Map<string, ArenaJobHandle>();
  private readonly solveOnce: NonNullable<ArenaJobDependencies["solveOnce"]>;
  private readonly clientFactory: NonNullable<ArenaJobDependencies["clientFactory"]>;
  private readonly ensureSandbox: NonNullable<ArenaJobDependencies["ensureSandbox"]>;
  private readonly writeReport: NonNullable<ArenaJobDependencies["writeReport"]>;
  private readonly readAgent: NonNullable<ArenaJobDependencies["readAgent"]>;
  private readonly wrongQuestionStore: Pick<ArenaWrongQuestionStore, "record" | "get" | "list">;

  constructor(
    private readonly config: AppConfig,
    dependencies: ArenaJobDependencies = {},
  ) {
    this.solveOnce = dependencies.solveOnce ?? solveArenaOnce;
    this.clientFactory = dependencies.clientFactory ?? ((appConfig) => new ArenaClient(appConfig.arena));
    this.ensureSandbox = dependencies.ensureSandbox ?? defaultEnsureSandbox;
    this.writeReport = dependencies.writeReport ?? writeArenaEvaluationReport;
    this.readAgent = dependencies.readAgent ?? (async (client, signal) => (await client.current(signal)).agent);
    this.wrongQuestionStore = dependencies.wrongQuestionStore ?? new ArenaWrongQuestionStore(config);
  }

  async readiness(): Promise<ArenaReadiness> {
    let reachable = false;
    let network = "unknown";
    let availablePrograms = 0;
    try {
      const health = await new SandboxClient(
        this.config.runtime.sandbox.socketPath,
        this.config.runtime.sandbox.connectTimeoutMs,
      ).health();
      reachable = true;
      network = health.network;
      availablePrograms = health.allowedPrograms.length;
    } catch {
      // A local sidecar can be started when the job begins.
    }
    const issues = configurationIssues(this.config);
    return {
      ready: issues.length === 0,
      issues,
      model: {
        provider: this.config.model.provider,
        id: this.config.model.id,
        name: this.config.model.name,
      },
      arenaConfigured: Boolean(this.config.arena?.enabled),
      arenaCredentialConfigured: Boolean(this.config.arena && process.env[this.config.arena.tokenEnv]),
      modelCredentialConfigured: Boolean(process.env[this.config.model.apiKeyEnv]),
      modelHeadersConfigured: Object.values(this.config.model.headersFromEnv ?? {}).every((name) => Boolean(process.env[name])),
      scopeControlled: this.config.scope.mode === "controlled" && this.config.scope.allowedHosts.length > 0,
      allowedCategories: [...(this.config.arena?.allowedCategories ?? [])],
      maxCategorySkips: this.config.arena?.maxCategorySkips ?? 10,
      sandbox: {
        reachable,
        network,
        availablePrograms,
        configuredPrograms: this.config.scope.allowedPrograms.length,
      },
    };
  }

  start(input: ArenaJobStartInput): ArenaJobSnapshot {
    const issues = configurationIssues(this.config);
    if (issues.length > 0) throw new Error(issues.join("; "));
    const continuous = input.continuous ?? true;
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 50) {
      throw new Error("maxAttempts must be an integer between 1 and 50");
    }
    if (!Number.isFinite(input.idleSeconds) || input.idleSeconds < 0 || input.idleSeconds > 300) {
      throw new Error("idleSeconds must be between 0 and 300");
    }
    if (!input.autoSubmit && (continuous || input.maxAttempts !== 1)) {
      throw new Error("A no-submit review job must contain exactly one attempt");
    }
    const active = [...this.jobs.values()].find((job) => ["queued", "running", "stopping"].includes(job.status));
    if (active) throw new Error(`Arena job ${active.id} is already active`);

    const id = randomUUID();
    const handle: ArenaJobHandle = {
      id,
      status: "queued",
      options: { ...input, continuous },
      createdAt: new Date().toISOString(),
      completedAttempts: 0,
      attempts: [],
      activity: [],
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    handle.promise = this.execute(handle);
    void handle.promise.catch(() => undefined);
    this.jobs.set(id, handle);
    this.trimHistory();
    return this.snapshot(handle);
  }

  get(id: string): ArenaJobSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : undefined;
  }

  list(): ArenaJobListItem[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        targetAttempts: job.options.continuous ? null : job.options.maxAttempts,
        continuous: job.options.continuous,
        completedAttempts: job.completedAttempts,
        ...(job.currentRunId ? { currentRunId: job.currentRunId } : {}),
        ...(job.summary ? { accuracyPercent: job.summary.accuracyPercent } : {}),
        ...(job.error ? { error: job.error } : {}),
      }));
  }

  async listWrongQuestions(limit = 50): Promise<ArenaWrongQuestionSummary[]> {
    return await this.wrongQuestionStore.list(limit);
  }

  async getWrongQuestion(attemptId: number): Promise<ArenaWrongQuestionRecord | undefined> {
    return await this.wrongQuestionStore.get(attemptId);
  }

  stop(id: string): ArenaJobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued" || job.status === "running") {
      job.status = "stopping";
      job.controller.abort(new Error("Arena job stopped by operator"));
    }
    return this.snapshot(job);
  }

  async close(): Promise<void> {
    const active = [...this.jobs.values()].filter((job) => ["queued", "running", "stopping"].includes(job.status));
    for (const job of active) this.stop(job.id);
    await Promise.allSettled(active.map((job) => job.promise));
  }

  private async execute(job: ArenaJobHandle): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    let sandbox: { owned: boolean; close: () => Promise<void> } | undefined;
    let startAgent: ArenaAgent | undefined;
    let endAgent: ArenaAgent | undefined;
    let infrastructureError: string | undefined;
    try {
      sandbox = await this.ensureSandbox(this.config);
      const client = this.clientFactory(this.config);
      startAgent = await this.readAgent(client, job.controller.signal);
      const seen = new Set<number>();
      const seenOrder: number[] = [];
      const rememberAttempt = (attemptId: number) => {
        seen.add(attemptId);
        seenOrder.push(attemptId);
        if (seenOrder.length > MAX_SEEN_ATTEMPTS) {
          const expired = seenOrder.shift();
          if (expired !== undefined) seen.delete(expired);
        }
      };
      while (job.options.continuous || job.completedAttempts < job.options.maxAttempts) {
        if (job.controller.signal.aborted) throw job.controller.signal.reason;
        delete job.currentRunId;
        job.activity.push({
          timestamp: new Date().toISOString(),
          type: "arena.attempt.requested",
          runId: "",
          detail: "Requesting the next Arena attempt",
        });
        if (job.activity.length > MAX_ACTIVITY_EVENTS) job.activity.shift();
        const result = await this.solveOnce(this.config, client, {
          autoSubmit: job.options.autoSubmit,
          seenAttemptIds: seen,
          signal: job.controller.signal,
          onEvent: (event) => {
            job.currentRunId = event.runId;
            job.activity.push(activityFor(event));
            if (job.activity.length > MAX_ACTIVITY_EVENTS) job.activity.shift();
          },
        });
        job.activity.push({
          timestamp: new Date().toISOString(),
          type: "arena.attempt.evaluated",
          runId: result.state.id,
          detail: `${result.attemptId}: ${result.evaluation.outcome}`,
        });
        if (job.activity.length > MAX_ACTIVITY_EVENTS) job.activity.shift();
        job.attempts.push(result.evaluation);
        if (job.attempts.length > MAX_ATTEMPT_HISTORY) job.attempts.shift();
        if (result.evaluation.outcome === "dry-run") {
          job.completedAttempts = 1;
          break;
        }
        if (result.evaluation.outcome === "skipped") {
          throw new Error(result.evaluation.reason ?? "Arena category is outside the configured allowlist");
        }
        if (["wrong", "blocked", "abandoned"].includes(result.evaluation.outcome)) {
          try {
            await this.wrongQuestionStore.record(result.state, result.evaluation);
            job.activity.push({
              timestamp: new Date().toISOString(),
              type: "arena.wrong-question.saved",
              runId: result.state.id,
              detail: `Attempt ${result.attemptId} and ${result.evaluation.attachmentCount} attachment(s) archived`,
            });
          } catch (error) {
            job.activity.push({
              timestamp: new Date().toISOString(),
              type: "arena.wrong-question.archive-failed",
              runId: result.state.id,
              detail: safeError(error, this.config),
            });
          }
          if (job.activity.length > MAX_ACTIVITY_EVENTS) job.activity.shift();
        }
        if (!result.evaluation.settled) {
          throw new Error(result.evaluation.reason ?? "Arena attempt did not reach a settled platform state");
        }
        rememberAttempt(result.attemptId);
        job.completedAttempts += 1;
        if (job.options.continuous || job.completedAttempts < job.options.maxAttempts) {
          await abortableDelay(job.options.idleSeconds * 1000, job.controller.signal);
        }
      }
      try {
        endAgent = await this.readAgent(client, job.controller.signal);
      } catch {
        // The solve result remains valid if the optional final rating lookup fails.
      }
      const reportInput = {
        startedAt: job.startedAt ?? job.createdAt,
        targetAttempts: job.options.continuous ? null : job.options.maxAttempts,
        config: this.config,
        attempts: job.attempts,
        ...(startAgent ? { startAgent } : {}),
        ...(endAgent ? { endAgent } : {}),
      };
      job.report = buildArenaEvaluationReport(reportInput);
      job.reportPath = await this.writeReport(this.config, job.report);
      job.summary = buildArenaCapabilitySummary(job.attempts);
      job.status = "completed";
    } catch (error) {
      infrastructureError = safeError(error, this.config);
      job.error = infrastructureError;
      job.status = job.controller.signal.aborted ? "aborted" : "failed";
      job.summary = buildArenaCapabilitySummary(job.attempts);
      const reportInput = {
        startedAt: job.startedAt ?? job.createdAt,
        targetAttempts: job.options.continuous ? null : job.options.maxAttempts,
        config: this.config,
        attempts: job.attempts,
        ...(startAgent ? { startAgent } : {}),
        ...(endAgent ? { endAgent } : {}),
        infrastructureError,
      };
      job.report = buildArenaEvaluationReport(reportInput);
      try {
        job.reportPath = await this.writeReport(this.config, job.report);
      } catch {
        // Keep the original failure as the job result.
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      delete job.currentRunId;
      if (sandbox?.owned) await sandbox.close();
    }
  }

  private snapshot(job: ArenaJobHandle): ArenaJobSnapshot {
    return {
      id: job.id,
      status: job.status,
      options: { ...job.options },
      createdAt: job.createdAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      completedAttempts: job.completedAttempts,
      ...(job.currentRunId ? { currentRunId: job.currentRunId } : {}),
      attempts: job.attempts.map((attempt) => ({ ...attempt, run: { ...attempt.run } })),
      activity: job.activity.map((event) => ({ ...event })),
      ...(job.summary ? { summary: { ...job.summary, outcomes: { ...job.summary.outcomes }, strengths: [...job.summary.strengths], gaps: [...job.summary.gaps], nextActions: [...job.summary.nextActions] } } : {}),
      ...(job.report ? { report: { ...job.report, attempts: job.report.attempts.map((attempt) => ({ ...attempt, run: { ...attempt.run } })) } } : {}),
      ...(job.reportPath ? { reportPath: job.reportPath } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private trimHistory(): void {
    const settled = [...this.jobs.values()]
      .filter((job) => !["queued", "running", "stopping"].includes(job.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const job of settled.slice(MAX_JOB_HISTORY)) this.jobs.delete(job.id);
  }
}

import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ArenaClient,
  arenaAttemptToTask,
  arenaSubmissionCorrect,
  extractArenaAnnexes,
  extractFlagCandidate,
  scopeForArenaAttempt,
  summarizeArenaAttempt,
  type ArenaAgent,
  type ArenaAttempt,
  type ArenaNextData,
} from "./arena.js";
import { XuanShuRuntime } from "./runtime.js";
import { ExperienceStore } from "./experience.js";
import type { AppConfig, RunEvent, RunState } from "./types.js";

const MAX_ANNEX_BYTES = 100 * 1024 * 1024;
const CONTAINER_READY_WAIT_MS = 15000;

export type ArenaOutcome = "solved" | "wrong" | "abandoned" | "dry-run" | "infrastructure-error";

export interface ArenaAttemptEvaluation {
  attemptId: number;
  category: string;
  problemRating?: number;
  outcome: ArenaOutcome;
  settled: boolean;
  correct?: boolean;
  flagCandidateFound: boolean;
  submissionAttempts: number;
  runCount: number;
  attachmentCount: number;
  reused: boolean;
  run: {
    id: string;
    status: RunState["status"];
    summary?: string;
    stopReason?: string;
    turns: number;
    toolCalls: number;
    promotedLessons?: number;
  };
  platform?: {
    state?: string;
    ratingDelta?: number;
    agentRatingAfter?: number;
    problemRatingAfter?: number;
  };
  reason?: string;
}

export interface ArenaSolveResult {
  attemptId: number;
  state: RunState;
  evaluation: ArenaAttemptEvaluation;
}

export interface ArenaEvaluationReport {
  startedAt: string;
  finishedAt: string;
  model: { provider: string; id: string; name: string };
  targetAttempts: number;
  evaluatedAttempts: number;
  correct: number;
  incorrect: number;
  accuracy: number | null;
  accuracyPercent: number | null;
  completed: boolean;
  startAgent?: ArenaAgent;
  endAgent?: ArenaAgent;
  infrastructureError?: string;
  attempts: ArenaAttemptEvaluation[];
}

export interface SolveArenaOptions {
  autoSubmit: boolean;
  maxSubmissionAttempts?: number;
  seenAttemptIds?: Set<number>;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  previousRejectedCandidates?: string[];
  preparedAttachments?: string[];
  modelRetryCount?: number;
}

function requireAttempt(data: ArenaNextData): ArenaAttempt {
  if (!data.attempt?.id) throw new Error("Arena response did not include an active attempt");
  return data.attempt;
}

async function waitForContainerMetadata(client: ArenaClient, data: ArenaNextData): Promise<ArenaNextData> {
  let latest = data;
  let attempt = requireAttempt(latest);
  if (!attempt.problem?.container_enabled || (attempt.problem.container?.url?.length ?? 0) > 0) return latest;
  const deadline = Date.now() + CONTAINER_READY_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2000));
    const refreshed = await client.attempt(attempt.id);
    if (refreshed.attempt?.id === attempt.id) {
      const merged: ArenaNextData = { ...latest, ...refreshed };
      if (latest.reused !== undefined) merged.reused = latest.reused;
      latest = merged;
    }
    attempt = requireAttempt(latest);
    if ((attempt.problem?.container?.url?.length ?? 0) > 0) break;
  }
  return latest;
}

function safeAnnexName(name: string, index: number): string {
  const leaf = basename(name).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const bounded = leaf.replace(/^-+|-+$/g, "").slice(0, 180);
  return bounded || `annex-${index + 1}.bin`;
}

export async function downloadArenaAttachments(
  config: AppConfig,
  client: ArenaClient,
  attempt: ArenaAttempt,
  runId = randomUUID(),
): Promise<string[]> {
  const annexes = extractArenaAnnexes(attempt);
  if (annexes.length === 0) return [];
  const directory = join(config.runtime.scratchRoot, "runs", runId, "inputs");
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (const [index, annex] of annexes.entries()) {
    if (annex.size !== undefined && annex.size > MAX_ANNEX_BYTES) {
      throw new Error(`Arena annex ${index + 1} exceeds the ${MAX_ANNEX_BYTES}-byte download limit`);
    }
    const bytes = await client.downloadAnnex(annex.url, config.scope, MAX_ANNEX_BYTES);
    const target = join(directory, `${String(index + 1).padStart(2, "0")}-${safeAnnexName(annex.name, index)}`);
    await writeFile(target, bytes, { flag: "wx" });
    await chmod(target, 0o444);
    paths.push(target);
  }
  await chmod(directory, 0o555);
  return paths;
}

async function copyArenaAttachments(config: AppConfig, sources: string[], runId: string): Promise<string[]> {
  if (sources.length === 0) return [];
  const directory = join(config.runtime.scratchRoot, "runs", runId, "inputs");
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (const [index, source] of sources.entries()) {
    const target = join(directory, `${String(index + 1).padStart(2, "0")}-${safeAnnexName(basename(source), index)}`);
    await copyFile(source, target);
    await chmod(target, 0o444);
    paths.push(target);
  }
  await chmod(directory, 0o555);
  return paths;
}

function platformSummary(attempt: ArenaAttempt | undefined) {
  if (!attempt) return undefined;
  return {
    ...(attempt.state_label === undefined ? {} : { state: attempt.state_label }),
    ...(attempt.rating_delta === undefined ? {} : { ratingDelta: attempt.rating_delta }),
    ...(attempt.agent_rating_after === undefined ? {} : { agentRatingAfter: attempt.agent_rating_after }),
    ...(attempt.problem_rating_after === undefined ? {} : { problemRatingAfter: attempt.problem_rating_after }),
  };
}

function baseEvaluation(
  data: ArenaNextData,
  state: RunState,
  attachmentCount: number,
  previousSubmissionAttempts: number,
): ArenaAttemptEvaluation {
  const attempt = requireAttempt(data);
  return {
    attemptId: attempt.id,
    category: String(attempt.problem?.type_label ?? attempt.problem?.type ?? "unknown"),
    ...(attempt.problem?.rating === undefined ? {} : { problemRating: attempt.problem.rating }),
    outcome: "infrastructure-error",
    settled: false,
    flagCandidateFound: Boolean(extractFlagCandidate(state)),
    submissionAttempts: previousSubmissionAttempts,
    runCount: previousSubmissionAttempts + 1,
    attachmentCount,
    reused: Boolean(data.reused),
    run: {
      id: state.id,
      status: state.status,
      ...(state.summary === undefined ? {} : { summary: state.summary }),
      ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
      turns: state.turns,
      toolCalls: state.toolCalls,
    },
  };
}

export async function solveArenaOnce(
  config: AppConfig,
  client: ArenaClient,
  options: SolveArenaOptions,
): Promise<ArenaSolveResult> {
  const data = await waitForContainerMetadata(client, await client.next());
  const attempt = requireAttempt(data);
  if (options.seenAttemptIds?.has(attempt.id)) {
    throw new Error(`Arena attempt ${attempt.id} was reused after it had already been settled`);
  }

  const previousRejectedCandidates = options.previousRejectedCandidates ?? [];
  const maxSubmissionAttempts = options.maxSubmissionAttempts ?? 3;
  const runId = randomUUID();
  const attachments = options.preparedAttachments
    ? await copyArenaAttachments(config, options.preparedAttachments, runId)
    : await downloadArenaAttachments(config, client, attempt, runId);
  const taskRequest = arenaAttemptToTask(attempt);
  if (previousRejectedCandidates.length > 0) {
    taskRequest.task += [
      "",
      "Arena rejection feedback:",
      `- ${previousRejectedCandidates.length} previously submitted candidate(s) were rejected by the platform.`,
      ...previousRejectedCandidates.map((candidate, index) => `- Rejected candidate ${index + 1}: ${candidate}`),
      "- Re-check the flag transformation and wrapper semantics from evidence. Do not resubmit a rejected candidate.",
      "- Submit a revised candidate only when independently justified; otherwise finish as blocked.",
    ].join("\n");
  }
  if (attachments.length > 0) taskRequest.attachments = attachments;
  const challengeScope = scopeForArenaAttempt(config, attempt);
  if (challengeScope) taskRequest.scope = challengeScope;
  const runtime = new XuanShuRuntime(config, options.onEvent ? { onEvent: options.onEvent } : {});
  const state = await runtime.run(taskRequest, { id: runId });
  const evaluation = baseEvaluation(data, state, attachments.length, previousRejectedCandidates.length);
  const flag = extractFlagCandidate(state);

  if (!options.autoSubmit) {
    evaluation.outcome = "dry-run";
    evaluation.reason = "Automatic submission was disabled";
    return { attemptId: attempt.id, state, evaluation };
  }

  if (state.status === "failed") {
    const rateLimited = /(?:\b429\b|too\s*many\s*requests|rate\s*limit)/i.test(state.stopReason ?? "");
    const modelRetryCount = options.modelRetryCount ?? 0;
    if (rateLimited && modelRetryCount < 2) {
      const { seenAttemptIds: _seenAttemptIds, ...retryOptions } = options;
      const waitMs = 60000 * (modelRetryCount + 1);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, waitMs));
      return await solveArenaOnce(config, client, {
        ...retryOptions,
        modelRetryCount: modelRetryCount + 1,
        preparedAttachments: attachments,
      });
    }
    evaluation.reason = state.stopReason ?? "The runtime failed before producing an evaluable answer";
    return { attemptId: attempt.id, state, evaluation };
  }

  const containerUnavailable =
    Boolean(attempt.problem?.container_enabled) && (attempt.problem?.container?.url?.length ?? 0) === 0;
  if (containerUnavailable && state.status === "blocked") {
    evaluation.outcome = "infrastructure-error";
    evaluation.settled = false;
    delete evaluation.correct;
    evaluation.reason = "Arena container unavailable: the platform did not provide a service URL for remote verification";
    return { attemptId: attempt.id, state, evaluation };
  }

  if (state.status !== "completed" || !flag) {
    const abandoned = await client.abandon(attempt.id);
    evaluation.outcome = "abandoned";
    evaluation.settled = true;
    evaluation.correct = false;
    const platform = platformSummary(abandoned.attempt);
    if (platform) evaluation.platform = platform;
    evaluation.reason = !flag
      ? "No explicit FLAG line was produced; the attempt was automatically abandoned"
      : `Run status ${state.status} is not completed; the attempt was automatically abandoned`;
    return { attemptId: attempt.id, state, evaluation };
  }

  const submitted = await client.submit(attempt.id, flag);
  const correct = arenaSubmissionCorrect(submitted);
  if (correct === true) {
    evaluation.outcome = "solved";
    evaluation.settled = true;
    evaluation.correct = true;
    evaluation.submissionAttempts = previousRejectedCandidates.length + 1;
    const promoted = await new ExperienceStore(config.runtime.artifactRoot).promoteArenaSuccess(state);
    evaluation.run.promotedLessons = promoted.length;
    const platform = platformSummary(submitted.attempt);
    if (platform) evaluation.platform = platform;
    return { attemptId: attempt.id, state, evaluation };
  }

  if (previousRejectedCandidates.length + 1 < maxSubmissionAttempts) {
    const { seenAttemptIds: _seenAttemptIds, ...retryOptions } = options;
    return await solveArenaOnce(config, client, {
      ...retryOptions,
      previousRejectedCandidates: [...previousRejectedCandidates, flag],
      preparedAttachments: attachments,
      maxSubmissionAttempts,
    });
  }

  const abandoned = await client.abandon(attempt.id);
  evaluation.outcome = "wrong";
  evaluation.settled = true;
  evaluation.correct = false;
  evaluation.submissionAttempts = previousRejectedCandidates.length + 1;
  const platform = platformSummary(abandoned.attempt ?? submitted.attempt);
  if (platform) evaluation.platform = platform;
  evaluation.reason =
    correct === false
      ? "The submitted flag was rejected; the attempt was automatically abandoned so evaluation can continue"
      : "The platform did not return a solved verdict; the attempt was automatically abandoned";
  return { attemptId: attempt.id, state, evaluation };
}

export function buildArenaEvaluationReport(input: {
  startedAt: string;
  targetAttempts: number;
  config: AppConfig;
  attempts: ArenaAttemptEvaluation[];
  startAgent?: ArenaAgent;
  endAgent?: ArenaAgent;
  infrastructureError?: string;
}): ArenaEvaluationReport {
  const settled = input.attempts.filter((attempt) => attempt.settled);
  const correct = settled.filter((attempt) => attempt.correct === true).length;
  const incorrect = settled.length - correct;
  const accuracy = settled.length > 0 ? correct / settled.length : null;
  return {
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    model: {
      provider: input.config.model.provider,
      id: input.config.model.id,
      name: input.config.model.name,
    },
    targetAttempts: input.targetAttempts,
    evaluatedAttempts: settled.length,
    correct,
    incorrect,
    accuracy,
    accuracyPercent: accuracy === null ? null : Number((accuracy * 100).toFixed(2)),
    completed: settled.length >= input.targetAttempts,
    ...(input.startAgent === undefined ? {} : { startAgent: input.startAgent }),
    ...(input.endAgent === undefined ? {} : { endAgent: input.endAgent }),
    ...(input.infrastructureError === undefined ? {} : { infrastructureError: input.infrastructureError }),
    attempts: input.attempts,
  };
}

export async function writeArenaEvaluationReport(config: AppConfig, report: ArenaEvaluationReport): Promise<string> {
  const directory = join(config.runtime.artifactRoot, "..", "evaluations");
  await mkdir(directory, { recursive: true });
  const timestamp = report.startedAt.replace(/[:.]/g, "-");
  const path = join(directory, `nss-arena-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return path;
}

export function compactAttemptResult(evaluation: ArenaAttemptEvaluation): Record<string, unknown> {
  return {
    attempt: summarizeArenaAttempt({
      reused: evaluation.reused,
      attempt: {
        id: evaluation.attemptId,
        problem: {
          type_label: evaluation.category,
          ...(evaluation.problemRating === undefined ? {} : { rating: evaluation.problemRating }),
        },
      },
    }).attempt,
    outcome: evaluation.outcome,
    settled: evaluation.settled,
    correct: evaluation.correct,
    flagCandidateFound: evaluation.flagCandidateFound,
    submissionAttempts: evaluation.submissionAttempts,
    runCount: evaluation.runCount,
    attachmentCount: evaluation.attachmentCount,
    run: evaluation.run,
    platform: evaluation.platform,
    reason: evaluation.reason,
  };
}

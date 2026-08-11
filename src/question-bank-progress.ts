import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppConfig, RunState } from "./types.js";
import type { QuestionBankQuestion } from "./question-bank.js";

const MAX_PROGRESS_RECORDS = 500;
const MAX_ARTIFACT_SCAN = 1000;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_QUESTION_ID_LENGTH = 600;
const MAX_RUN_ID_LENGTH = 128;

export interface QuestionBankProgressRecord {
  questionId: string;
  fingerprint: string;
  solvedAt: string;
  runId: string;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isProgressRecord(value: unknown): value is QuestionBankProgressRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.questionId === "string" &&
    record.questionId.length > 0 &&
    record.questionId.length <= MAX_QUESTION_ID_LENGTH &&
    typeof record.fingerprint === "string" &&
    /^[a-f0-9]{64}$/i.test(record.fingerprint) &&
    typeof record.solvedAt === "string" &&
    record.solvedAt.length <= 40 &&
    Number.isFinite(Date.parse(record.solvedAt)) &&
    typeof record.runId === "string" &&
    record.runId.length > 0 &&
    record.runId.length <= MAX_RUN_ID_LENGTH
  );
}

function stateQuestionBankSuccess(value: unknown): { questionId: string; runId: string; solvedAt: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  const task = state.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return undefined;
  const metadata = (task as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const questionId = (metadata as Record<string, unknown>).questionId;
  if (
    state.status !== "completed" ||
    typeof state.submission !== "string" ||
    !state.submission.trim() ||
    (metadata as Record<string, unknown>).source !== "question-bank" ||
    typeof questionId !== "string" ||
    questionId.length === 0 ||
    questionId.length > MAX_QUESTION_ID_LENGTH
  ) {
    return undefined;
  }
  const runId = typeof state.id === "string" && state.id.length > 0 && state.id.length <= MAX_RUN_ID_LENGTH
    ? state.id
    : undefined;
  if (!runId) return undefined;
  const candidateTime = state.finishedAt ?? state.updatedAt ?? state.createdAt;
  const solvedAt = typeof candidateTime === "string" && candidateTime.length <= 40 && Number.isFinite(Date.parse(candidateTime))
    ? candidateTime
    : new Date(0).toISOString();
  return { questionId, runId, solvedAt };
}

function keyOf(questionId: string, fingerprint: string): string {
  return `${questionId}\u0000${fingerprint}`;
}

function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export class QuestionBankProgressStore {
  readonly path: string;
  private lock = Promise.resolve();
  private readonly scannedQuestionIds = new Set<string>();

  constructor(private readonly config: AppConfig) {
    this.path = resolve(config.runtime.artifactRoot, "..", "question-bank-progress.json");
  }

  async list(signal?: AbortSignal): Promise<QuestionBankProgressRecord[]> {
    return await this.serialized(async () => await this.read(signal));
  }

  async progressFor(
    questions: QuestionBankQuestion[],
    signal?: AbortSignal,
  ): Promise<Map<string, QuestionBankProgressRecord>> {
    const records = await this.list(signal);
    const byKey = new Map(records.map((record) => [keyOf(record.questionId, record.fingerprint), record]));
    return new Map(
      questions.flatMap((question) => {
        const record = byKey.get(keyOf(question.id, question.fingerprint));
        return record ? [[question.id, record] as const] : [];
      }),
    );
  }

  async pending(questions: QuestionBankQuestion[], signal?: AbortSignal): Promise<QuestionBankQuestion[]> {
    const solved = await this.progressFor(questions, signal);
    return questions.filter((question) => !solved.has(question.id));
  }

  async recordCompleted(question: QuestionBankQuestion, state: RunState, signal?: AbortSignal): Promise<boolean> {
    if (state.status !== "completed" || !state.submission?.trim()) return false;
    const solvedAt = state.finishedAt ?? state.updatedAt ?? new Date().toISOString();
    const recorded = await this.record({ questionId: question.id, fingerprint: question.fingerprint, solvedAt, runId: state.id }, signal);
    this.scannedQuestionIds.add(question.id);
    return recorded;
  }

  async syncCompletedRunArtifacts(questions: QuestionBankQuestion[], signal?: AbortSignal): Promise<number> {
    if (questions.length === 0) return 0;
    return await this.serialized(async () => {
      const questionsToScan = questions.filter((question) => !this.scannedQuestionIds.has(question.id));
      if (questionsToScan.length === 0) return 0;
      const records = await this.read(signal);
      const recordedIds = new Set(records.map((record) => record.questionId));
      const byId = new Map(questionsToScan.map((question) => [question.id, question]));
      let entries;
      try {
        entries = await readdir(this.config.runtime.artifactRoot, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) {
          for (const question of questionsToScan) this.scannedQuestionIds.add(question.id);
          return 0;
        }
        throw error;
      }
      const additions: QuestionBankProgressRecord[] = [];
      for (const entry of entries
        .filter((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_ARTIFACT_SCAN)) {
        assertNotAborted(signal);
        const statePath = join(this.config.runtime.artifactRoot, entry.name, "state.json");
        try {
          const stats = await lstat(statePath);
          if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STATE_BYTES) continue;
          const state = stateQuestionBankSuccess(JSON.parse(await readFile(statePath, "utf8")));
          if (!state || recordedIds.has(state.questionId)) continue;
          const question = byId.get(state.questionId);
          if (!question) continue;
          additions.push({
            questionId: question.id,
            fingerprint: question.fingerprint,
            solvedAt: state.solvedAt,
            runId: state.runId,
          });
          recordedIds.add(question.id);
        } catch {
          // A malformed or incomplete run artifact cannot prove a solved question.
        }
      }
      if (additions.length > 0) await this.write([...records, ...additions], signal);
      for (const question of questionsToScan) this.scannedQuestionIds.add(question.id);
      return additions.length;
    });
  }

  private async record(record: QuestionBankProgressRecord, signal?: AbortSignal): Promise<boolean> {
    return await this.serialized(async () => {
      assertNotAborted(signal);
      const records = await this.read(signal);
      const existing = records.find((candidate) => keyOf(candidate.questionId, candidate.fingerprint) === keyOf(record.questionId, record.fingerprint));
      if (existing) return false;
      await this.write([...records, record], signal);
      return true;
    });
  }

  private async read(signal?: AbortSignal): Promise<QuestionBankProgressRecord[]> {
    assertNotAborted(signal);
    let value: unknown;
    try {
      const stats = await lstat(this.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STATE_BYTES) return [];
      value = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return [];
      throw error;
    }
    const records = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { records?: unknown }).records
      : undefined;
    if (!Array.isArray(records)) return [];
    const seen = new Set<string>();
    return records
      .filter(isProgressRecord)
      .sort((left, right) => right.solvedAt.localeCompare(left.solvedAt))
      .filter((record) => {
        const key = keyOf(record.questionId, record.fingerprint);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_PROGRESS_RECORDS);
  }

  private async write(records: QuestionBankProgressRecord[], signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    const bounded = [...records]
      .filter(isProgressRecord)
      .sort((left, right) => right.solvedAt.localeCompare(left.solvedAt))
      .slice(0, MAX_PROGRESS_RECORDS);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.question-bank-progress-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ version: 1, records: bounded }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    assertNotAborted(signal);
    await rename(temporary, this.path);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: (() => void) | undefined;
    this.lock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

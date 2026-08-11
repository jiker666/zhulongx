import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ArenaAttemptEvaluation } from "./arena-evaluation.js";
import type { AppConfig, RunState } from "./types.js";

const MAX_WRONG_QUESTIONS = 200;
const MAX_FAILURE_HISTORY = 20;
const MAX_TASK_BYTES = 512 * 1024;

export interface ArenaWrongQuestionAttachment {
  name: string;
  path: string;
  size: number;
  sha256?: string;
}

export interface ArenaWrongQuestionFailure {
  failedAt: string;
  sourceRunId: string;
  outcome: "wrong" | "blocked" | "abandoned";
  reason: string;
  runStatus: RunState["status"];
  stopReason?: string;
  turns: number;
  toolCalls: number;
}

export interface ArenaWrongQuestionRecord {
  attemptId: number;
  category: string;
  status: "pending";
  firstFailedAt: string;
  lastFailedAt: string;
  failureCount: number;
  task: string;
  attachments: ArenaWrongQuestionAttachment[];
  failures: ArenaWrongQuestionFailure[];
}

export interface ArenaWrongQuestionSummary {
  attemptId: number;
  category: string;
  status: "pending";
  firstFailedAt: string;
  lastFailedAt: string;
  failureCount: number;
  attachmentCount: number;
  lastOutcome: "wrong" | "blocked" | "abandoned";
  lastReason: string;
}

function safeAttachmentName(source: string, index: number): string {
  const leaf = basename(source).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const bounded = leaf.replace(/^-+|-+$/g, "").slice(0, 180) || "attachment.bin";
  return `${String(index + 1).padStart(2, "0")}-${bounded}`;
}

function boundedText(value: string | undefined, maxLength: number): string {
  return (value ?? "").trim().slice(0, maxLength);
}

function scrubConfiguredSecrets(value: string, config: AppConfig): string {
  let result = value;
  const environmentNames = [
    config.model.apiKeyEnv,
    ...Object.values(config.model.headersFromEnv ?? {}),
    ...(config.arena ? [config.arena.tokenEnv] : []),
    config.server.tokenEnv,
  ];
  for (const environmentName of environmentNames) {
    const secret = process.env[environmentName];
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/(authorization|api[-_ ]?key|cookie|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
}

function summarize(record: ArenaWrongQuestionRecord): ArenaWrongQuestionSummary {
  const last = record.failures.at(-1);
  return {
    attemptId: record.attemptId,
    category: record.category,
    status: record.status,
    firstFailedAt: record.firstFailedAt,
    lastFailedAt: record.lastFailedAt,
    failureCount: record.failureCount,
    attachmentCount: record.attachments.length,
    lastOutcome: last?.outcome ?? "abandoned",
    lastReason: last?.reason ?? "No solution was produced",
  };
}

export class ArenaWrongQuestionStore {
  readonly directory: string;

  constructor(private readonly config: AppConfig) {
    this.directory = resolve(config.runtime.artifactRoot, "..", "wrong-questions");
  }

  private questionDirectory(attemptId: number): string {
    if (!Number.isInteger(attemptId) || attemptId <= 0) throw new Error("Invalid Arena attempt id");
    return join(this.directory, String(attemptId));
  }

  private recordPath(attemptId: number): string {
    return join(this.questionDirectory(attemptId), "record.json");
  }

  async record(state: RunState, evaluation: ArenaAttemptEvaluation): Promise<ArenaWrongQuestionRecord> {
    if (
      evaluation.outcome !== "wrong" &&
      evaluation.outcome !== "blocked" &&
      evaluation.outcome !== "abandoned"
    ) {
      throw new Error("Only wrong, blocked, or abandoned Arena attempts belong in the wrong-question store");
    }
    const questionDirectory = this.questionDirectory(evaluation.attemptId);
    const attachmentDirectory = join(questionDirectory, "attachments");
    await mkdir(attachmentDirectory, { recursive: true });

    const archivedAttachments: ArenaWrongQuestionAttachment[] = [];
    for (const [index, attachment] of state.task.attachments.slice(0, 20).entries()) {
      const source = resolve(attachment.source);
      const sourceStats = await lstat(source);
      if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
        throw new Error(`Wrong-question attachment is not a regular file: ${basename(source)}`);
      }
      const name = safeAttachmentName(source, index);
      const target = join(attachmentDirectory, name);
      const temporary = join(attachmentDirectory, `.${name}-${randomUUID()}.tmp`);
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o444);
      await rename(temporary, target);
      archivedAttachments.push({
        name,
        path: target,
        size: sourceStats.size,
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
      });
    }

    let existing: ArenaWrongQuestionRecord | undefined;
    try {
      existing = JSON.parse(await readFile(this.recordPath(evaluation.attemptId), "utf8")) as ArenaWrongQuestionRecord;
    } catch {
      // A missing or malformed record is replaced by the current platform-verified failure.
    }
    const failedAt = new Date().toISOString();
    const failure: ArenaWrongQuestionFailure = {
      failedAt,
      sourceRunId: state.id,
      outcome: evaluation.outcome,
      reason: boundedText(scrubConfiguredSecrets(evaluation.reason ?? "No solution was produced", this.config), 2000),
      runStatus: state.status,
      ...(state.stopReason
        ? { stopReason: boundedText(scrubConfiguredSecrets(state.stopReason, this.config), 1000) }
        : {}),
      turns: state.turns,
      toolCalls: state.toolCalls,
    };
    const record: ArenaWrongQuestionRecord = {
      attemptId: evaluation.attemptId,
      category: boundedText(evaluation.category, 80) || "unknown",
      status: "pending",
      firstFailedAt: existing?.firstFailedAt ?? failedAt,
      lastFailedAt: failedAt,
      failureCount: (existing?.failureCount ?? 0) + 1,
      task: boundedText(scrubConfiguredSecrets(state.task.task, this.config), MAX_TASK_BYTES),
      attachments: archivedAttachments.length > 0 ? archivedAttachments : (existing?.attachments ?? []),
      failures: [...(existing?.failures ?? []), failure].slice(-MAX_FAILURE_HISTORY),
    };
    const temporaryRecord = join(questionDirectory, `.record-${randomUUID()}.tmp`);
    await writeFile(temporaryRecord, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryRecord, this.recordPath(evaluation.attemptId));
    return record;
  }

  async get(attemptId: number): Promise<ArenaWrongQuestionRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(attemptId), "utf8")) as ArenaWrongQuestionRecord;
    } catch {
      return undefined;
    }
  }

  async list(limit = 50): Promise<ArenaWrongQuestionSummary[]> {
    await mkdir(this.directory, { recursive: true });
    const boundedLimit = Math.max(0, Math.min(Math.floor(limit), MAX_WRONG_QUESTIONS));
    const directories = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .slice(0, MAX_WRONG_QUESTIONS);
    const records: ArenaWrongQuestionRecord[] = [];
    for (const directory of directories) {
      try {
        records.push(JSON.parse(await readFile(join(this.directory, directory.name, "record.json"), "utf8")) as ArenaWrongQuestionRecord);
      } catch {
        // Reviewer-edited or partial records cannot poison the bounded library listing.
      }
    }
    return records
      .sort((left, right) => right.lastFailedAt.localeCompare(left.lastFailedAt))
      .slice(0, boundedLimit)
      .map(summarize);
  }
}

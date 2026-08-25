import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExperienceLesson, RunState } from "./types.js";

export type ExperienceStatus = "active" | "disabled";

export interface ExperienceRecord extends ExperienceLesson {
  sourceRunId: string;
  category: string;
  validation: "operator-validated";
  status: ExperienceStatus;
  promotedAt: string;
  reviewNote?: string;
  updatedAt?: string;
}

export interface ExperienceUpdate {
  status?: ExperienceStatus;
  reviewNote?: string;
  title?: string;
  applicableWhen?: string[];
  strategy?: string[];
  verification?: string[];
  pitfalls?: string[];
  tools?: string[];
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function scrubText(value: string, state?: RunState): string {
  let result = value
    .replace(/\b[A-Za-z][A-Za-z0-9_-]{1,63}\{[^{}\r\n]{1,448}\}/g, "[redacted-answer]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<identifier>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<address>")
    .replace(/\b(authorization|cookie|api[-_]?key|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(?:^|\s)\/(?:Users|home|workspace|data|tmp)\/[^\s,;]+/g, " <path>");
  const sensitiveMetadata = Object.entries(state?.task.metadata ?? {})
    .filter(([key]) => /(?:id|code|token|answer|submission)$/i.test(key))
    .map(([, metadataValue]) => metadataValue);
  const sensitiveValues = [state?.submission, ...sensitiveMetadata].filter(
    (item): item is string => Boolean(item && item.length >= 3),
  );
  for (const sensitive of sensitiveValues) result = result.split(sensitive).join("[redacted]");
  return result.trim().slice(0, 1000);
}

function scrubList(values: string[], state?: RunState, maxItems = 20): string[] {
  return values.map((value) => scrubText(value, state)).filter(Boolean).slice(0, maxItems);
}

function scrubLesson(lesson: ExperienceLesson, state?: RunState): ExperienceLesson {
  return {
    id: SAFE_ID.test(lesson.id) ? lesson.id : randomUUID(),
    title: scrubText(lesson.title, state).slice(0, 160),
    applicableWhen: scrubList(lesson.applicableWhen, state, 8),
    strategy: scrubList(lesson.strategy, state, 12),
    verification: scrubList(lesson.verification, state, 8),
    pitfalls: scrubList(lesson.pitfalls, state, 8),
    tools: scrubList(lesson.tools.map((tool) => basename(tool)), state, 20),
  };
}

export class ExperienceStore {
  readonly directory: string;

  constructor(artifactRoot: string) {
    this.directory = resolve(artifactRoot, "..", "experience");
  }

  private path(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("Invalid experience id");
    return join(this.directory, `${id}.json`);
  }

  async list(): Promise<ExperienceRecord[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((name) => SAFE_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"));
    const records: ExperienceRecord[] = [];
    for (const file of files) {
      try {
        records.push(JSON.parse(await readFile(join(this.directory, file), "utf8")) as ExperienceRecord);
      } catch {
        // A malformed reviewer-edited record is skipped instead of poisoning future prompts.
      }
    }
    return records.sort((left, right) => right.promotedAt.localeCompare(left.promotedAt));
  }

  async relevant(category: string | undefined, limit = 6): Promise<ExperienceRecord[]> {
    const normalizedCategory = category?.trim().toLowerCase();
    const active = (await this.list()).filter((record) => record.status === "active");
    const ranked = active.map((record) => {
      const categoryMatch = normalizedCategory && record.category.toLowerCase() === normalizedCategory ? 4 : 0;
      const text = [record.title, ...record.applicableWhen, ...record.tools].join(" ").toLowerCase();
      const mention = normalizedCategory && text.includes(normalizedCategory) ? 2 : 0;
      return { record, score: categoryMatch + mention };
    });
    ranked.sort((left, right) => right.score - left.score || right.record.promotedAt.localeCompare(left.record.promotedAt));
    return ranked
      .filter((item) => item.score > 0)
      .slice(0, Math.max(0, Math.min(limit, 12)))
      .map((item) => item.record);
  }

  async promoteValidatedLessons(state: RunState): Promise<ExperienceRecord[]> {
    await mkdir(this.directory, { recursive: true });
    const category = scrubText(state.task.metadata.category ?? "unknown", state).slice(0, 80) || "unknown";
    const records: ExperienceRecord[] = [];
    for (const candidate of state.lessons) {
      const lesson = scrubLesson(candidate, state);
      if (!lesson.title || lesson.applicableWhen.length === 0 || lesson.strategy.length === 0 || lesson.verification.length === 0) {
        continue;
      }
      const record: ExperienceRecord = {
        ...lesson,
        sourceRunId: state.id,
        category,
        validation: "operator-validated",
        status: "active",
        promotedAt: new Date().toISOString(),
      };
      await writeFile(this.path(record.id), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
      records.push(record);
    }
    return records;
  }

  async update(id: string, update: ExperienceUpdate): Promise<ExperienceRecord> {
    const path = this.path(id);
    const current = JSON.parse(await readFile(path, "utf8")) as ExperienceRecord;
    const next: ExperienceRecord = {
      ...current,
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.reviewNote === undefined ? {} : { reviewNote: scrubText(update.reviewNote) }),
      ...(update.title === undefined ? {} : { title: scrubText(update.title).slice(0, 160) }),
      ...(update.applicableWhen === undefined ? {} : { applicableWhen: scrubList(update.applicableWhen, undefined, 8) }),
      ...(update.strategy === undefined ? {} : { strategy: scrubList(update.strategy, undefined, 12) }),
      ...(update.verification === undefined ? {} : { verification: scrubList(update.verification, undefined, 8) }),
      ...(update.pitfalls === undefined ? {} : { pitfalls: scrubList(update.pitfalls, undefined, 8) }),
      ...(update.tools === undefined ? {} : { tools: scrubList(update.tools.map((tool) => basename(tool)), undefined, 20) }),
      updatedAt: new Date().toISOString(),
    };
    const temporary = join(this.directory, `.${id}-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
    return next;
  }
}

export function renderExperienceContext(records: ExperienceRecord[]): string {
  if (records.length === 0) return "";
  const lessons = records.map((record, index) =>
    [
      `Validated lesson ${index + 1} (${record.category}): ${record.title}`,
      `Applicable when: ${record.applicableWhen.join("; ")}`,
      `Strategy: ${record.strategy.join(" -> ")}`,
      `Verify with: ${record.verification.join("; ")}`,
      record.pitfalls.length ? `Avoid: ${record.pitfalls.join("; ")}` : "",
      record.tools.length ? `Useful tools: ${record.tools.join(", ")}` : "",
    ].filter(Boolean).join("\n"),
  );
  return [
    "VALIDATED GENERAL EXPERIENCE",
    "These lessons were promoted only after explicit operator validation. Treat them as heuristics, not facts; re-verify against current evidence.",
    lessons.join("\n\n"),
  ].join("\n");
}

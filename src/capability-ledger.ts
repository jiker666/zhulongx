import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState, TerminalReason } from "./types.js";

/**
 * Capability ledger, adapted from Tsecbench's dimension radar: one durable
 * record per settled run (category × model × outcome × terminal reason), a
 * fold into per-dimension solve rates and failure modes, and a bounded
 * context renderer that feeds the aggregate back into new runs of weak
 * dimensions. Statistics are category-level — never task-specific — so the
 * feedback stays general capability guidance.
 */

export interface CapabilityRecord {
  runId: string;
  category: string;
  status: RunState["status"];
  solved: boolean;
  turns: number;
  toolCalls: number;
  terminalReason?: TerminalReason;
  verificationVerdict?: "reproduced" | "contradicted" | "unverifiable";
  modelId?: string;
  recordedAt: string;
}

export interface DimensionStat {
  category: string;
  runs: number;
  solved: number;
  solveRate: number;
  avgTurns: number;
  avgTurnsSolved: number | null;
  avgTurnsUnsolved: number | null;
  /** Terminal reasons of unsolved runs, most frequent first. */
  failureModes: Array<{ reason: TerminalReason | "none"; count: number }>;
}

export interface CapabilityStats {
  total: number;
  solved: number;
  solveRate: number;
  dimensions: DimensionStat[];
  models: Array<{ modelId: string; runs: number; solved: number }>;
}

interface CapabilityState { version: 1; records: CapabilityRecord[]; }

const MAX_RECORDS = 2_000;
const MIN_RUNS_FOR_CONTEXT = 5;
const MAX_CONTEXT_CHARS = 900;

/** Generic bias guidance for recurring unsolved-terminal modes. */
const FAILURE_MODE_HINTS: Partial<Record<TerminalReason, string>> = {
  ended_without_finish: "reserve final turns for finish_task — a run that ends on its own counts as unsolved regardless of progress",
  agent_blocked: "when blocked, record the exact blocking observation early and finish blocked instead of looping on it",
  output_limit: "keep individual outputs small; page through large results instead of dumping them",
};

export function isSolvedState(state: Pick<RunState, "status" | "submission" | "submissionValidation" | "verificationVerdict">): boolean {
  if (state.status !== "completed") return false;
  if (!state.submission?.trim()) return false;
  if (state.submissionValidation?.status === "rejected") return false;
  if (state.verificationVerdict?.verdict === "contradicted") return false;
  return true;
}

function recordFromState(state: RunState): CapabilityRecord {
  return {
    runId: state.id,
    category: (state.task.metadata.category ?? "uncategorized").trim().toLowerCase().slice(0, 40) || "uncategorized",
    status: state.status,
    solved: isSolvedState(state),
    turns: Number.isSafeInteger(state.turns) ? state.turns : 0,
    toolCalls: Number.isSafeInteger(state.toolCalls) ? state.toolCalls : 0,
    ...(state.terminalReason ? { terminalReason: state.terminalReason } : {}),
    ...(state.verificationVerdict ? { verificationVerdict: state.verificationVerdict.verdict } : {}),
    ...(state.model ? { modelId: state.model.id.slice(0, 80) } : {}),
    recordedAt: state.finishedAt ?? state.updatedAt,
  };
}

export class CapabilityLedger {
  readonly path: string;
  private queue = Promise.resolve();

  constructor(root: string) {
    this.path = join(root, "capability-ledger.json");
  }

  /** Upsert one settled run; safe to call again for the same run id. */
  async record(state: RunState): Promise<CapabilityRecord> {
    const record = recordFromState(state);
    return await this.mutate((ledger) => {
      const existing = ledger.records.findIndex((item) => item.runId === record.runId);
      if (existing >= 0) ledger.records[existing] = record;
      else ledger.records.push(record);
      if (ledger.records.length > MAX_RECORDS) ledger.records.splice(0, ledger.records.length - MAX_RECORDS);
      return { dirty: true, result: record };
    });
  }

  async stats(): Promise<CapabilityStats> {
    const state = await this.load();
    return foldStats(state.records);
  }

  async records(): Promise<CapabilityRecord[]> {
    const state = await this.load();
    return [...state.records].sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
  }

  private async load(): Promise<CapabilityState> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CapabilityState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return { version: 1, records: [] };
      return { version: 1, records: parsed.records.filter((item) => item && typeof item.runId === "string" && typeof item.solved === "boolean") };
    } catch {
      return { version: 1, records: [] };
    }
  }

  private async mutate<T>(mutator: (state: CapabilityState) => { dirty: boolean; result: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const state = await this.load();
      const { dirty, result } = mutator(state);
      if (dirty) {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
          await rename(temporary, this.path);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      }
      return result;
    };
    const settled = this.queue.then(run, run);
    this.queue = settled.then(() => undefined, () => undefined);
    return await settled;
  }
}

export function foldStats(records: CapabilityRecord[]): CapabilityStats {
  const solved = records.filter((record) => record.solved).length;
  const byCategory = new Map<string, CapabilityRecord[]>();
  const byModel = new Map<string, { runs: number; solved: number }>();
  for (const record of records) {
    const bucket = byCategory.get(record.category) ?? [];
    bucket.push(record);
    byCategory.set(record.category, bucket);
    if (record.modelId) {
      const model = byModel.get(record.modelId) ?? { runs: 0, solved: 0 };
      model.runs += 1;
      if (record.solved) model.solved += 1;
      byModel.set(record.modelId, model);
    }
  }
  const dimensions = [...byCategory.entries()]
    .map(([category, bucket]): DimensionStat => {
      const bucketSolved = bucket.filter((record) => record.solved);
      const turns = (subset: CapabilityRecord[]) => (subset.length === 0 ? null : Math.round(subset.reduce((sum, record) => sum + record.turns, 0) / subset.length));
      const modes = new Map<TerminalReason | "none", number>();
      for (const record of bucket) {
        if (record.solved) continue;
        const key = record.terminalReason ?? "none";
        modes.set(key, (modes.get(key) ?? 0) + 1);
      }
      return {
        category,
        runs: bucket.length,
        solved: bucketSolved.length,
        solveRate: bucket.length === 0 ? 0 : Math.round((bucketSolved.length / bucket.length) * 100) / 100,
        avgTurns: turns(bucket) ?? 0,
        avgTurnsSolved: turns(bucketSolved),
        avgTurnsUnsolved: turns(bucket.filter((record) => !record.solved)),
        failureModes: [...modes.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 4),
      };
    })
    .sort((left, right) => right.runs - left.runs);
  return {
    total: records.length,
    solved,
    solveRate: records.length === 0 ? 0 : Math.round((solved / records.length) * 100) / 100,
    dimensions,
    models: [...byModel.entries()]
      .map(([modelId, model]) => ({ modelId, ...model }))
      .sort((left, right) => right.runs - left.runs)
      .slice(0, 8),
  };
}

/**
 * Bounded aggregate feedback for a new run in one category. Empty until the
 * dimension has enough history to mean anything; contents are category-level
 * statistics and generic mode guidance only.
 */
export function renderCapabilityContext(category: string | undefined, stats: CapabilityStats): string {
  if (!category) return "";
  const normalized = category.trim().toLowerCase();
  const dimension = stats.dimensions.find((item) => item.category === normalized);
  if (!dimension || dimension.runs < MIN_RUNS_FOR_CONTEXT) return "";
  const lines = [
    `CAPABILITY HISTORY (aggregate statistics over ${dimension.runs} past runs in this category — not task knowledge)`,
    `${normalized}: ${dimension.solved}/${dimension.runs} solved (${Math.round(dimension.solveRate * 100)}%); avg turns ${dimension.avgTurns}`
      + `${dimension.avgTurnsSolved !== null && dimension.avgTurnsUnsolved !== null ? ` (solved ~${dimension.avgTurnsSolved}, unsolved ~${dimension.avgTurnsUnsolved})` : ""}.`,
  ];
  const hints = dimension.failureModes
    .filter((mode): mode is { reason: TerminalReason; count: number } => mode.reason !== "none" && FAILURE_MODE_HINTS[mode.reason] !== undefined)
    .slice(0, 3)
    .map((mode) => `- ${mode.reason} ×${mode.count}: ${FAILURE_MODE_HINTS[mode.reason]}`);
  if (hints.length > 0) lines.push(`Recurring unsolved failure modes and bias guidance:`, ...hints);
  else if (dimension.failureModes.length > 0) {
    lines.push(`Recurring unsolved failure modes: ${dimension.failureModes.map((mode) => `${mode.reason} ×${mode.count}`).join(", ")}.`);
  }
  if (dimension.solveRate < 0.5) {
    lines.push("This dimension is historically weak: prefer breadth-first hypothesis pruning and early dead-end recording over deep single-path commitment.");
  }
  return lines.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

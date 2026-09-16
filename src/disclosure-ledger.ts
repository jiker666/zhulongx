import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeSensitiveText } from "./sanitize.js";

/**
 * Contamination disclosure ledger, borrowed from the Tsecbench public
 * cheat-disclosure wall: a run whose outcome is attributable to non-general
 * assets instead of harness capability gets a classified, timestamped
 * record served through a rolling window. Keeping the ledger public-by-API
 * (rather than private postmortem notes) is what makes capability claims
 * auditable across campaigns.
 */
export type DisclosureReason = "hardcoded_solution" | "targeted_method" | "external_memory";

export const DISCLOSURE_REASON_LABELS: Record<DisclosureReason, string> = {
  hardcoded_solution: "内置赛题信息和解法（flag、答案或解题材料在 run 之前就存在于提示词/附件/记忆中）",
  targeted_method: "非通用定向解法（方法只对本题实例有效，不构成对同类问题的能力）",
  external_memory: "违规使用外部历史记忆（答案知识来自本 run 证据链之外）",
};

export const DISCLOSURE_REASONS: readonly DisclosureReason[] = ["hardcoded_solution", "targeted_method", "external_memory"] as const;

export interface DisclosureRecord {
  id: string;
  runId?: string;
  taskId?: string;
  reason: DisclosureReason;
  detail: string;
  disclosedBy?: string;
  disclosedAt: string;
}

interface DisclosureState { version: 1; records: DisclosureRecord[]; }

export interface DisclosureLimits {
  maxRecords: number;
  maxDetailChars: number;
  defaultWindowDays: number;
}

const DEFAULT_LIMITS: DisclosureLimits = { maxRecords: 1_000, maxDetailChars: 2_000, defaultWindowDays: 90 };

export class DisclosureLedgerError extends Error {
  constructor(message: string, readonly status: number = 400) { super(message); }
}

function isDisclosureReason(value: unknown): value is DisclosureReason {
  return typeof value === "string" && (DISCLOSURE_REASONS as readonly string[]).includes(value);
}

export class DisclosureLedger {
  readonly path: string;
  readonly limits: DisclosureLimits;
  private queue = Promise.resolve();

  constructor(root: string, limits: Partial<DisclosureLimits> = {}) {
    this.path = join(root, "disclosures.json");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async disclose(input: Record<string, unknown>): Promise<DisclosureRecord> {
    const record = await this.mutate((state) => {
      const reason = input.reason;
      if (!isDisclosureReason(reason)) {
        throw new DisclosureLedgerError(`reason must be one of: ${DISCLOSURE_REASONS.join(", ")}`);
      }
      const detail = sanitizeSensitiveText(typeof input.detail === "string" ? input.detail.trim() : "").slice(0, this.limits.maxDetailChars);
      if (detail.length < 4) throw new DisclosureLedgerError("detail must describe the contamination evidence");
      const runId = typeof input.runId === "string" && input.runId.trim() ? input.runId.trim().slice(0, 64) : undefined;
      const taskId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim().slice(0, 128) : undefined;
      if (!runId && !taskId) throw new DisclosureLedgerError("runId or taskId is required");
      const disclosedBy = typeof input.disclosedBy === "string" && input.disclosedBy.trim() ? input.disclosedBy.trim().slice(0, 64) : undefined;
      const duplicate = state.records.find((item) => item.runId === runId && item.taskId === taskId && item.reason === reason && item.detail === detail);
      if (duplicate) return { dirty: false, result: duplicate };
      const record: DisclosureRecord = {
        id: randomUUID(),
        ...(runId ? { runId } : {}),
        ...(taskId ? { taskId } : {}),
        reason,
        detail,
        ...(disclosedBy ? { disclosedBy } : {}),
        disclosedAt: new Date().toISOString(),
      };
      state.records.push(record);
      if (state.records.length > this.limits.maxRecords) state.records.splice(0, state.records.length - this.limits.maxRecords);
      return { dirty: true, result: record };
    });
    return record;
  }

  /** Newest first, restricted to the rolling disclosure window. */
  async list(windowDays = this.limits.defaultWindowDays): Promise<{ windowDays: number; total: number; items: DisclosureRecord[] }> {
    const state = await this.load();
    const cutoff = windowDays >= 0 ? Date.now() - windowDays * 24 * 60 * 60 * 1_000 : Number.NEGATIVE_INFINITY;
    const items = state.records
      .filter((record) => Date.parse(record.disclosedAt) >= cutoff)
      .sort((a, b) => Date.parse(b.disclosedAt) - Date.parse(a.disclosedAt));
    return { windowDays, total: items.length, items };
  }

  async forRun(runId: string): Promise<DisclosureRecord[]> {
    const state = await this.load();
    return state.records.filter((record) => record.runId === runId);
  }

  private async load(): Promise<DisclosureState> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DisclosureState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return { version: 1, records: [] };
      return { version: 1, records: parsed.records.filter((item) => isDisclosureReason(item?.reason)) };
    } catch {
      return { version: 1, records: [] };
    }
  }

  private async mutate<T>(mutator: (state: DisclosureState) => { dirty: boolean; result: T }): Promise<T> {
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

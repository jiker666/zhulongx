import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuditChain } from "./audit.js";
import { sanitizeSecrets } from "./sanitize.js";
import { readAuditRecords } from "./trace.js";
import type { AuditRecord, RunState } from "./types.js";

const SAFE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set<RunState["status"]>(["queued", "running"]);
export const RESTART_RECOVERY_EVENT = "run.recovered_after_restart";
export const RESTART_RECOVERY_REASON = "Service restarted before the run settled; in-flight work was not replayed.";

export interface RunRecoveryResult {
  inspected: number;
  recovered: string[];
}

function recoveryRecord(records: AuditRecord[]): AuditRecord | undefined {
  return records.findLast((record) => record.type === RESTART_RECOVERY_EVENT);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(sanitizeSecrets(value), null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function recoveredState(state: RunState, record: AuditRecord): RunState {
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const reason = typeof data.reason === "string" ? data.reason : RESTART_RECOVERY_REASON;
  return {
    ...state,
    status: "aborted",
    phase: "done",
    updatedAt: record.timestamp,
    finishedAt: record.timestamp,
    stopReason: reason,
  };
}

export async function recoverInterruptedRuns(artifactRoot: string): Promise<RunRecoveryResult> {
  await mkdir(artifactRoot, { recursive: true });
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  const recovered: string[] = [];
  let inspected = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    const directory = join(artifactRoot, entry.name);
    const statePath = join(directory, "state.json");
    let state: RunState;
    try {
      state = JSON.parse(await readFile(statePath, "utf8")) as RunState;
    } catch {
      continue;
    }
    inspected += 1;
    if (!ACTIVE_STATUSES.has(state.status)) continue;

    const auditPath = join(directory, "audit.jsonl");
    let records: AuditRecord[] = [];
    try {
      records = await readAuditRecords(auditPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let record = recoveryRecord(records);
    if (!record) {
      record = await new AuditChain(auditPath, entry.name).append(RESTART_RECOVERY_EVENT, {
        previousStatus: state.status,
        status: "aborted",
        reason: RESTART_RECOVERY_REASON,
        recoveryPolicy: "no-replay",
      });
    }
    await writeJsonAtomic(statePath, recoveredState(state, record));
    recovered.push(entry.name);
  }
  return { inspected, recovered };
}

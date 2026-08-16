import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain, verifyAuditChain } from "../src/audit.js";
import { recoverInterruptedRuns, RESTART_RECOVERY_EVENT, RESTART_RECOVERY_REASON } from "../src/run-recovery.js";
import { readAuditRecords } from "../src/trace.js";
import type { RunState } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runningState(root: string, id: string): RunState {
  const now = "2026-08-12T01:00:00.000Z";
  return {
    id,
    status: "running",
    phase: "analysis",
    task: { task: "Inspect authorized evidence", attachments: [], metadata: {} },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: id,
    scratchRoot: join(root, "scratch", id),
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 2,
    toolCalls: 1,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

describe("run restart recovery", () => {
  it("settles an interrupted run without replaying work and only appends once", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-recovery-"));
    roots.push(root);
    const runId = "77777777-7777-4777-8777-777777777777";
    const runRoot = join(root, runId);
    const statePath = join(runRoot, "state.json");
    const auditPath = join(runRoot, "audit.jsonl");
    await mkdir(runRoot, { recursive: true });
    await writeFile(statePath, JSON.stringify(runningState(root, runId)), "utf8");
    const audit = new AuditChain(auditPath, runId);
    await audit.append("run.started", { status: "running" });
    await audit.append("tool.result", { toolName: "run_command", isError: false });

    expect(await recoverInterruptedRuns(root)).toEqual({ inspected: 1, recovered: [runId] });
    const state = JSON.parse(await readFile(statePath, "utf8")) as RunState;
    expect(state).toMatchObject({ status: "aborted", phase: "done", stopReason: RESTART_RECOVERY_REASON });
    expect(state.finishedAt).toBeTruthy();
    let records = await readAuditRecords(auditPath);
    expect(records).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({ sequence: 3, type: RESTART_RECOVERY_EVENT, data: { previousStatus: "running", status: "aborted", recoveryPolicy: "no-replay" } });
    expect(await verifyAuditChain(auditPath)).toEqual({ valid: true, records: 3 });

    // Simulate a second crash after the audit append but before state.json was replaced.
    await writeFile(statePath, JSON.stringify(runningState(root, runId)), "utf8");
    expect(await recoverInterruptedRuns(root)).toEqual({ inspected: 1, recovered: [runId] });
    records = await readAuditRecords(auditPath);
    expect(records).toHaveLength(3);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ status: "aborted", stopReason: RESTART_RECOVERY_REASON });

    expect(await recoverInterruptedRuns(root)).toEqual({ inspected: 1, recovered: [] });
  });
});

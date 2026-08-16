import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit.js";
import { prepareRunContinuation } from "../src/trace.js";
import type { RunState } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("run continuation", () => {
  it("builds a fork from the same append-only event stream at an exact boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-continuation-"));
    roots.push(root);
    const runId = "77777777-7777-4777-8777-777777777777";
    const runRoot = join(root, runId);
    await mkdir(runRoot, { recursive: true });
    const audit = new AuditChain(join(runRoot, "audit.jsonl"), runId);
    await audit.append("run.started", { task: "Inspect the local artifact" });
    await audit.append("context.injected", { sections: [{ name: "task" }] });
    await audit.append("tool.requested", { toolCallId: "call-1", toolName: "read_file", description: "Read evidence" }, { source: "model", correlationId: "call-1" });
    await audit.append("tool.result", { toolCallId: "call-1", toolName: "read_file", isError: false }, { source: "tool", correlationId: "call-1" });
    const now = new Date().toISOString();
    const state: RunState = {
      id: runId, status: "completed", phase: "done", task: { task: "Inspect the local artifact", attachments: [], metadata: { category: "Forensics" } },
      createdAt: now, updatedAt: now, finishedAt: now, findings: [], lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false,
      sandboxNamespace: runId, scratchRoot: join(root, "scratch"), workspaceMode: "configured", appliedExperienceIds: [], turns: 1, toolCalls: 1,
      imageObservations: 0, httpRequests: 0, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {},
    };
    await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");

    const fork = await prepareRunContinuation(root, runId, "fork", 3, "Try a different verified path");
    expect(fork.lineage).toMatchObject({ parentRunId: runId, boundarySequence: 3, mode: "fork", inheritedEventCount: 3 });
    expect(fork.lineage.context).toContain("#3 [model] 准备调用 · read_file");
    expect(fork.lineage.context).not.toContain("#4");
    expect(fork.request.metadata).toMatchObject({ parentRunId: runId, continuationMode: "fork", continuationBoundary: "3" });
    await expect(prepareRunContinuation(root, runId, "resume", 3)).rejects.toThrow("latest event");
  });
});

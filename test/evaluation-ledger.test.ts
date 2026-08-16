import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationLedger } from "../src/evaluation-ledger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("EvaluationLedger", () => {
  it("pins a reproducible environment and aggregates outcomes/errors/traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-eval-")); roots.push(root); const lock = join(root, "lock.json"); await writeFile(lock, "{\"version\":1}\n");
    const ledger = new EvaluationLedger(root); const manifest = await ledger.createManifest({ suite: "fixed-suite", datasetVersion: "v1", split: "validation", model: { provider: "faux", id: "faux-1", thinkingLevel: "off" }, budget: { maxAttempts: 2, maxRuntimeMsPerAttempt: 1_000, maxTokensPerAttempt: 100, maxCostMicrosPerAttempt: 1_000, networkAllowed: false }, artifactPaths: [lock], containerDigests: { sandbox: "sha256:abc" } });
    expect(manifest).toMatchObject({ datasetVersion: "v1", artifacts: [{ name: "lock.json", bytes: 14 }], budget: { networkAllowed: false } }); expect(manifest.manifestHash).toHaveLength(64);
    await ledger.record({ manifestId: manifest.id, taskId: "one", runId: "run-1", outcome: "success", durationMs: 100, tokensUsed: 50, costMicros: 20, toolCalls: 3, trace: { runArtifactId: "run:run-1", auditSha256: "a".repeat(64) } });
    await ledger.record({ manifestId: manifest.id, taskId: "two", runId: "run-2", outcome: "failed", durationMs: 300, tokensUsed: 70, costMicros: 30, toolCalls: 4, errorCode: "network", trace: { runArtifactId: "run:run-2" } });
    expect(await ledger.report(manifest.id)).toMatchObject({ attempts: 2, successes: 1, successRate: 0.5, errors: { network: 1 }, durationMs: { mean: 200 }, tokens: { total: 120, mean: 60 }, traceReferences: [{ runId: "run-1" }, { runId: "run-2" }] });
    await expect(ledger.record({ manifestId: manifest.id, taskId: "three", runId: "run-3", outcome: "success", durationMs: 1, tokensUsed: 1, costMicros: 1, toolCalls: 1, trace: { runArtifactId: "run:run-3" } })).rejects.toThrow("attempt budget");
  });

  it("rejects attempts beyond declared time/token/cost budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-eval-budget-")); roots.push(root); const ledger = new EvaluationLedger(root);
    const manifest = await ledger.createManifest({ suite: "bounded", datasetVersion: "v1", split: "hidden", model: { provider: "faux", id: "faux", thinkingLevel: "off" }, budget: { maxAttempts: 1, maxRuntimeMsPerAttempt: 10, maxTokensPerAttempt: 10, maxCostMicrosPerAttempt: 10, networkAllowed: false } });
    await expect(ledger.record({ manifestId: manifest.id, taskId: "task", runId: "run", outcome: "failed", durationMs: 11, tokensUsed: 0, costMicros: 0, toolCalls: 0, trace: { runArtifactId: "run:run" } })).rejects.toThrow("exceeded manifest budget");
  });

  it("lists bounded manifests and rejects invalid categorical fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-eval-list-")); roots.push(root); const ledger = new EvaluationLedger(root);
    await expect(ledger.createManifest({ suite: "bad", datasetVersion: "v1", split: "unknown" as never, model: { provider: "faux", id: "faux", thinkingLevel: "off" }, budget: { maxAttempts: 1, maxRuntimeMsPerAttempt: 10, maxTokensPerAttempt: 10, maxCostMicrosPerAttempt: 10, networkAllowed: false } })).rejects.toThrow("split");
    const manifest = await ledger.createManifest({ suite: "bounded", datasetVersion: "v1", split: "development", model: { provider: "faux", id: "faux", thinkingLevel: "off" }, budget: { maxAttempts: 1, maxRuntimeMsPerAttempt: 10, maxTokensPerAttempt: 10, maxCostMicrosPerAttempt: 10, networkAllowed: false } });
    expect(await ledger.listManifests(1)).toMatchObject([{ id: manifest.id }]);
    await expect(ledger.record({ manifestId: manifest.id, taskId: "task", runId: "run", outcome: "unknown" as never, durationMs: 1, tokensUsed: 1, costMicros: 1, toolCalls: 1, trace: { runArtifactId: "run:run" } })).rejects.toThrow("outcome");
  });
});

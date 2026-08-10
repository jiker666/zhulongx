import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { AuditChain } from "../../dist/audit.js";

export default async function globalSetup() {
  const frontendRoot = resolve(import.meta.dirname, "..");
  const projectRoot = resolve(frontendRoot, "..");
  const fixtureId = "33333333-3333-4333-8333-333333333333";
  const fixtureRoot = resolve(projectRoot, ".xuan-shu", "runs", fixtureId);
  await mkdir(fixtureRoot, { recursive: true });
  const now = "2026-08-10T00:00:00.000Z";
  const audit = new AuditChain(resolve(fixtureRoot, "audit.jsonl"), fixtureId);
  await audit.append("run.started", { model: { provider: "fixture", id: "fixture-model", api: "openai-responses" }, scope: { mode: "observe" } });
  await audit.append("plan.submitted", { goal: "Inspect the authorized fixture target", steps: [{ id: "step-1", objective: "Collect a bounded baseline" }] });
  await audit.append("policy.decision", { toolCallId: "act-fixture-1", toolName: "http_request", allowed: true, reason: "Within configured scope", signature: "fixture-signature" });
  await audit.append("tool.result", { toolCallId: "act-fixture-1", toolName: "http_request", isError: false, content: "Bounded response captured", details: { status: 200 } });
  await audit.append("hypothesis.updated", { updates: [{ id: "hyp-fixture-1", status: "supported", statement: "The response is reproducible" }] });
  await audit.append("finding.recorded", { id: "finding-fixture-1", title: "Reproducible response", severity: "info", evidence: ["ev-fixture-1"] });
  await audit.append("run.settled", { status: "completed", stopReason: "Fixture completed", turns: 1, toolCalls: 1, findings: 1, lessons: 0 });
  await audit.flush();
  const state = { id: fixtureId, status: "completed", phase: "done", task: { task: "Inspect the authorized fixture target", attachments: [], metadata: { category: "Web", target: "fixture.lab" } }, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now, findings: [{ id: "finding-fixture-1", title: "Reproducible response", severity: "info", confidence: 0.78, description: "Fixture finding", evidence: ["ev-fixture-1"] }], evidence: [{ id: "ev-fixture-1", summary: "Bounded response captured", source: "tool", lifecycle: "evaluated", actionIds: ["act-fixture-1"], hypothesisIds: ["hyp-fixture-1"], observationIds: [], createdAt: now, updatedAt: now }], lessons: [], hypotheses: [{ id: "hyp-fixture-1", statement: "The response is reproducible", status: "supported", evidence: ["ev-fixture-1"], updatedAt: now }], strategyRevisions: [], strategyRevisionRequired: false, sandboxNamespace: fixtureId, scratchRoot: resolve(projectRoot, ".xuan-shu", "work", fixtureId), appliedExperienceIds: [], turns: 1, toolCalls: 1, httpRequests: 1, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {} };
  await writeFile(resolve(fixtureRoot, "state.json"), JSON.stringify(state), "utf8");
  const liveFixtureId = "44444444-4444-4444-8444-444444444444";
  const liveFixtureRoot = resolve(projectRoot, ".xuan-shu", "runs", liveFixtureId);
  await mkdir(liveFixtureRoot, { recursive: true });
  const liveAudit = new AuditChain(resolve(liveFixtureRoot, "audit.jsonl"), liveFixtureId);
  await liveAudit.append("run.started", { model: { provider: "fixture", id: "live-fixture-model", api: "openai-responses" }, scope: { mode: "observe" } });
  await liveAudit.append("policy.decision", { toolCallId: "live-action-1", toolName: "http_request", allowed: true, reason: "Within configured scope", signature: "live-signature" });
  await writeFile(resolve(liveFixtureRoot, "state.json"), JSON.stringify({ id: liveFixtureId, status: "running", phase: "analysis", task: { task: "Observe a live authorized fixture", attachments: [], metadata: { category: "Web", target: "live.fixture.lab" } }, createdAt: now, updatedAt: now, startedAt: now, findings: [], evidence: [], lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false, sandboxNamespace: liveFixtureId, scratchRoot: resolve(projectRoot, ".xuan-shu", "work", liveFixtureId), appliedExperienceIds: [], turns: 1, toolCalls: 1, httpRequests: 1, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {} }), "utf8");
  let liveTimer = setTimeout(() => { void liveAudit.append("policy.decision", { toolCallId: "live-action-2", toolName: "read_file", allowed: false, reason: "A strategy-revision checkpoint is required", signature: "live-signature-2" }).then(() => liveAudit.append("finding.recorded", { id: "live-finding-1", title: "Live evidence arrived", severity: "info", evidence: ["live-evidence-1"] })); }, 1_200);
  const server = spawn(process.execPath, ["e2e/server.mjs"], { cwd: frontendRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:17318/health");
      if (response.ok) break;
    } catch { /* wait for the real server */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  try {
    const response = await fetch("http://127.0.0.1:17318/health");
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
  } catch (error) {
    server.kill();
    throw new Error(`E2E backend did not become ready: ${String(error)}${stderr ? `\n${stderr}` : ""}`);
  }
  return async () => {
    server.kill("SIGTERM");
    await once(server, "exit");
    clearTimeout(liveTimer);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(liveFixtureRoot, { recursive: true, force: true });
  };
}

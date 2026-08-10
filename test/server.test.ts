import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startApiServer } from "../src/server.js";
import { AuditChain } from "../src/audit.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.XUANSHU_TEST_SERVER_TOKEN;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("REST API", () => {
  it("exposes public health and protects run endpoints when configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    process.env.XUANSHU_TEST_SERVER_TOKEN = "test-token";
    const running = await startApiServer(config);
    try {
      const health = await fetch(`${running.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", service: "zhulong-xuanshu" });

      const dashboard = await fetch(`${running.url}/`);
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain("玄枢");

      const unauthorized = await fetch(`${running.url}/v1/runs/missing`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await running.close();
    }
  });

  it("streams persisted run events in order and resumes after Last-Event-ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-sse-")); roots.push(root); const config = testConfig(root); await mkdir(config.scope.workspaceRoot, { recursive: true });
    const runId = "11111111-1111-4111-8111-111111111111"; const runRoot = join(config.runtime.artifactRoot, runId); await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "state.json"), JSON.stringify({ id: runId, status: "completed" }), "utf8"); const audit = new AuditChain(join(runRoot, "audit.jsonl"), runId); await audit.append("run.started", { status: "running" }); await audit.append("policy.decision", { allowed: false, reason: "OUT_OF_SCOPE" });
    const running = await startApiServer(config);
    try {
      const response = await fetch(`${running.url}/v1/runs/${runId}/events`, { headers: { "Last-Event-ID": `${runId}:1` } });
      expect(response.status).toBe(200); const body = await response.text(); expect(body).toContain(`id: ${runId}:2`); expect(body).toContain("policy.decision"); expect(body).not.toContain("run.started");
    } finally { await running.close(); }
  });

  it("isolates streams by run and returns 404 for unknown runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-sse-isolation-")); roots.push(root); const config = testConfig(root); await mkdir(config.scope.workspaceRoot, { recursive: true }); const ids = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    for (const [index, runId] of ids.entries()) { const runRoot = join(config.runtime.artifactRoot, runId); await mkdir(runRoot, { recursive: true }); await writeFile(join(runRoot, "state.json"), JSON.stringify({ id: runId, status: "completed" }), "utf8"); const audit = new AuditChain(join(runRoot, "audit.jsonl"), runId); await audit.append("fixture.event", { marker: `run-${index}` }); }
    const running = await startApiServer(config);
    try { const response = await fetch(`${running.url}/v1/runs/${ids[0]}/events`); const body = await response.text(); expect(body).toContain("run-0"); expect(body).not.toContain("run-1"); expect((await fetch(`${running.url}/v1/runs/not-a-real-run/events`)).status).toBe(404); } finally { await running.close(); }
  });
});

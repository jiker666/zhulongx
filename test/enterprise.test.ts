import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnterpriseStore } from "../src/enterprise/store.js";
import { GuardStore } from "../src/enterprise/guard.js";
import { NotifyStore } from "../src/enterprise/notify.js";
import { enterpriseApi, type EnterpriseRoutesDeps } from "../src/enterprise/routes.js";
import type { PermissionGate, PermissionResolution } from "../src/permissions.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "enterprise-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

const autoApproveGate: PermissionGate = {
  authorize: async (input): Promise<PermissionResolution> => ({
    request: { id: "pr", sessionId: input.sessionId, toolCallId: input.toolCallId, toolName: input.toolName, summary: "", risk: input.risk.level, args: input.args, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() },
    decision: "approve_once", resolvedAt: new Date().toISOString(), source: "policy",
  }),
};

describe("enterprise store", () => {
  it("ingests a persisted run into the asset graph, exploration lineage, and coverage", async () => {
    const store = new EnterpriseStore(join(root, "assets.json"));
    await store.ingestRun({
      id: "run-1",
      task: { task: "授权目标:http://portal.corp.example.com/login 与 http://api.corp.example.com/v1/flag" },
      findings: [{ title: "VERIFIED_FLAG: flag{x}", text: "flag{x} read from /flag", evidence: ["cat /flag"] }],
      hypotheses: [{ statement: "登录可被绕过", status: "confirmed" }, { statement: "SSTI 在模板名", status: "open" }],
      httpRequests: 12,
    });
    const doc = await store.snapshot();
    expect(doc.companies.map((company) => company.name)).toContain("example.com"); // rootDomainOf keeps the last two labels
    expect(doc.assets.filter((asset) => asset.type === "root_domain")).toHaveLength(1);
    expect(doc.assets.filter((asset) => asset.type === "service")).toHaveLength(2);
    expect(doc.assets.filter((asset) => asset.type === "endpoint")).toHaveLength(2);
    expect(doc.assets.every((asset) => asset.companyId !== undefined && asset.runIds.includes("run-1"))).toBe(true);
    expect(doc.facts.length).toBeGreaterThan(0);
    expect(doc.intents.some((intent) => intent.text.includes("登录可被绕过") && intent.status === "done")).toBe(true);
    expect(doc.intents.some((intent) => intent.text.includes("SSTI") && intent.status === "open")).toBe(true);
    const overview = await store.overview();
    expect(overview).toMatchObject({ assets: { endpoints: 2, testedEndpoints: 2, coverage: 100 } });
    // Idempotent per run id.
    await store.ingestRun({ id: "run-1", task: { task: "" }, findings: [] });
    expect((await store.snapshot()).assets.filter((asset) => asset.type === "endpoint")).toHaveLength(2);
  });

  it("keeps the retest closed loop: fixed verdict flips finding status, reproduction reopens it", async () => {
    const store = new EnterpriseStore(join(root, "assets.json"));
    const finding = await store.addFinding({ name: "SQL注入 in /search", severity: "high", summary: "union select" });
    const retest = await store.addRetest(finding.id, "run-r1");
    expect(retest?.status).toBe("running");
    await expect(store.addRetest(finding.id)).resolves.toBeUndefined(); // one in flight
    await store.finishRetest(retest!.id, "fixed", "VERDICT: fixed");
    expect((await store.snapshot()).findings[0]!.status).toBe("fixed");
    await store.updateFinding(finding.id, { status: "resolved" });
    const second = await store.addRetest(finding.id, "run-r2");
    await store.finishRetest(second!.id, "reproduced", "复现成功");
    expect((await store.snapshot()).findings[0]!.status).toBe("confirmed");
  });
});

describe("enterprise guard", () => {
  it("denies matching calls, holds ask for operator resolution, and delegates the rest", async () => {
    const guard = new GuardStore(join(root, "guard.json"));
    await guard.addRule({ name: "block sqlmap", enabled: true, priority: 10, matchTarget: "tool_name", matchType: "string", pattern: "run_command", action: "deny", message: "禁止使用 run_command" });
    await guard.addRule({ name: "dangerous body", enabled: true, priority: 5, matchTarget: "tool_input", matchType: "regex", pattern: "DROP TABLE", action: "ask", message: "危险 SQL 需审批" });
    const gate = guard.wrap(autoApproveGate);
    const call = { sessionId: "s1", toolCallId: "t1", toolName: "run_command", args: {}, risk: { level: "execute" as const, summary: "", requiresApproval: false } };
    const denied = await gate.authorize(call);
    expect(denied.decision).toBe("deny");
    const askPromise = gate.authorize({ ...call, toolCallId: "t2", toolName: "http_request", args: { body: "DROP TABLE users" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = guard.listPending();
    expect(pending).toHaveLength(1);
    guard.resolvePending(pending[0]!.id, "approve");
    expect((await askPromise).decision).toBe("approve_once");
    const untouched = await gate.authorize({ ...call, toolCallId: "t3", toolName: "http_request", args: { url: "http://ok" } });
    expect(untouched.decision).toBe("approve_once");
    const audit = await guard.auditTrail(20);
    expect(audit.some((entry) => entry.action === "deny")).toBe(true);
    expect(audit.some((entry) => entry.action === "ask-approved")).toBe(true);
  });
});

describe("enterprise notify", () => {
  it("fans finding events to matching channels with IM payload shapes and retries", async () => {
    const deliveries: Array<{ url: string; body: unknown }> = [];
    let firstFail = true;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (firstFail) { firstFail = false; return new Response("boom", { status: 500 }); }
      deliveries.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const notify = new NotifyStore(join(root, "notify.json"), fetcher);
    await notify.upsertChannel({ name: "安全群", kind: "feishu", config: { webhook: "https://open.feishu.cn/hook/x" }, minSeverity: "medium" });
    const low = await notify.record("finding.created", { title: "低危", body: "info", severity: "low" });
    expect((await notify.snapshot()).deliveries.filter((delivery) => delivery.eventId === low.id)).toHaveLength(0); // filtered out
    const high = await notify.record("finding.created", { title: "高危SQL注入", body: "union select", severity: "high" });
    await notify.flush(); // first attempt fails
    await notify.flush(); // retry succeeds
    const snapshot = await notify.snapshot();
    const delivery = snapshot.deliveries.find((item) => item.eventId === high.id);
    expect(delivery?.status).toBe("delivered");
    expect(deliveries[0]?.body).toMatchObject({ msg_type: "text", content: { text: expect.stringContaining("高危SQL注入") } });
  });
});

describe("enterprise api routes", () => {
  function deps(store: EnterpriseStore, guard: GuardStore, notify: NotifyStore, runs: {
    started: Array<{ id: string; task: string }>;
    states: Record<string, { status: string; summary?: string }>;
  }): EnterpriseRoutesDeps {
    return {
      store, guard, notify,
      startRun: (task) => { const id = `retest-run-${runs.started.length + 1}`; runs.started.push({ id, task }); return id; },
      runStatus: async (runId) => runs.states[runId],
      persistedRuns: async () => [],
    };
  }

  it("creates findings, pushes status events, and closes the retest loop end to end", async () => {
    const store = new EnterpriseStore(join(root, "assets.json"));
    const guard = new GuardStore(join(root, "guard.json"));
    const notify = new NotifyStore(join(root, "notify.json"), (async () => new Response("ok")) as unknown as typeof fetch);
    const runs: { started: Array<{ id: string; task: string }>; states: Record<string, { status: string; summary?: string }> } = { started: [], states: {} };
    const api = deps(store, guard, notify, runs);

    const created = await enterpriseApi("POST", new URL("http://x/v1/enterprise/findings"), { name: "越权访问 /api/admin", severity: "high", summary: "水平越权" }, api);
    expect(created?.status).toBe(201);
    const findingId = (created?.body as { finding: { id: string } }).finding.id;
    expect((await notify.snapshot()).events[0]!.kind).toBe("finding.created");

    const patched = await enterpriseApi("PATCH", new URL(`http://x/v1/enterprise/findings/${findingId}`), { status: "confirmed" }, api);
    expect(patched?.status).toBe(200);
    expect((await notify.snapshot()).events.some((event) => event.kind === "finding.status")).toBe(true);

    const retest = await enterpriseApi("POST", new URL(`http://x/v1/enterprise/findings/${findingId}/retest`), {}, api);
    expect(retest?.status).toBe(202);
    expect(runs.started[0]!.task).toContain("VERDICT:");
    runs.states[runs.started[0]!.id] = { status: "completed", summary: "复测完成:VERDICT: fixed,不再复现" };
    await enterpriseApi("GET", new URL("http://x/v1/enterprise/findings"), undefined, api); // triggers refresh (async)
    for (let i = 0; i < 100 && (await store.snapshot()).retests[0]?.verdict !== "fixed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const doc = await store.snapshot();
    expect(doc.findings[0]!.status).toBe("fixed");
    expect(doc.retests[0]!.verdict).toBe("fixed");
    expect((await notify.snapshot()).events.some((event) => event.kind === "retest.verdict")).toBe(true);
  });

  it("validates guard rule creation and pending resolution through the API", async () => {
    const store = new EnterpriseStore(join(root, "assets.json"));
    const guard = new GuardStore(join(root, "guard.json"));
    const notify = new NotifyStore(join(root, "notify.json"), (async () => new Response("ok")) as unknown as typeof fetch);
    const api = deps(store, guard, notify, { started: [], states: {} });
    const bad = await enterpriseApi("POST", new URL("http://x/v1/enterprise/guard/rules"), { name: "x", pattern: "y", action: "maybe" }, api);
    expect(bad?.status).toBe(400);
    const good = await enterpriseApi("POST", new URL("http://x/v1/enterprise/guard/rules"), { name: "禁扫", pattern: "nmap", matchTarget: "tool_input", matchType: "string", action: "ask", message: "扫描需审批" }, api);
    expect(good?.status).toBe(201);
    const rules = await enterpriseApi("GET", new URL("http://x/v1/enterprise/guard/rules"), undefined, api);
    expect((rules?.body as { rules: unknown[] }).rules).toHaveLength(1);
    const missing = await enterpriseApi("POST", new URL("http://x/v1/enterprise/guard/pending/nope"), { decision: "approve" }, api);
    expect(missing?.status).toBe(404);
  });

  it("persists the enterprise document as valid bounded JSON", async () => {
    const store = new EnterpriseStore(join(root, "assets.json"));
    await store.ingestRun({ id: "r", task: { task: "http://a.b.com/x" }, findings: [{ title: "f" }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const raw = JSON.parse(await readFile(join(root, "assets.json"), "utf8"));
    expect(raw.schemaVersion).toBe(1);
    expect(Array.isArray(raw.assets)).toBe(true);
  });
});

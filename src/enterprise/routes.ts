import type { AssetType, EnterpriseStore, FindingStatus, RetestVerdict, Severity } from "./store.js";
import type { GuardStore } from "./guard.js";
import type { NotifyStore } from "./notify.js";

/**
 * Additive enterprise API surface (ARTEX-style). Pure request handler so
 * server.ts integrates it in ONE call; nothing here mutates existing routes.
 *
 *   GET  /v1/enterprise/overview            dashboard aggregate (+lazy run sync)
 *   GET  /v1/enterprise/assets              companies + asset tree + coverage
 *   POST /v1/enterprise/companies           { name }
 *   POST /v1/enterprise/assets              { type, key, companyId?, url?... }
 *   GET  /v1/enterprise/explorations        goals + intents (shared todo) + facts + edges
 *   POST /v1/enterprise/intents             { text, priority?, goal? }
 *   PATCH /v1/enterprise/intents/:id        { status, note?, deleteReason?, priority? }
 *   GET  /v1/enterprise/findings            findings + retests + evidence (auto-refresh)
 *   POST /v1/enterprise/findings            { name, severity?, summary?, evidence?, assetIds? }
 *   PATCH /v1/enterprise/findings/:id       { status?, severity?, name?, summary? }
 *   POST /v1/enterprise/findings/:id/retest launch an independent retest run
 *   *    /v1/enterprise/guard/...           rules CRUD + pending approve/deny + audit
 *   *    /v1/enterprise/notify/...          channels CRUD + test + events/deliveries
 */

export interface EnterpriseRoutesDeps {
  store: EnterpriseStore;
  guard: GuardStore;
  notify: NotifyStore;
  startRun: (task: string) => string | undefined;
  runStatus: (runId: string) => Promise<{ status?: string | undefined; summary?: string | undefined; writeup?: string | undefined } | undefined>;
  /** Recent persisted run states for lazy anchor ingestion; omitted disables sync. */
  persistedRuns?: () => Promise<Array<import("./store.js").PersistedRunLike>>;
}

const ASSET_TYPES = new Set<AssetType>(["root_domain", "ip", "subdomain", "app", "service", "endpoint"]);
const FINDING_STATUSES = new Set<FindingStatus>(["pending", "in_progress", "confirmed", "resolved", "fixed", "false_positive", "ignored", "duplicate", "risk_accepted"]);
const SEVERITIES = new Set<Severity>(["critical", "high", "medium", "low", ""]);
const INTENT_STATUSES = new Set(["open", "running", "paused", "done", "blocked", "deleted"]);

function reply(status: number, body: unknown): { status: number; body: unknown } { return { status, body }; }
function bad(message: string): { status: number; body: unknown } { return reply(400, { error: message }); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
  return value as Record<string, unknown>;
}
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/** Sync persisted runs into the asset/exploration graphs (idempotent per run). */
async function syncRuns(deps: EnterpriseRoutesDeps): Promise<number> {
  const runs = await deps.persistedRuns?.();
  if (!runs) return 0;
  for (const run of runs) await deps.store.ingestRun(run);
  return runs.length;
}

/** Refresh in-flight retests from their run state; parse the verdict and close the loop. */
async function refreshRetests(deps: EnterpriseRoutesDeps): Promise<void> {
  const doc = await deps.store.snapshot();
  for (const retest of doc.retests.filter((item) => item.status === "running" && item.runId)) {
    const state = await deps.runStatus(retest.runId!);
    if (!state || !state.status || ["running", "queued"].includes(state.status)) continue;
    if (state.status === "completed") {
      const text = `${state.summary ?? ""}\n${state.writeup ?? ""}`;
      let verdict: RetestVerdict = "inconclusive";
      if (/已修复|不再复现|无法复现|fixed|VERDICT[::=]?\s*fixed/i.test(text)) verdict = "fixed";
      else if (/复现成功|成功复现|仍可复现|reproduced|VERDICT[::=]?\s*reproduced/i.test(text)) verdict = "reproduced";
      const closed = await deps.store.finishRetest(retest.id, verdict, (state.summary ?? "").slice(0, 2_000));
      if (closed) await deps.notify.record("retest.verdict", {
        title: `复测结论:${closed.snapshot.name} → ${verdict === "fixed" ? "已修复" : verdict === "reproduced" ? "仍可复现" : "无法确认"}`,
        body: (state.summary ?? closed.snapshot.evidence).slice(0, 1_000),
        severity: closed.snapshot.severity || "low",
        snapshot: { findingId: closed.findingId, verdict },
      });
    } else {
      await deps.store.finishRetest(retest.id, "inconclusive", "", `retest run ended as ${state.status}`);
    }
  }
}

export async function enterpriseApi(method: string, url: URL, body: unknown, deps: EnterpriseRoutesDeps): Promise<{ status: number; body: unknown } | undefined> {
  const path = url.pathname.replace(/^\/v1\/enterprise/, "");
  try {
    if (path === "/overview" && method === "GET") {
      void syncRuns(deps).catch(() => undefined);
      return reply(200, { overview: await deps.store.overview(), guard: { rules: (await deps.guard.listRules()).length, pending: deps.guard.listPending().length } });
    }
    if (path === "/sync" && method === "POST") return reply(200, { synced: await syncRuns(deps) });
    if (path === "/assets" && method === "GET") {
      const doc = await deps.store.snapshot();
      return reply(200, { companies: doc.companies, assets: doc.assets, updatedAt: doc.updatedAt });
    }
    if (path === "/companies" && method === "POST") {
      const input = record(body);
      const name = stringField(input, "name");
      if (!name) return bad("name is required");
      return reply(201, { company: await deps.store.addCompany(name) });
    }
    if (path === "/assets" && method === "POST") {
      const input = record(body);
      const type = String(input.type ?? "") as AssetType;
      const key = stringField(input, "key");
      if (!ASSET_TYPES.has(type)) return bad("type must be one of root_domain|ip|subdomain|app|service|endpoint");
      if (!key) return bad("key is required");
      const companyId = stringField(input, "companyId");
      const url = stringField(input, "url");
      const method = stringField(input, "method");
      const domain = stringField(input, "domain");
      const title = stringField(input, "title");
      const runId = stringField(input, "runId");
      const asset = await deps.store.upsertAsset({
        type, key,
        ...(companyId ? { companyId } : {}), ...(url ? { url } : {}), ...(method ? { method } : {}),
        ...(domain ? { domain } : {}), ...(input.port !== undefined && Number.isFinite(Number(input.port)) ? { port: Number(input.port) } : {}),
        ...(title ? { title } : {}), ...(runId ? { runId } : {}),
        ...(Number.isFinite(Number(input.testedDelta)) ? { testedDelta: Number(input.testedDelta) } : {}),
      });
      return reply(201, { asset });
    }
    if (path === "/explorations" && method === "GET") {
      const doc = await deps.store.snapshot();
      return reply(200, { explorations: doc.explorations, intents: doc.intents, facts: doc.facts, edges: doc.edges, constraints: doc.constraints });
    }
    if (path === "/intents" && method === "POST") {
      const input = record(body);
      const text = stringField(input, "text");
      if (!text) return bad("text is required");
      const goal = stringField(input, "goal") ?? "安全运营队列";
      const exploration = await deps.store.ensureExploration(goal);
      const priority = input.priority === undefined ? undefined : Number(input.priority);
      const intent = await deps.store.addIntent({ explorationId: exploration.id, text, ...(priority !== undefined && Number.isFinite(priority) ? { priority } : {}), origin: "operator" });
      return reply(201, { intent });
    }
    const intentMatch = path.match(/^\/intents\/([A-Za-z0-9_-]+)$/);
    if (intentMatch?.[1] && method === "PATCH") {
      const input = record(body);
      const status = input.status === undefined ? undefined : String(input.status);
      if (status !== undefined && !INTENT_STATUSES.has(status)) return bad("invalid intent status");
      const intent = await deps.store.updateIntent(intentMatch[1], {
        ...(status ? { status: status as "open" | "running" | "paused" | "done" | "blocked" | "deleted" } : {}),
        ...(input.note !== undefined ? { note: String(input.note) } : {}),
        ...(input.deleteReason !== undefined ? { deleteReason: String(input.deleteReason) } : {}),
        ...(input.priority !== undefined ? { priority: Number(input.priority) } : {}),
      });
      return intent ? reply(200, { intent }) : reply(404, { error: "intent not found" });
    }
    if (path === "/findings" && method === "GET") {
      void refreshRetests(deps).catch(() => undefined);
      const doc = await deps.store.snapshot();
      return reply(200, {
        findings: doc.findings, retests: doc.retests.slice(-50).reverse(), evidence: doc.evidence.slice(-50).reverse(),
      });
    }
    if (path === "/findings" && method === "POST") {
      const input = record(body);
      const name = stringField(input, "name");
      if (!name) return bad("name is required");
      const severity = String(input.severity ?? "") as Severity;
      if (!SEVERITIES.has(severity)) return bad("severity must be critical|high|medium|low or empty");
      const finding = await deps.store.addFinding({
        name, severity, vulnclass: stringField(input, "vulnclass") ?? "", summary: input.summary === undefined ? "" : String(input.summary),
        evidence: input.evidence === undefined ? "" : String(input.evidence),
        assetIds: Array.isArray(input.assetIds) ? input.assetIds.filter((item): item is string => typeof item === "string") : [],
        ...(stringField(input, "worker") ? { worker: stringField(input, "worker") } : {}),
      });
      await deps.notify.record("finding.created", { title: `新漏洞:${finding.name}`, body: finding.summary || finding.evidence, severity: finding.severity, snapshot: { findingId: finding.id } });
      return reply(201, { finding });
    }
    const findingMatch = path.match(/^\/findings\/([A-Za-z0-9_-]+)$/);
    if (findingMatch?.[1] && method === "PATCH") {
      const input = record(body);
      const status = input.status === undefined ? undefined : String(input.status) as FindingStatus;
      if (status !== undefined && !FINDING_STATUSES.has(status)) return bad("invalid finding status");
      const before = (await deps.store.snapshot()).findings.find((item) => item.id === findingMatch[1])?.status;
      const finding = await deps.store.updateFinding(findingMatch[1], {
        ...(status ? { status } : {}),
        ...(input.severity !== undefined ? { severity: String(input.severity) as Severity } : {}),
        ...(input.name !== undefined ? { name: String(input.name) } : {}),
        ...(input.summary !== undefined ? { summary: String(input.summary) } : {}),
      });
      if (!finding) return reply(404, { error: "finding not found" });
      if (status && before && status !== before) await deps.notify.record("finding.status", { title: `漏洞状态:${finding.name} → ${status}`, body: finding.summary, severity: finding.severity, snapshot: { findingId: finding.id, status } });
      return reply(200, { finding });
    }
    const retestMatch = path.match(/^\/findings\/([A-Za-z0-9_-]+)\/retest$/);
    if (retestMatch?.[1] && method === "POST") {
      const doc = await deps.store.snapshot();
      const finding = doc.findings.find((item) => item.id === retestMatch[1]);
      if (!finding) return reply(404, { error: "finding not found" });
      const existing = doc.retests.find((item) => item.findingId === finding.id && (item.status === "pending" || item.status === "running"));
      if (existing) return reply(409, { error: "a retest is already in flight", retest: existing });
      const assets = doc.assets.filter((asset) => finding.assetIds.includes(asset.id));
      const task = [
        `# 漏洞复测任务(独立复测,不得沿用旧结论)`,
        `漏洞:${finding.name}(${finding.severity || "未分级"},当前状态 ${finding.status})`,
        `原始证据:${finding.evidence || finding.summary || "(见资产)"}`,
        assets.length > 0 ? `关联资产:${assets.map((asset) => asset.url ?? asset.key).join(", ")}` : "",
        ``,
        `要求:仅在明确授权范围内重新验证该漏洞当前是否仍可复现。独立重新执行验证步骤,禁止直接采信历史结论。`,
        `结束后在 finish_task 的 summary 中明确写出一行结论,格式必须是 VERDICT: reproduced(仍可复现)或 VERDICT: fixed(已修复);无法验证时写 VERDICT: inconclusive 并说明原因。`,
      ].filter(Boolean).join("\n");
      const runId = deps.startRun(task);
      const retest = await deps.store.addRetest(finding.id, runId);
      if (!retest) return reply(409, { error: "retest creation failed" });
      return reply(202, { retest, ...(runId ? { runId } : { note: "queued locally; attach a run via the retests API" }) });
    }
    if (path === "/guard/rules" && method === "GET") return reply(200, { rules: await deps.guard.listRules(), pending: deps.guard.listPending() });
    if (path === "/guard/rules" && method === "POST") {
      const input = record(body);
      const name = stringField(input, "name");
      const pattern = stringField(input, "pattern");
      const matchTarget = String(input.matchTarget ?? "tool_name");
      const matchType = String(input.matchType ?? "string");
      const action = String(input.action ?? "");
      if (!name || !pattern) return bad("name and pattern are required");
      if (!["tool_name", "tool_input"].includes(matchTarget)) return bad("matchTarget must be tool_name or tool_input");
      if (!["string", "regex"].includes(matchType)) return bad("matchType must be string or regex");
      if (!["allow", "deny", "ask"].includes(action)) return bad("action must be allow, deny, or ask");
      const rule = await deps.guard.addRule({
        name, pattern, matchTarget: matchTarget as "tool_name" | "tool_input", matchType: matchType as "string" | "regex",
        action: action as "allow" | "deny" | "ask", message: input.message === undefined ? "" : String(input.message),
        enabled: input.enabled === undefined ? true : Boolean(input.enabled), priority: input.priority === undefined ? 0 : Number(input.priority),
      });
      return reply(201, { rule });
    }
    const ruleMatch = path.match(/^\/guard\/rules\/([A-Za-z0-9_-]+)$/);
    if (ruleMatch?.[1] && method === "PATCH") {
      const input = record(body);
      const rule = await deps.guard.updateRule(ruleMatch[1], {
        ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
        ...(input.priority !== undefined ? { priority: Number(input.priority) } : {}),
        ...(input.message !== undefined ? { message: String(input.message) } : {}),
        ...(input.pattern !== undefined ? { pattern: String(input.pattern) } : {}),
        ...(input.action !== undefined ? { action: String(input.action) as "allow" | "deny" | "ask" } : {}),
      });
      return rule ? reply(200, { rule }) : reply(404, { error: "rule not found" });
    }
    if (ruleMatch?.[1] && method === "DELETE") {
      return (await deps.guard.removeRule(ruleMatch[1])) ? reply(200, { removed: true }) : reply(404, { error: "rule not found" });
    }
    if (path === "/guard/pending" && method === "GET") return reply(200, { pending: deps.guard.listPending() });
    const guardPendingMatch = path.match(/^\/guard\/pending\/([A-Za-z0-9_-]+)$/);
    if (guardPendingMatch?.[1] && method === "POST") {
      const input = record(body);
      const decision = String(input.decision ?? "");
      if (!["approve", "deny"].includes(decision)) return bad("decision must be approve or deny");
      return deps.guard.resolvePending(guardPendingMatch[1], decision as "approve" | "deny") ? reply(200, { resolved: true }) : reply(404, { error: "pending request not found" });
    }
    if (path === "/guard/audit" && method === "GET") return reply(200, { audit: await deps.guard.auditTrail(100) });
    if (path === "/notify/channels" && method === "GET") {
      const doc = await deps.notify.snapshot();
      return reply(200, { channels: doc.channels, events: doc.events.slice(-50).reverse(), deliveries: doc.deliveries.slice(-100).reverse() });
    }
    if (path === "/notify/channels" && method === "POST") {
      const input = record(body);
      const name = stringField(input, "name");
      const kind = String(input.kind ?? "");
      if (!name || !kind) return bad("name and kind are required");
      const config = input.config && typeof input.config === "object" && !Array.isArray(input.config) ? input.config as Record<string, unknown> : {};
      const channel = await deps.notify.upsertChannel({
        ...(input.id !== undefined ? { id: String(input.id) } : {}), name, kind: kind as "feishu" | "wecom" | "dingtalk" | "webhook",
        config, ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
        ...(input.mode !== undefined && ["realtime", "digest"].includes(String(input.mode)) ? { mode: String(input.mode) as "realtime" | "digest" } : {}),
        ...(input.minSeverity !== undefined && ["", "low", "medium", "high", "critical"].includes(String(input.minSeverity)) ? { minSeverity: String(input.minSeverity) as "" | "low" | "medium" | "high" | "critical" } : {}),
        ...(input.ratePerMin !== undefined ? { ratePerMin: Number(input.ratePerMin) } : {}),
      });
      return reply(201, { channel });
    }
    const channelTestMatch = path.match(/^\/notify\/channels\/([A-Za-z0-9_-]+)\/test$/);
    if (channelTestMatch?.[1] && method === "POST") {
      return reply(200, await deps.notify.testSend(channelTestMatch[1]));
    }
    const channelMatch = path.match(/^\/notify\/channels\/([A-Za-z0-9_-]+)$/);
    if (channelMatch?.[1] && method === "DELETE") {
      return (await deps.notify.removeChannel(channelMatch[1])) ? reply(200, { removed: true }) : reply(404, { error: "channel not found" });
    }
    return undefined;
  } catch (error) {
    return reply(400, { error: error instanceof Error ? error.message : String(error) });
  }
}

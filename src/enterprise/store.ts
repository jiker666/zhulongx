import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Enterprise security-ops layer (ARTEX-inspired, additive): a cross-RUN asset
 * graph (公司→域名→服务→接口), an exploration lineage (goal→intent→fact→
 * finding with anchors into assets), a finding lifecycle with independent
 * retests, and an evidence ledger. Everything persists as one bounded JSON
 * document under the orchestration root — same zero-dependency philosophy as
 * MemoryStore/CapabilityLedger; no database, no refactor of the run runtime.
 */

export type AssetType = "root_domain" | "ip" | "subdomain" | "app" | "service" | "endpoint";

export interface Company { id: string; name: string; createdAt: string; updatedAt: string }
export interface Asset {
  id: string; type: AssetType; companyId?: string | undefined; key: string;
  url?: string | undefined; method?: string | undefined; domain?: string | undefined; port?: number | undefined; title?: string | undefined;
  technologies: string[]; runIds: string[];
  firstSeenAt: string; lastSeenAt: string;
  /** Count of anchored test observations (HTTP exchanges / verified probes). */
  tested: number;
  findingCount: number;
}
export interface Exploration {
  id: string; goal: string; status: "open" | "achieved" | "failed";
  createdAt: string; updatedAt: string;
}
export interface Intent {
  id: string; explorationId: string; text: string; origin?: string; owner?: string;
  status: "open" | "running" | "paused" | "done" | "blocked" | "deleted";
  priority: number; note?: string; deleteReason?: string;
  createdAt: string; updatedAt: string; doneAt?: string;
}
export interface FactNode {
  id: string; explorationId: string; kind: "fact";
  text: string; state: "confirmed" | "dismissed";
  assetIds: string[]; evidence: string; runId?: string;
  createdAt: string;
}
export interface LineageEdge { explorationId: string; from: string; to: string; rel: "spawns" | "derived_from" | "yields" | "proves" }
export type FindingStatus = "pending" | "in_progress" | "confirmed" | "resolved" | "fixed" | "false_positive" | "ignored" | "duplicate" | "risk_accepted";
export type Severity = "critical" | "high" | "medium" | "low" | "";
export interface Finding {
  id: string; name: string; vulnclass: string; severity: Severity;
  summary: string; evidence: string; report?: string;
  assetIds: string[]; status: FindingStatus; runId?: string; worker?: string;
  createdAt: string; updatedAt: string;
}
export type RetestVerdict = "" | "reproduced" | "fixed" | "inconclusive";
export interface Retest {
  id: string; findingId: string; runId?: string;
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  verdict: RetestVerdict; summary: string; error: string; snapshot: { name: string; severity: Severity; evidence: string; assetIds: string[] };
  createdAt: string; startedAt?: string; finishedAt?: string;
}
export interface EvidenceItem {
  id: string; findingId?: string; runId?: string; kind: "http" | "tool" | "output" | "screenshot";
  summary: string; url?: string; method?: string; httpStatus?: number;
  sha256: string; capturedAt: string;
}
export interface Constraint { id: string; explorationId: string; kind: "allow" | "deny"; text: string; createdAt: string }

export interface EnterpriseDocument {
  schemaVersion: 1;
  companies: Company[];
  assets: Asset[];
  explorations: Exploration[];
  intents: Intent[];
  facts: FactNode[];
  edges: LineageEdge[];
  findings: Finding[];
  retests: Retest[];
  evidence: EvidenceItem[];
  constraints: Constraint[];
  ingestedRunIds: string[];
  updatedAt: string;
}

const BOUNDS = {
  companies: 256, assets: 5_000, explorations: 64, intents: 2_000, facts: 4_000,
  edges: 8_000, findings: 2_000, retests: 4_000, evidence: 8_000, constraints: 256, runs: 500,
};
const URL_IN_TASK = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;

function nowIso(): string { return new Date().toISOString(); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "asset"; }
export function rootDomainOf(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1] ?? "")) return hostname;
  return labels.slice(-2).join(".");
}

function emptyDocument(): EnterpriseDocument {
  return {
    schemaVersion: 1, companies: [], assets: [], explorations: [], intents: [], facts: [], edges: [],
    findings: [], retests: [], evidence: [], constraints: [], ingestedRunIds: [], updatedAt: nowIso(),
  };
}

export interface PersistedRunLike {
  id: string;
  task: { task: string };
  findings: Array<{ text?: string; title?: string; evidence?: string[] }>;
  hypotheses?: Array<{ statement: string; status?: string }>;
  httpRequests?: number;
  status?: string;
  createdAt?: string;
}

export class EnterpriseStore {
  private doc: EnterpriseDocument = emptyDocument();
  private writeChain: Promise<void> = Promise.resolve();
  private docReady = false;

  constructor(private readonly file: string) {}

  private async load(): Promise<EnterpriseDocument> {
    if (this.docReady) return this.doc;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<EnterpriseDocument>;
      this.doc = { ...emptyDocument(), ...parsed, schemaVersion: 1 };
    } catch { this.doc = emptyDocument(); }
    this.docReady = true;
    return this.doc;
  }

  private persist(): void {
    this.doc.updatedAt = nowIso();
    const snapshot = this.doc;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(join(this.file, ".."), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
        await rename(tmp, this.file);
      } catch { /* persistence failures must never fail the API surface */ }
    });
  }

  private async mutate(mutator: (doc: EnterpriseDocument) => void): Promise<void> {
    const doc = await this.load();
    mutator(doc);
    this.persist();
  }

  // ------------------------------------------------------------ companies/assets

  private ensureCompany(doc: EnterpriseDocument, name: string): Company {
    const slugName = slug(name);
    const existing = doc.companies.find((company) => slug(company.name) === slugName);
    if (existing) return existing;
    const company: Company = { id: `co_${randomUUID().slice(0, 8)}`, name, createdAt: nowIso(), updatedAt: nowIso() };
    doc.companies.push(company);
    doc.companies = doc.companies.slice(-BOUNDS.companies);
    return company;
  }

  /** Upsert by natural key (ARTEX unique-index semantics); links run lineage and testing counters. */
  async upsertAsset(input: {
    type: AssetType; key: string; companyId?: string | undefined; url?: string | undefined; method?: string | undefined;
    domain?: string | undefined; port?: number | undefined; title?: string | undefined; technologies?: string[] | undefined; runId?: string | undefined;
    testedDelta?: number | undefined; findingDelta?: number | undefined;
  }): Promise<Asset> {
    const doc = await this.load();
    let asset = doc.assets.find((item) => item.type === input.type && item.key === input.key);
    if (!asset) {
      asset = {
        id: `as_${randomUUID().slice(0, 8)}`, type: input.type, key: input.key,
        technologies: [], runIds: [], firstSeenAt: nowIso(), lastSeenAt: nowIso(), tested: 0, findingCount: 0,
      };
      doc.assets.push(asset);
      doc.assets = doc.assets.slice(-BOUNDS.assets);
    }
    asset.companyId = input.companyId ?? asset.companyId;
    asset.url = input.url ?? asset.url;
    asset.method = input.method ?? asset.method;
    asset.domain = input.domain ?? asset.domain;
    asset.port = input.port ?? asset.port;
    asset.title = input.title ?? asset.title;
    for (const technology of input.technologies ?? []) if (!asset.technologies.includes(technology)) asset.technologies.push(technology);
    if (input.runId && !asset.runIds.includes(input.runId)) asset.runIds.push(input.runId);
    asset.tested += input.testedDelta ?? 0;
    asset.findingCount += input.findingDelta ?? 0;
    asset.lastSeenAt = nowIso();
    this.persist();
    return asset;
  }

  /** Operator-authored company entry (manual asset registration); slug-deduped. */
  async addCompany(name: string): Promise<Company> {
    const doc = await this.load();
    const company = this.ensureCompany(doc, name.trim().slice(0, 120));
    this.persist();
    return company;
  }

  // ------------------------------------------------------------ exploration

  async ensureExploration(goal: string): Promise<Exploration> {
    const doc = await this.load();
    const existing = doc.explorations.find((item) => item.goal === goal && item.status === "open");
    if (existing) return existing;
    const exploration: Exploration = { id: `ex_${randomUUID().slice(0, 8)}`, goal, status: "open", createdAt: nowIso(), updatedAt: nowIso() };
    doc.explorations.push(exploration);
    doc.explorations = doc.explorations.slice(-BOUNDS.explorations);
    this.persist();
    return exploration;
  }

  async addIntent(input: { explorationId: string; text: string; priority?: number | undefined; origin?: string | undefined; owner?: string | undefined }): Promise<Intent> {
    const intent: Intent = {
      id: `in_${randomUUID().slice(0, 8)}`, explorationId: input.explorationId, text: input.text.slice(0, 600),
      status: "open", priority: input.priority ?? 0,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    await this.mutate((doc) => {
      doc.intents.push(intent);
      doc.intents = doc.intents.slice(-BOUNDS.intents);
    });
    return intent;
  }

  async updateIntent(id: string, patch: { status?: Intent["status"] | undefined; note?: string | undefined; deleteReason?: string | undefined; priority?: number | undefined }): Promise<Intent | undefined> {
    const doc = await this.load();
    const intent = doc.intents.find((item) => item.id === id);
    if (!intent) return undefined;
    if (patch.status) { intent.status = patch.status; if (patch.status === "done") intent.doneAt = nowIso(); }
    if (patch.note !== undefined) intent.note = patch.note.slice(0, 600);
    if (patch.deleteReason !== undefined) intent.deleteReason = patch.deleteReason.slice(0, 300);
    if (patch.priority !== undefined) intent.priority = patch.priority;
    intent.updatedAt = nowIso();
    this.persist();
    return intent;
  }

  async addFact(input: { explorationId: string; text: string; assetIds?: string[] | undefined; evidence?: string | undefined; runId?: string | undefined }): Promise<FactNode> {
    const fact: FactNode = {
      id: `fa_${randomUUID().slice(0, 8)}`, explorationId: input.explorationId, kind: "fact",
      text: input.text.slice(0, 600), state: "confirmed", assetIds: (input.assetIds ?? []).slice(0, 16),
      evidence: (input.evidence ?? "").slice(0, 600),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      createdAt: nowIso(),
    };
    await this.mutate((doc) => {
      doc.facts.push(fact);
      doc.facts = doc.facts.slice(-BOUNDS.facts);
      doc.edges.push({ explorationId: input.explorationId, from: input.explorationId, to: fact.id, rel: "yields" });
      doc.edges = doc.edges.slice(-BOUNDS.edges);
    });
    return fact;
  }

  // ------------------------------------------------------------ findings/retests

  async addFinding(input: { name: string; vulnclass?: string | undefined; severity?: Severity | undefined; summary?: string | undefined; evidence?: string | undefined; assetIds?: string[] | undefined; runId?: string | undefined; worker?: string | undefined }): Promise<Finding> {
    const doc = await this.load();
    const finding: Finding = {
      id: `fi_${randomUUID().slice(0, 8)}`, name: input.name.slice(0, 200), vulnclass: (input.vulnclass ?? "").slice(0, 60),
      severity: input.severity ?? "", summary: (input.summary ?? "").slice(0, 2_000), evidence: (input.evidence ?? "").slice(0, 4_000),
      assetIds: (input.assetIds ?? []).slice(0, 16), status: "pending",
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.worker !== undefined ? { worker: input.worker } : {}),
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    doc.findings.push(finding);
    doc.findings = doc.findings.slice(-BOUNDS.findings);
    for (const assetId of finding.assetIds) {
      const asset = doc.assets.find((item) => item.id === assetId);
      if (asset) asset.findingCount += 1;
    }
    this.persist();
    return finding;
  }

  async updateFinding(id: string, patch: { status?: FindingStatus; severity?: Severity; name?: string; summary?: string }): Promise<Finding | undefined> {
    const doc = await this.load();
    const finding = doc.findings.find((item) => item.id === id);
    if (!finding) return undefined;
    if (patch.status) finding.status = patch.status;
    if (patch.severity !== undefined) finding.severity = patch.severity;
    if (patch.name) finding.name = patch.name.slice(0, 200);
    if (patch.summary !== undefined) finding.summary = patch.summary.slice(0, 2_000);
    finding.updatedAt = nowIso();
    this.persist();
    return finding;
  }

  async addRetest(findingId: string, runId?: string): Promise<Retest | undefined> {
    const doc = await this.load();
    const finding = doc.findings.find((item) => item.id === findingId);
    if (!finding) return undefined;
    if (doc.retests.some((item) => item.findingId === findingId && (item.status === "pending" || item.status === "running"))) return undefined;
    const retest: Retest = {
      id: `rt_${randomUUID().slice(0, 8)}`, findingId, status: runId ? "running" : "pending", verdict: "",
      summary: "", error: "", snapshot: { name: finding.name, severity: finding.severity, evidence: finding.evidence, assetIds: finding.assetIds },
      createdAt: nowIso(),
      ...(runId ? { runId, startedAt: nowIso() } : {}),
    };
    doc.retests.push(retest);
    doc.retests = doc.retests.slice(-BOUNDS.retests);
    this.persist();
    return retest;
  }

  async finishRetest(retestId: string, verdict: RetestVerdict, summary: string, error = ""): Promise<Retest | undefined> {
    const doc = await this.load();
    const retest = doc.retests.find((item) => item.id === retestId);
    if (!retest) return undefined;
    retest.status = "completed";
    retest.verdict = verdict || "inconclusive";
    retest.summary = summary.slice(0, 2_000);
    retest.error = error.slice(0, 600);
    retest.finishedAt = nowIso();
    // ARTEX closed loop: a fixed verdict moves the finding to "fixed", a
    // reproduction moves it back to "confirmed".
    const finding = doc.findings.find((item) => item.id === retest.findingId);
    if (finding && verdict === "fixed") finding.status = "fixed";
    if (finding && verdict === "reproduced" && ["fixed", "resolved", "false_positive", "risk_accepted"].includes(finding.status)) finding.status = "confirmed";
    if (finding) finding.updatedAt = nowIso();
    this.persist();
    return retest;
  }

  // ------------------------------------------------------------ run ingestion

  /**
   * Anchor-first ingestion (ARTEX lesson): every discovered target becomes an
   * asset; run findings become anchored facts; hypotheses become planner
   * intents. Idempotent per run id, bounded, retroactive over persisted runs.
   */
  async ingestRun(run: PersistedRunLike): Promise<void> {
    const doc = await this.load();
    if (doc.ingestedRunIds.includes(run.id)) return;
    const urls = [...new Set((run.task.task.match(URL_IN_TASK) ?? []).map((url) => url.replace(/[),.;'"]+$/, "")))].slice(0, 24);
    const assetIds: string[] = [];
    await this.mutate((document) => {
      document.ingestedRunIds.push(run.id);
      document.ingestedRunIds = document.ingestedRunIds.slice(-BOUNDS.runs);
    });
    for (const url of urls) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { continue; }
      const root = rootDomainOf(parsed.hostname);
      const company = this.ensureCompany(await this.load(), root);
      const rootAsset = await this.upsertAsset({ type: "root_domain", key: root, companyId: company.id, domain: root, runId: run.id });
      const base = `${parsed.protocol}//${parsed.host}`;
      const service = await this.upsertAsset({ type: "service", key: base, companyId: company.id, url: base, domain: parsed.hostname, ...(parsed.port ? { port: Number(parsed.port) } : {}), runId: run.id });
      const endpointKey = `${parsed.pathname}${parsed.search}`;
      const endpoint = await this.upsertAsset({
        type: "endpoint", key: `${base}${endpointKey}`, companyId: company.id, url: `${base}${endpointKey}`,
        method: "GET", domain: parsed.hostname, runId: run.id, testedDelta: run.httpRequests && run.httpRequests > 0 ? 1 : 0,
      });
      assetIds.push(rootAsset.id, service.id, endpoint.id);
      void rootAsset;
    }
    if (assetIds.length === 0 && run.findings.length === 0) return;
    const exploration = await this.ensureExploration(`调查:${urls[0] ?? run.id}`);
    for (const finding of run.findings.slice(0, 20)) {
      const text = String(finding.title ?? finding.text ?? "").trim();
      if (!text) continue;
      await this.addFact({ explorationId: exploration.id, text, assetIds: assetIds.slice(-1), runId: run.id, evidence: (finding.evidence ?? []).join(" | ").slice(0, 600) });
    }
    for (const hypothesis of (run.hypotheses ?? []).slice(0, 12)) {
      if (!hypothesis.statement?.trim()) continue;
      const status = hypothesis.status === "confirmed" ? "done" : hypothesis.status === "rejected" ? "deleted" : "open";
      const intent = await this.addIntent({ explorationId: exploration.id, text: `假设:${hypothesis.statement.slice(0, 400)}`, priority: 5, origin: `run:${run.id}` });
      if (status !== "open") await this.updateIntent(intent.id, { status, ...(status === "deleted" ? { deleteReason: "假设被证伪" } : {}) });
    }
  }

  // ------------------------------------------------------------ projections

  async overview(): Promise<Record<string, unknown>> {
    const doc = await this.load();
    const byType: Record<string, number> = {};
    for (const asset of doc.assets) byType[asset.type] = (byType[asset.type] ?? 0) + 1;
    const endpoints = doc.assets.filter((asset) => asset.type === "endpoint");
    const tested = endpoints.filter((asset) => asset.tested > 0);
    const findingsBySeverity: Record<string, number> = {};
    const findingsByStatus: Record<string, number> = {};
    for (const finding of doc.findings) {
      findingsBySeverity[finding.severity || "未分级"] = (findingsBySeverity[finding.severity || "未分级"] ?? 0) + 1;
      findingsByStatus[finding.status] = (findingsByStatus[finding.status] ?? 0) + 1;
    }
    return {
      updatedAt: doc.updatedAt,
      assets: { total: doc.assets.length, byType, endpoints: endpoints.length, testedEndpoints: tested.length, coverage: endpoints.length === 0 ? 0 : Math.round((tested.length / endpoints.length) * 100) },
      explorations: { total: doc.explorations.length, openIntents: doc.intents.filter((intent) => intent.status === "open" || intent.status === "running").length },
      findings: { total: doc.findings.length, bySeverity: findingsBySeverity, byStatus: findingsByStatus, retests: doc.retests.length },
      evidence: doc.evidence.length,
      ingestedRuns: doc.ingestedRunIds.length,
    };
  }

  async snapshot(): Promise<EnterpriseDocument> { return await this.load(); }
}

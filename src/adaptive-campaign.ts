import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeSensitiveText } from "./sanitize.js";
import { SharedEvidenceBoard, type SharedEvidenceEntry, type SharedEvidenceKind } from "./shared-evidence.js";
import type { RunState, TaskRequest } from "./types.js";

export type AdaptiveCampaignStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type CampaignWorkStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type CampaignTier = 0 | 1 | 2 | 3;

export interface CampaignTierPolicy {
  tier: CampaignTier;
  label: string;
  maxAttempts: number;
  hintAfterTier?: CampaignTier;
}

export interface AdaptiveCampaignBudget {
  maxRuntimeMs: number;
  maxWorkers: number;
  maxItems: number;
  maxRuns: number;
}

export interface CampaignWorkItem {
  id: string;
  campaignId: string;
  rootIndex: number;
  lane: number;
  parentItemId?: string;
  tier: CampaignTier;
  task: TaskRequest;
  status: CampaignWorkStatus;
  attempts: number;
  leaseGeneration: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  runId?: string;
  summary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CampaignCuration {
  id: string;
  itemId: string;
  runId?: string;
  summary: string;
  evidenceIds: string[];
  proposedTasks: string[];
  createdAt: string;
}

export interface CampaignEvent {
  sequence: number;
  id: string;
  campaignId: string;
  itemId?: string;
  runId?: string;
  type: string;
  detail?: string;
  data?: unknown;
  createdAt: string;
}

export interface AdaptiveCampaignRecord {
  id: string;
  name: string;
  status: AdaptiveCampaignStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  concurrency: number;
  raceAgents: number;
  budget: AdaptiveCampaignBudget;
  tiers: CampaignTierPolicy[];
  items: CampaignWorkItem[];
  evidence: SharedEvidenceEntry[];
  curation: CampaignCuration[];
  events: CampaignEvent[];
  runsStarted: number;
  verifiedRuns: number;
  error?: string;
}

export interface AdaptiveCampaignSnapshot extends AdaptiveCampaignRecord {
  queued: number;
  running: number;
  succeeded: number;
  blocked: number;
  failed: number;
  currentTier: CampaignTier;
}

export interface AdaptiveCampaignStartInput {
  name?: string;
  tasks: Array<TaskRequest | string>;
  concurrency?: number;
  raceAgents?: number;
  budget?: Partial<AdaptiveCampaignBudget>;
  tiers?: CampaignTierPolicy[];
  hints?: Partial<Record<CampaignTier, string>>;
}

export interface AdaptiveCampaignStoreLimits {
  maxCampaigns: number;
  maxItems: number;
  maxEvidence: number;
  maxCuration: number;
  maxEvents: number;
  maxTextChars: number;
}

export interface AdaptiveCampaignStoreState {
  version: 1;
  campaigns: AdaptiveCampaignRecord[];
}

const DEFAULT_LIMITS: AdaptiveCampaignStoreLimits = {
  maxCampaigns: 32,
  maxItems: 512,
  maxEvidence: 256,
  maxCuration: 128,
  maxEvents: 4_096,
  maxTextChars: 12_000,
};

export const DEFAULT_CAMPAIGN_TIERS: CampaignTierPolicy[] = [
  { tier: 0, label: "广度勘察", maxAttempts: 1 },
  { tier: 1, label: "重点分析", maxAttempts: 1 },
  { tier: 2, label: "独立验证", maxAttempts: 1, hintAfterTier: 2 },
  { tier: 3, label: "恢复与收敛", maxAttempts: 1, hintAfterTier: 3 },
];

const TERMINAL = new Set<CampaignWorkStatus>(["succeeded", "failed", "blocked", "cancelled"]);

function now(): string { return new Date().toISOString(); }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bounded(value: string, limit: number): string {
  const sanitized = sanitizeSensitiveText(String(value).replace(/\s+/g, " ").trim());
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, Math.max(0, limit - 12))} [truncated]`;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const candidate = value === undefined ? fallback : value;
  positive(candidate, label);
  return Math.min(candidate, maximum);
}

function sanitizeRequest(input: TaskRequest, maxTextChars: number): TaskRequest {
  if (typeof input.task !== "string" || !input.task.trim()) throw new Error("Campaign task must not be empty");
  const metadata = input.metadata
    ? Object.fromEntries(Object.entries(input.metadata).slice(0, 24).map(([key, value]) => [bounded(key, 80), bounded(value, 400)]))
    : undefined;
  const scope = input.scope
    ? {
        ...(input.scope.mode ? { mode: input.scope.mode } : {}),
        ...(input.scope.workspaceRoot ? { workspaceRoot: bounded(input.scope.workspaceRoot, 500) } : {}),
        ...(input.scope.allowedHosts ? { allowedHosts: input.scope.allowedHosts.slice(0, 64).map((item) => bounded(item, 300)) } : {}),
        ...(input.scope.allowedPrograms ? { allowedPrograms: input.scope.allowedPrograms.slice(0, 64).map((item) => bounded(item, 120)) } : {}),
      }
    : undefined;
  return {
    task: bounded(input.task, maxTextChars),
    ...(input.attachments ? { attachments: input.attachments.slice(0, 20).map((item) => bounded(item, 500)) } : {}),
    ...(scope ? { scope } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeTiers(input: CampaignTierPolicy[] | undefined): CampaignTierPolicy[] {
  const source = input ?? DEFAULT_CAMPAIGN_TIERS;
  if (source.length < 1 || source.length > 4) throw new Error("Campaign tiers must contain between 1 and 4 policies");
  const tiers = source.map((item, index) => {
    if (item.tier !== index) throw new Error("Campaign tiers must be ordered from tier 0");
    if (!Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1 || item.maxAttempts > 3) throw new Error("Campaign tier maxAttempts must be between 1 and 3");
    return {
      tier: index as CampaignTier,
      label: bounded(item.label, 120) || `Tier ${index}`,
      maxAttempts: item.maxAttempts,
      ...(item.hintAfterTier === undefined ? {} : { hintAfterTier: item.hintAfterTier }),
    };
  });
  return tiers;
}

function safeStatus(value: RunState): CampaignWorkStatus {
  if (value.status === "completed") return "succeeded";
  if (value.status === "blocked") return "blocked";
  if (value.status === "aborted") return "cancelled";
  return "failed";
}

function curationFromState(item: CampaignWorkItem, state: RunState, maxTextChars: number): {
  entries: Array<{ kind: SharedEvidenceKind; claim: string; evidence: string[]; confidence: number }>;
  summary: string;
  proposedTasks: string[];
} {
  const entries: Array<{ kind: SharedEvidenceKind; claim: string; evidence: string[]; confidence: number }> = [];
  for (const finding of state.findings.slice(-8)) {
    entries.push({
      kind: "fact",
      claim: `${finding.title}: ${finding.description}`,
      evidence: finding.evidence.slice(0, 4),
      confidence: Math.max(0, Math.min(1, finding.confidence)),
    });
  }
  for (const hypothesis of state.hypotheses.filter((value) => value.status !== "contradicted").slice(-8)) {
    entries.push({
      kind: hypothesis.status === "confirmed" ? "fact" : "candidate",
      claim: hypothesis.statement,
      evidence: hypothesis.evidence.slice(0, 4),
      confidence: hypothesis.status === "confirmed" ? 0.95 : hypothesis.status === "supported" ? 0.7 : 0.35,
    });
  }
  for (const verification of (state.verification ?? []).slice(-4)) {
    entries.push({ kind: "fact", claim: "Independent verification observed", evidence: [verification], confidence: 0.9 });
  }
  if (state.status !== "completed" && state.stopReason) {
    entries.push({ kind: "dead-end", claim: `Current approach stopped: ${state.stopReason}`, evidence: [`run:${state.id}`], confidence: 0.8 });
  }
  const summaryParts = [
    state.summary ? `公开结论：${state.summary}` : "本轮没有公开结论",
    state.stopReason ? `停止原因：${state.stopReason}` : "",
    `状态：${state.status}，回合 ${state.turns}，工具调用 ${state.toolCalls}`,
  ].filter(Boolean);
  const proposedTasks = state.status === "completed"
    ? []
    : [
        "从共享证据中选择一个尚未验证的关键候选，设计一个最小、可复核的下一步观察。",
        "检查当前失败原因是否由范围、工具错误或错误假设造成，并提出一个不同的验证路径。",
      ];
  return {
    entries,
    summary: bounded(summaryParts.join("；"), maxTextChars),
    proposedTasks: proposedTasks.map((value) => bounded(value, 600)),
  };
}

export class DurableAdaptiveCampaignStore {
  readonly path: string;
  readonly limits: AdaptiveCampaignStoreLimits;
  private queue = Promise.resolve();

  constructor(root: string, limits: Partial<AdaptiveCampaignStoreLimits> = {}) {
    this.path = join(root, "campaigns.json");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async create(input: {
    name: string;
    tasks: TaskRequest[];
    concurrency: number;
    raceAgents: number;
    budget: AdaptiveCampaignBudget;
    tiers: CampaignTierPolicy[];
  }): Promise<AdaptiveCampaignRecord> {
    return await this.mutate((state) => {
      if (state.campaigns.length >= this.limits.maxCampaigns) throw new Error("Campaign store budget exhausted");
      if (input.tasks.length < 1 || input.tasks.length * input.raceAgents > this.limits.maxItems) throw new Error("Campaign task budget exhausted");
      const createdAt = now();
      const id = randomUUID();
      const record: AdaptiveCampaignRecord = {
        id,
        name: bounded(input.name, 200) || `Campaign ${id.slice(0, 8)}`,
        status: "queued",
        createdAt,
        updatedAt: createdAt,
        concurrency: input.concurrency,
        raceAgents: input.raceAgents,
        budget: { ...input.budget },
        tiers: clone(input.tiers),
        items: [],
        evidence: [],
        curation: [],
        events: [],
        runsStarted: 0,
        verifiedRuns: 0,
      };
      input.tasks.forEach((task, rootIndex) => {
        for (let lane = 0; lane < input.raceAgents; lane += 1) {
          record.items.push({
            id: randomUUID(), campaignId: id, rootIndex, lane, tier: 0,
            task: sanitizeRequest(task, this.limits.maxTextChars), status: "queued", attempts: 0,
            leaseGeneration: 0, createdAt, updatedAt: createdAt,
          });
        }
      });
      state.campaigns.push(record);
      this.event(record, "campaign.created", `${record.items.length} 个探索任务已排队`);
      return record;
    });
  }

  async get(id: string): Promise<AdaptiveCampaignRecord | undefined> {
    const state = await this.read();
    const value = state.campaigns.find((item) => item.id === id);
    return value ? clone(value) : undefined;
  }

  async list(): Promise<AdaptiveCampaignSnapshot[]> {
    const state = await this.read();
    return state.campaigns.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((item) => snapshot(item));
  }

  async snapshot(id: string): Promise<AdaptiveCampaignSnapshot | undefined> {
    const value = await this.get(id);
    return value ? snapshot(value) : undefined;
  }

  async claimNext(campaignId: string, workerId: string, leaseMs: number): Promise<CampaignWorkItem | undefined> {
    return await this.mutate((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign || ["completed", "failed", "aborted"].includes(campaign.status)) return undefined;
      const current = Date.now();
      const item = campaign.items
        .filter((candidate) => candidate.status === "queued" || (candidate.status === "running" && Date.parse(candidate.leaseExpiresAt ?? "") <= current))
        .sort((left, right) => left.tier - right.tier || left.rootIndex - right.rootIndex || left.lane - right.lane)[0];
      if (!item) return undefined;
      const timestamp = now();
      item.status = "running";
      item.leaseGeneration += 1;
      item.leaseOwner = bounded(workerId, 120);
      item.leaseExpiresAt = new Date(current + positive(leaseMs, "campaign leaseMs")).toISOString();
      item.attempts += 1;
      item.startedAt ??= timestamp;
      item.updatedAt = timestamp;
      campaign.status = "running";
      campaign.startedAt ??= timestamp;
      campaign.updatedAt = timestamp;
      this.event(campaign, "campaign.task.claimed", `Tier ${item.tier} · lane ${item.lane + 1}`, item.id);
      return clone(item);
    });
  }

  async attachRun(campaignId: string, itemId: string, workerId: string, generation: number, runId: string): Promise<CampaignWorkItem> {
    return await this.mutate((state) => {
      const { campaign, item } = this.assertLease(state, campaignId, itemId, workerId, generation);
      item.runId = bounded(runId, 180);
      campaign.runsStarted += 1;
      campaign.updatedAt = now();
      this.event(campaign, "campaign.run.started", `已启动 run ${item.runId}`, item.id, item.runId);
      return clone(item);
    });
  }

  async renewLease(campaignId: string, itemId: string, workerId: string, generation: number, leaseMs: number): Promise<CampaignWorkItem> {
    return await this.mutate((state) => {
      const { campaign, item } = this.assertLease(state, campaignId, itemId, workerId, generation);
      item.leaseExpiresAt = new Date(Date.now() + positive(leaseMs, "campaign leaseMs")).toISOString();
      item.updatedAt = now(); campaign.updatedAt = item.updatedAt;
      return clone(item);
    });
  }

  async settle(input: { campaignId: string; itemId: string; workerId: string; generation: number; status: CampaignWorkStatus; summary: string; error?: string }): Promise<CampaignWorkItem> {
    return await this.mutate((state) => {
      const { campaign, item } = this.assertLease(state, input.campaignId, input.itemId, input.workerId, input.generation);
      const timestamp = now();
      item.status = input.status;
      item.summary = bounded(input.summary, 8_000);
      if (input.error) item.error = bounded(input.error, 4_000);
      if (input.status === "queued") delete item.finishedAt;
      else item.finishedAt = timestamp;
      item.updatedAt = timestamp;
      delete item.leaseOwner;
      delete item.leaseExpiresAt;
      campaign.updatedAt = timestamp;
      this.event(campaign, input.status === "queued" ? "campaign.task.retry" : `campaign.task.${input.status}`, item.summary, item.id, item.runId);
      return clone(item);
    });
  }

  async enqueue(campaignId: string, input: { rootIndex: number; lane: number; parentItemId?: string; tier: CampaignTier; task: TaskRequest }): Promise<CampaignWorkItem> {
    return await this.mutate((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign) throw new Error("Campaign not found");
      if (campaign.items.length >= Math.min(campaign.budget.maxItems, this.limits.maxItems)) throw new Error("Campaign item budget exhausted");
      const createdAt = now();
      const item: CampaignWorkItem = {
        id: randomUUID(), campaignId, rootIndex: input.rootIndex, lane: input.lane,
        ...(input.parentItemId ? { parentItemId: input.parentItemId } : {}),
        tier: input.tier, task: sanitizeRequest(input.task, this.limits.maxTextChars), status: "queued", attempts: 0,
        leaseGeneration: 0, createdAt, updatedAt: createdAt,
      };
      campaign.items.push(item); campaign.updatedAt = createdAt;
      this.event(campaign, "campaign.task.queued", `Tier ${item.tier} · lane ${item.lane + 1}`, item.id);
      return clone(item);
    });
  }

  async addCuration(campaignId: string, input: { itemId: string; runId?: string; summary: string; evidence: Array<{ kind: SharedEvidenceKind; claim: string; evidence: string[]; confidence: number }>; proposedTasks: string[] }): Promise<CampaignCuration> {
    return await this.mutate((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign) throw new Error("Campaign not found");
      const createdAt = now();
      const evidenceIds: string[] = [];
      for (const candidate of input.evidence.slice(0, 24)) {
        const claim = bounded(candidate.claim, 600);
        const evidence = [...new Set(candidate.evidence.map((value) => bounded(value, 600)).filter(Boolean))].slice(0, 8);
        if (!claim || evidence.length === 0) continue;
        const existing = campaign.evidence.find((entry) => entry.kind === candidate.kind && entry.claim.toLowerCase() === claim.toLowerCase());
        if (existing) {
          existing.confidence = Math.max(existing.confidence, Math.max(0, Math.min(1, candidate.confidence)));
          existing.evidence = [...new Set([...existing.evidence, ...evidence])].slice(0, 8);
          existing.sourceRunIds = [...new Set([...existing.sourceRunIds, ...(input.runId ? [input.runId] : [])])].slice(-8);
          existing.updatedAt = createdAt;
          evidenceIds.push(existing.id);
        } else {
          const entry: SharedEvidenceEntry = {
            id: randomUUID(), kind: candidate.kind, claim, evidence,
            confidence: Math.max(0, Math.min(1, candidate.confidence)), sourceRunIds: input.runId ? [input.runId] : [],
            createdAt, updatedAt: createdAt,
          };
          campaign.evidence.push(entry); evidenceIds.push(entry.id);
        }
      }
      campaign.evidence = campaign.evidence.slice(-this.limits.maxEvidence);
      const curation: CampaignCuration = {
        id: randomUUID(), itemId: input.itemId, ...(input.runId ? { runId: input.runId } : {}),
        summary: bounded(input.summary, this.limits.maxTextChars), evidenceIds,
        proposedTasks: input.proposedTasks.slice(0, 8).map((value) => bounded(value, 800)), createdAt,
      };
      campaign.curation = [...campaign.curation, curation].slice(-this.limits.maxCuration);
      campaign.updatedAt = createdAt;
      this.event(campaign, "campaign.curated", curation.summary, input.itemId, input.runId, { evidenceIds, proposedTaskCount: curation.proposedTasks.length });
      return clone(curation);
    });
  }

  async markVerified(campaignId: string, itemId: string, runId?: string): Promise<void> {
    await this.mutate((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign) return;
      campaign.verifiedRuns += 1;
      campaign.updatedAt = now();
      this.event(campaign, "campaign.run.verified", "运行通过独立验证", itemId, runId);
    });
  }

  async setStatus(campaignId: string, status: AdaptiveCampaignStatus, error?: string): Promise<AdaptiveCampaignRecord | undefined> {
    return await this.mutate((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign) return undefined;
      const timestamp = now(); campaign.status = status; campaign.updatedAt = timestamp;
      if (["completed", "failed", "aborted"].includes(status)) campaign.finishedAt = timestamp;
      if (error) campaign.error = bounded(error, 2_000);
      this.event(campaign, `campaign.${status}`, error ? bounded(error, 500) : "Campaign 状态已更新");
      return clone(campaign);
    });
  }

  async cancelQueued(campaignId: string): Promise<AdaptiveCampaignRecord | undefined> {
    return await this.mutate((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign) return undefined;
      for (const item of campaign.items) {
        if (item.status === "queued") { item.status = "cancelled"; item.finishedAt = now(); item.updatedAt = item.finishedAt; }
      }
      campaign.updatedAt = now();
      return clone(campaign);
    });
  }

  private assertLease(state: AdaptiveCampaignStoreState, campaignId: string, itemId: string, workerId: string, generation: number): { campaign: AdaptiveCampaignRecord; item: CampaignWorkItem } {
    const campaign = state.campaigns.find((value) => value.id === campaignId);
    const item = campaign?.items.find((value) => value.id === itemId);
    if (!campaign || !item) throw new Error("Campaign work item not found");
    if (item.leaseOwner !== workerId || item.leaseGeneration !== generation) throw new Error("Stale campaign work lease");
    if (Date.parse(item.leaseExpiresAt ?? "") <= Date.now()) throw new Error("Campaign work lease expired");
    return { campaign, item };
  }

  private event(campaign: AdaptiveCampaignRecord, type: string, detail?: string, itemId?: string, runId?: string, data?: unknown): void {
    const next: CampaignEvent = {
      sequence: (campaign.events.at(-1)?.sequence ?? 0) + 1, id: randomUUID(), campaignId: campaign.id,
      ...(itemId ? { itemId } : {}), ...(runId ? { runId } : {}), type,
      ...(detail ? { detail: bounded(detail, 1_000) } : {}), ...(data === undefined ? {} : { data: bounded(sanitizeSensitiveText(JSON.stringify(data)), 4_000) }), createdAt: now(),
    };
    campaign.events = [...campaign.events, next].slice(-this.limits.maxEvents);
  }

  private async mutate<T>(operation: (state: AdaptiveCampaignStoreState) => T): Promise<T> {
    let result!: T;
    const pending = this.queue.then(async () => { const state = await this.read(); result = operation(state); await this.write(state); });
    this.queue = pending.then(() => undefined, () => undefined);
    await pending;
    return result;
  }

  private async read(): Promise<AdaptiveCampaignStoreState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<AdaptiveCampaignStoreState>;
      return { version: 1, campaigns: Array.isArray(value.campaigns) ? value.campaigns : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, campaigns: [] };
      throw error;
    }
  }

  private async write(state: AdaptiveCampaignStoreState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
  }
}

function snapshot(record: AdaptiveCampaignRecord): AdaptiveCampaignSnapshot {
  const items = record.items;
  const currentTier = Math.max(0, ...items.map((item) => item.tier)) as CampaignTier;
  return {
    ...clone(record), currentTier,
    queued: items.filter((item) => item.status === "queued").length,
    running: items.filter((item) => item.status === "running").length,
    succeeded: items.filter((item) => item.status === "succeeded").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    failed: items.filter((item) => item.status === "failed").length,
  };
}

interface CampaignRunManager {
  start(request: TaskRequest, options?: { workspaceMode?: "configured" | "attachments-only"; sharedEvidence?: SharedEvidenceBoard; contextSections?: Array<{ name: string; content: string }> }): string;
  wait(id: string): Promise<RunState>;
  stop(id: string): boolean;
}

export interface AdaptiveCampaignManagerOptions {
  store: DurableAdaptiveCampaignStore;
  runManager: CampaignRunManager;
  leaseMs?: number;
  idlePollMs?: number;
  hints?: Partial<Record<CampaignTier, string>>;
}

interface CampaignHandle { controller: AbortController; promise: Promise<void>; activeRuns: Map<string, string>; board: SharedEvidenceBoard; }

function boardFromRecord(record: AdaptiveCampaignRecord): SharedEvidenceBoard {
  const board = new SharedEvidenceBoard();
  for (const entry of record.evidence) board.publish(entry.sourceRunIds[0] ?? "campaign", { kind: entry.kind, claim: entry.claim, evidence: entry.evidence, confidence: entry.confidence });
  return board;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Campaign stopped")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class AdaptiveCampaignManager {
  private readonly handles = new Map<string, CampaignHandle>();
  private readonly leaseMs: number;
  private readonly idlePollMs: number;

  constructor(private readonly options: AdaptiveCampaignManagerOptions) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.idlePollMs = options.idlePollMs ?? 100;
  }

  async start(input: AdaptiveCampaignStartInput): Promise<AdaptiveCampaignSnapshot> {
    if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 64) throw new Error("Campaign tasks must contain between 1 and 64 items");
    const concurrency = boundedPositive(input.concurrency, 2, 8, "Campaign concurrency");
    const raceAgents = boundedPositive(input.raceAgents, 1, 8, "Campaign raceAgents");
    const tiers = normalizeTiers(input.tiers);
    const budget: AdaptiveCampaignBudget = {
      maxRuntimeMs: boundedPositive(input.budget?.maxRuntimeMs, 60 * 60 * 1_000, 24 * 60 * 60 * 1_000, "Campaign maxRuntimeMs"),
      maxWorkers: Math.min(concurrency, boundedPositive(input.budget?.maxWorkers, concurrency, 8, "Campaign maxWorkers")),
      maxItems: boundedPositive(input.budget?.maxItems, Math.min(256, input.tasks.length * raceAgents * tiers.length), 512, "Campaign maxItems"),
      maxRuns: boundedPositive(input.budget?.maxRuns, Math.min(256, input.tasks.length * raceAgents * tiers.length), 512, "Campaign maxRuns"),
    };
    const tasks = input.tasks.map((task) => sanitizeRequest(typeof task === "string" ? { task } : task, this.options.store.limits.maxTextChars));
    const record = await this.options.store.create({ name: input.name ?? "Adaptive security campaign", tasks, concurrency, raceAgents, budget, tiers });
    const handle: CampaignHandle = { controller: new AbortController(), promise: Promise.resolve(), activeRuns: new Map(), board: boardFromRecord(record) };
    handle.promise = this.execute(record.id, handle, input.hints ?? this.options.hints ?? {});
    this.handles.set(record.id, handle);
    void handle.promise.catch(() => undefined);
    return (await this.options.store.snapshot(record.id))!;
  }

  async get(id: string): Promise<AdaptiveCampaignSnapshot | undefined> { return await this.options.store.snapshot(id); }
  async list(): Promise<AdaptiveCampaignSnapshot[]> { return await this.options.store.list(); }

  async resumePending(): Promise<void> {
    const records = await this.options.store.list();
    for (const record of records) {
      if (!["queued", "running"].includes(record.status) || this.handles.has(record.id)) continue;
      const handle: CampaignHandle = { controller: new AbortController(), promise: Promise.resolve(), activeRuns: new Map(), board: boardFromRecord(record) };
      handle.promise = this.execute(record.id, handle, this.options.hints ?? {});
      this.handles.set(record.id, handle);
      void handle.promise.catch(() => undefined);
    }
  }

  async stop(id: string): Promise<AdaptiveCampaignSnapshot | undefined> {
    const handle = this.handles.get(id);
    if (handle) {
      handle.controller.abort(new Error("Campaign stopped by operator"));
      for (const runId of handle.activeRuns.values()) this.options.runManager.stop(runId);
      await this.options.store.cancelQueued(id);
      await handle.promise.catch(() => undefined);
      await this.options.store.setStatus(id, "aborted", "Stopped by operator");
    } else {
      await this.options.store.cancelQueued(id);
      await this.options.store.setStatus(id, "aborted", "Stopped by operator");
    }
    return await this.get(id);
  }

  async close(): Promise<void> {
    await Promise.all([...this.handles.keys()].map((id) => this.stop(id)));
  }

  private async execute(campaignId: string, handle: CampaignHandle, hints: Partial<Record<CampaignTier, string>>): Promise<void> {
    const campaign = await this.options.store.get(campaignId);
    if (!campaign) return;
    const deadline = Date.now() + campaign.budget.maxRuntimeMs;
    await this.options.store.setStatus(campaignId, "running");
    const worker = async (index: number): Promise<void> => {
      const workerId = `campaign-worker-${campaignId.slice(0, 8)}-${index + 1}`;
      while (!handle.controller.signal.aborted && Date.now() < deadline) {
        const item = await this.options.store.claimNext(campaignId, workerId, this.leaseMs);
        if (!item) {
          const current = await this.options.store.get(campaignId);
          if (!current || current.items.every((value) => TERMINAL.has(value.status))) return;
          try { await delay(this.idlePollMs, handle.controller.signal); } catch { return; }
          continue;
        }
        await this.executeItem(campaignId, item, workerId, handle, hints);
      }
    };
    try {
      await Promise.all(Array.from({ length: campaign.budget.maxWorkers }, (_, index) => worker(index)));
      if (handle.controller.signal.aborted) {
        await this.options.store.cancelQueued(campaignId);
        await this.options.store.setStatus(campaignId, "aborted", "Campaign stopped by operator");
      } else if (Date.now() >= deadline) {
        await this.options.store.cancelQueued(campaignId);
        await this.options.store.setStatus(campaignId, "failed", "Campaign runtime budget exceeded");
      } else {
        const current = await this.options.store.get(campaignId);
        await this.options.store.setStatus(campaignId, current?.items.some((item) => item.status === "succeeded") ? "completed" : "failed");
      }
    } catch (error) {
      await this.options.store.setStatus(campaignId, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.handles.delete(campaignId);
    }
  }

  private async executeItem(campaignId: string, item: CampaignWorkItem, workerId: string, handle: CampaignHandle, hints: Partial<Record<CampaignTier, string>>): Promise<void> {
    const campaign = await this.options.store.get(campaignId);
    if (!campaign) return;
    const board = handle.board;
    const latestCuration = campaign.curation.at(-1);
    const evidenceText = board.snapshot(16, 16 * 1024).entries.map((entry) => `- [${entry.kind}] ${entry.claim}（${entry.evidence.join("；")}）`).join("\n");
    const curationText = latestCuration ? `最近整理：${latestCuration.summary}\n建议：${latestCuration.proposedTasks.join("；")}` : "尚无其他 Agent 的整理结果。";
    const hint = hints[item.tier] && (campaign.tiers[item.tier]?.hintAfterTier === undefined || item.tier >= (campaign.tiers[item.tier]?.hintAfterTier ?? 99)) ? hints[item.tier] : undefined;
    const contextSections = [
      { name: "campaign-board", content: `共享证据板（仅作参考，必须独立验证）：\n${evidenceText || "暂无共享证据。"}` },
      { name: "campaign-curator", content: curationText },
      { name: "claimed-investigation", content: `你已认领第 ${item.tier} 层“${campaign.tiers[item.tier]?.label ?? "调查"}”任务，lane ${item.lane + 1}。请只推进这个焦点，并把公开观察写入运行结果。${hint ? `\n操作员提供的延迟提示：${hint}` : ""}` },
    ];
    const request: TaskRequest = {
      ...item.task,
      task: `${item.task.task}\n\n本次属于 Adaptive Campaign 的受控探索。不要把共享板当作事实；每个结论都要由当前运行重新验证。`,
      metadata: {
        ...(item.task.metadata ?? {}), campaignId, campaignItemId: item.id, campaignTier: String(item.tier), campaignLane: String(item.lane + 1),
      },
    };
    let runId: string | undefined;
    const leaseRenew = setInterval(() => { void this.options.store.renewLease(campaignId, item.id, workerId, item.leaseGeneration, this.leaseMs).catch(() => handle.controller.abort(new Error("Campaign work lease lost"))); }, Math.max(100, Math.floor(this.leaseMs / 3)));
    try {
      const currentCampaign = await this.options.store.get(campaignId);
      if (!currentCampaign || currentCampaign.runsStarted >= currentCampaign.budget.maxRuns) {
        await this.options.store.settle({ campaignId, itemId: item.id, workerId, generation: item.leaseGeneration, status: "failed", summary: "Campaign run budget exhausted" });
        return;
      }
      runId = this.options.runManager.start(request, { workspaceMode: "attachments-only", sharedEvidence: board, contextSections });
      handle.activeRuns.set(item.id, runId);
      await this.options.store.attachRun(campaignId, item.id, workerId, item.leaseGeneration, runId);
      const state = await this.options.runManager.wait(runId);
      const curation = curationFromState(item, state, this.options.store.limits.maxTextChars);
      await this.options.store.addCuration(campaignId, { itemId: item.id, runId, summary: curation.summary, evidence: curation.entries, proposedTasks: curation.proposedTasks });
      for (const entry of curation.entries) board.publish(runId, entry);
      const status = safeStatus(state);
      const tierPolicy = campaign.tiers[item.tier];
      const retry = status !== "succeeded" && Boolean(tierPolicy && item.attempts < tierPolicy.maxAttempts);
      await this.options.store.settle({ campaignId, itemId: item.id, workerId, generation: item.leaseGeneration, status: retry ? "queued" : status, summary: state.summary ?? state.stopReason ?? state.status, ...(state.stopReason ? { error: state.stopReason } : {}) });
      if (state.independentlyVerified === true || (state.status === "completed" && (state.verification?.length ?? 0) > 0)) await this.options.store.markVerified(campaignId, item.id, runId);
      if (status !== "succeeded" && !retry) await this.escalate(campaignId, item, curation.proposedTasks, hints);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retry = !handle.controller.signal.aborted && Boolean(campaign.tiers[item.tier] && item.attempts < (campaign.tiers[item.tier]?.maxAttempts ?? 1));
      await this.options.store.settle({ campaignId, itemId: item.id, workerId, generation: item.leaseGeneration, status: retry ? "queued" : handle.controller.signal.aborted ? "cancelled" : "failed", summary: message, error: message }).catch(() => undefined);
      if (!retry && !handle.controller.signal.aborted) await this.escalate(campaignId, item, ["检查本轮错误并设计一个不同的、最小的验证动作。"], hints);
    } finally {
      clearInterval(leaseRenew);
      handle.activeRuns.delete(item.id);
    }
  }

  private async escalate(campaignId: string, item: CampaignWorkItem, proposedTasks: string[], hints: Partial<Record<CampaignTier, string>>): Promise<void> {
    const campaign = await this.options.store.get(campaignId);
    if (!campaign) return;
    const nextTier = (item.tier + 1) as CampaignTier;
    if (!campaign.tiers[nextTier] || campaign.items.length >= campaign.budget.maxItems) return;
    const taskText = proposedTasks[0] ?? "重新审视当前证据，选择一个尚未验证的关键假设并执行最小验证。";
    const hint = hints[nextTier] && (campaign.tiers[nextTier]?.hintAfterTier === undefined || nextTier >= (campaign.tiers[nextTier]?.hintAfterTier ?? 99)) ? `\n延迟提示（仅当前升级层可见）：${hints[nextTier]}` : "";
    await this.options.store.enqueue(campaignId, {
      rootIndex: item.rootIndex, lane: item.lane, parentItemId: item.id, tier: nextTier,
      task: { ...item.task, task: `${item.task.task}\n\n上一层公开整理：${taskText}${hint}` },
    });
    await this.options.store.setStatus(campaignId, "running");
  }
}

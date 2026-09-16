import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { AppConfig, ModelConfig, TaskRequest } from "./types.js";
import { AuditChain } from "./audit.js";
import { dashboardHtml } from "./dashboard.js";
import { ExperienceStore, type ExperienceUpdate } from "./experience.js";
import { RunManager } from "./run-manager.js";
import { recoverInterruptedRuns } from "./run-recovery.js";
import { XuanShuRuntime, writeRunState, type RuntimeModelSessionConfig } from "./runtime.js";
import { inferTrajectorySource } from "./session-trajectory.js";
import { appendRunReview, listPersistedRuns, loadDecisionTrace, loadPersistedRun, prepareRunContinuation, readAuditRecords, truncateTraceData } from "./trace.js";
import { ManualJobManager, validateManualJobInput } from "./manual-jobs.js";
import { ManualUploadError, ManualUploadStore } from "./manual-uploads.js";
import { PermissionBroker, type PermissionDecision } from "./permissions.js";
import { QuestionBank, questionToTaskRequest } from "./question-bank.js";
import { QuestionBankInstanceRunner } from "./question-bank-instances.js";
import { DurableAgentStore, type AgentPurpose, type AgentTaskBudget } from "./agent-store.js";
import { BoundedAgentWorker, runManagerAgentTaskRunner } from "./agent-worker.js";
import { MemoryStore, type MemoryConfidence, type MemoryKind, type MemoryScope, type MemoryStatus } from "./memory.js";
import { DurableWorkflowStore, type WorkflowBudget, type WorkflowNodeSpec } from "./workflow.js";
import { BoundedWorkflowWorker, runManagerWorkflowNodeRunner } from "./workflow-worker.js";
import { ConnectorBroker, ConnectorExecutor } from "./connector.js";
import { EvaluationLedger, type EvaluationAttempt } from "./evaluation-ledger.js";
import { DISCLOSURE_REASON_LABELS, DisclosureLedger, DisclosureLedgerError } from "./disclosure-ledger.js";
import { KnowledgeStore, type KnowledgeTrust } from "./knowledge-store.js";
import { startModelGateway, type ModelGateway } from "./model-gateway.js";
import { QuestionBankProgressStore } from "./question-bank-progress.js";
import { AdaptiveCampaignManager, DurableAdaptiveCampaignStore, type AdaptiveCampaignStartInput } from "./adaptive-campaign.js";
import { sanitizeSensitiveText } from "./sanitize.js";

const MAX_BODY_BYTES = 1024 * 1024;

class RequestInputError extends Error {}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    "x-content-type-options": "nosniff",
  });
  response.end(value);
}

async function frontendAsset(pathname: string, configuredRoot: string): Promise<{ body: Buffer; contentType: string } | undefined> {
  const assetRoot = resolve(configuredRoot);
  const requested = pathname === "/" || !extname(pathname) ? "index.html" : pathname.slice(1);
  const candidate = resolve(assetRoot, requested);
  const relativePath = relative(assetRoot, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
  try {
    const body = await readFile(candidate);
    const contentType = ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" } as Record<string, string>)[extname(candidate)] ?? "application/octet-stream";
    return { body, contentType };
  } catch { return undefined; }
}

function asset(response: ServerResponse, value: { body: Buffer; contentType: string }): void {
  response.writeHead(200, { "content-type": value.contentType, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  response.end(value.body);
}

async function bodyJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new RequestInputError("Request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestInputError("Request body must be valid JSON"); }
}

function authorized(request: IncomingMessage, config: AppConfig): boolean {
  const token = process.env[config.server.tokenEnv];
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function isTaskRequest(value: unknown): value is TaskRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.task === "string" &&
    (request.attachments === undefined ||
      (Array.isArray(request.attachments) && request.attachments.every((item) => typeof item === "string")))
  );
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new ManualUploadError(`${name} must be provided once`);
  return value;
}

function uploadFileName(request: IncomingMessage): string {
  const encoded = singleHeader(request, "x-file-name");
  if (!encoded) throw new ManualUploadError("x-file-name is required");
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new ManualUploadError("x-file-name must be URI encoded");
  }
}

function uploadContentLength(request: IncomingMessage): number | undefined {
  const value = singleHeader(request, "content-length");
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new ManualUploadError("Content-Length must be a non-negative integer");
  return Number(value);
}

function attachUploadedFiles(input: ReturnType<typeof validateManualJobInput>, paths: string[]) {
  return {
    ...input,
    tasks: input.tasks.map((task, index) => {
      const request: TaskRequest = typeof task === "string" ? { task } : task;
      const attachments = [...(request.attachments ?? []), ...paths];
      if (attachments.length > 20) throw new Error(`tasks[${index}] may contain at most 20 attachments`);
      return { ...request, attachments };
    }),
  };
}

export interface ApiServerDependencies {
  manualJobs?: ManualJobManager;
  manualUploads?: ManualUploadStore;
  questionBank?: QuestionBank;
  questionBankProgress?: QuestionBankProgressStore;
  questionBankInstances?: QuestionBankInstanceRunner;
  frontendRoot?: string;
  permissionBroker?: PermissionBroker;
  agentStore?: DurableAgentStore;
  agentWorker?: BoundedAgentWorker;
  memoryStore?: MemoryStore;
  workflowStore?: DurableWorkflowStore;
  workflowWorker?: BoundedWorkflowWorker;
  connectorBroker?: ConnectorBroker;
  evaluationLedger?: EvaluationLedger;
  disclosureLedger?: DisclosureLedger;
  knowledgeStore?: KnowledgeStore;
  /** Process-level model gateway; when omitted, startApiServer owns one and stops it on close. */
  gateway?: ModelGateway;
  adaptiveCampaigns?: AdaptiveCampaignManager;
}

function inputRecord(value: unknown, label = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestInputError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function modelSessionInput(value: unknown): RuntimeModelSessionConfig {
  const input = inputRecord(value);
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 1_000) throw new RequestInputError("apiKey is required and must be at most 1000 characters");
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/$/, "") : "";
  let parsedBaseUrl: URL;
  try { parsedBaseUrl = new URL(baseUrl); } catch { throw new RequestInputError("baseUrl must be a valid URL"); }
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new RequestInputError("baseUrl must use http or https without embedded credentials");
  }
  const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
  if (!modelId || modelId.length > 200) throw new RequestInputError("modelId is required and must be at most 200 characters");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 200) : modelId;
  const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim().slice(0, 100) : "anthropic-compatible";
  const appKey = typeof input.appKey === "string" ? input.appKey.trim() : "";
  if (appKey.length > 1_000) throw new RequestInputError("appKey must be at most 1000 characters");
  const appKeyHeader = typeof input.appKeyHeader === "string" && input.appKeyHeader.trim() ? input.appKeyHeader.trim() : "AppKey";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(appKeyHeader)) throw new RequestInputError("appKeyHeader is invalid");
  const authScheme = input.authScheme === undefined || input.authScheme === "" ? undefined : String(input.authScheme);
  if (authScheme !== undefined && !["bearer", "api-key"].includes(authScheme)) throw new RequestInputError("authScheme must be bearer or api-key");
  if (input.reasoning !== undefined && typeof input.reasoning !== "boolean") throw new RequestInputError("reasoning must be a boolean");
  const reasoning = input.reasoning === undefined ? true : input.reasoning;
  const boundedModelNumber = (key: string, fallback: number, minimum: number, maximum: number): number => {
    if (input[key] === undefined) return fallback;
    const candidate = Number(input[key]);
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new RequestInputError(`${key} must be an integer between ${minimum} and ${maximum}`);
    }
    return candidate;
  };
  // Session models are commonly backed by gateways with a smaller effective
  // context/TPM quota than their advertised maximum. Keep the safe default
  // compact, while allowing an operator to raise it explicitly when needed.
  const contextWindow = boundedModelNumber("contextWindow", 32_000, 16_000, 256_000);
  const model: ModelConfig = {
    provider,
    id: modelId,
    name,
    baseUrl,
    apiKeyEnv: "XUANSHU_SESSION_MODEL_KEY",
    ...(reasoning ? { reasoning } : {}),
    contextWindow,
    ...(authScheme ? { authScheme: authScheme as NonNullable<ModelConfig["authScheme"]> } : {}),
  };
  return { model, apiKey, ...(appKey ? { headers: { [appKeyHeader]: appKey } } : {}) };
}

function boundedLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("limit must be a positive integer");
  return Math.min(parsed, maximum);
}

async function clientRequest<T>(response: ServerResponse, operation: () => Promise<T>, status = 200): Promise<void> {
  try { json(response, status, await operation()); }
  catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
}

// Token budgets for agent tasks and workflows no longer derive from a model
// profile's output limit; the SDK sizes its own requests. Keep the legacy
// ceiling (8k output tokens per turn) so stored budgets stay comparable.
const TASK_OUTPUT_TOKENS_PER_TURN = 8_192;

function agentTaskBudget(value: unknown, config: AppConfig): AgentTaskBudget {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const integer = (key: string, fallback: number): number => {
    const candidate = input[key] === undefined ? fallback : Number(input[key]);
    if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`budget.${key} must be a positive integer`);
    return candidate;
  };
  const ceiling = TASK_OUTPUT_TOKENS_PER_TURN * config.runtime.maxTurns;
  return {
    maxRuntimeMs: Math.min(integer("maxRuntimeMs", config.runtime.maxRuntimeMs), config.runtime.maxRuntimeMs),
    maxTokens: Math.min(integer("maxTokens", ceiling), ceiling),
    maxCostMicros: integer("maxCostMicros", 10_000_000),
  };
}

function workflowBudget(value: unknown, config: AppConfig): WorkflowBudget {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const integer = (key: string, fallback: number, maximum: number): number => {
    const candidate = input[key] === undefined ? fallback : Number(input[key]);
    if (!Number.isSafeInteger(candidate) || candidate < 0 || (candidate === 0 && !["maxNetworkNodes", "maxNetworkRequests", "maxControllerExpansions"].includes(key))) throw new Error(`budget.${key} is invalid`);
    return Math.min(candidate, maximum);
  };
  return {
    maxNodes: integer("maxNodes", 32, 128),
    maxRuntimeMs: integer("maxRuntimeMs", config.runtime.maxRuntimeMs, config.runtime.maxRuntimeMs),
    maxNetworkNodes: integer("maxNetworkNodes", config.runtime.maxHttpRequests, config.runtime.maxHttpRequests),
    maxNetworkRequests: integer("maxNetworkRequests", config.runtime.maxHttpRequests, config.runtime.maxHttpRequests),
    maxTokens: integer("maxTokens", TASK_OUTPUT_TOKENS_PER_TURN * config.runtime.maxTurns, TASK_OUTPUT_TOKENS_PER_TURN * config.runtime.maxTurns),
    maxCostMicros: integer("maxCostMicros", 10_000_000, 1_000_000_000),
    maxControllerExpansions: integer("maxControllerExpansions", 2, 8),
  };
}

function workflowNodes(value: unknown): WorkflowNodeSpec[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new Error("nodes must contain between 1 and 128 items");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`nodes[${index}] must be an object`);
    const node = item as Record<string, unknown>;
    if (typeof node.id !== "string" || typeof node.message !== "string") throw new Error(`nodes[${index}] requires id and message`);
    if (!Array.isArray(node.dependencies)) throw new Error(`nodes[${index}].dependencies must be an array`);
    const dependencies = node.dependencies.map((dependency, dependencyIndex) => {
      if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) throw new Error(`nodes[${index}].dependencies[${dependencyIndex}] must be an object`);
      const value = dependency as Record<string, unknown>;
      if (typeof value.nodeId !== "string" || !["success", "settled"].includes(String(value.condition))) throw new Error(`nodes[${index}] has an invalid dependency`);
      return { nodeId: value.nodeId, condition: value.condition as "success" | "settled" };
    });
    return {
      id: node.id,
      kind: node.kind as WorkflowNodeSpec["kind"],
      message: node.message,
      dependencies,
      effect: node.effect as WorkflowNodeSpec["effect"],
      cachePolicy: node.cachePolicy as WorkflowNodeSpec["cachePolicy"],
      ...(typeof node.evidenceVersion === "string" ? { evidenceVersion: node.evidenceVersion } : {}),
      maxAttempts: Number(node.maxAttempts),
    };
  });
}

function adaptiveCampaignInput(value: unknown): AdaptiveCampaignStartInput {
  const input = inputRecord(value);
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 64) throw new RequestInputError("tasks must contain between 1 and 64 items");
  const tasks = input.tasks.map((item, index) => {
    if (typeof item === "string") {
      if (!item.trim()) throw new RequestInputError(`tasks[${index}] must not be empty`);
      return item;
    }
    if (!isTaskRequest(item)) throw new RequestInputError(`tasks[${index}] must contain a task and optional attachments`);
    return item;
  });
  const valueFor = (key: string): number | undefined => input[key] === undefined ? undefined : Number(input[key]);
  const concurrency = valueFor("concurrency");
  const raceAgents = valueFor("raceAgents");
  const budget = input.budget && typeof input.budget === "object" && !Array.isArray(input.budget)
    ? input.budget as AdaptiveCampaignStartInput["budget"]
    : undefined;
  const hints = input.hints && typeof input.hints === "object" && !Array.isArray(input.hints)
    ? Object.fromEntries(Object.entries(input.hints).filter(([key, item]) => /^[0-3]$/.test(key) && typeof item === "string").map(([key, item]) => [Number(key), item]))
    : undefined;
  return {
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    tasks,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(raceAgents === undefined ? {} : { raceAgents }),
    ...(budget ? { budget } : {}),
    ...(hints ? { hints } : {}),
  };
}

async function questionBankSnapshot(questionBank: QuestionBank, progress: QuestionBankProgressStore) {
  const snapshot = await questionBank.snapshot();
  if (!snapshot.configured) return snapshot;
  const questions = await questionBank.load();
  await progress.syncCompletedRunArtifacts(questions);
  const solved = await progress.progressFor(questions);
  return {
    ...snapshot,
    count: questions.length,
    solvedCount: solved.size,
    pendingCount: questions.length - solved.size,
    questions: questions.map(({ id, title, category, attachments, instance }) => {
      const record = solved.get(id);
      return {
        id,
        title,
        category,
        attachmentCount: attachments.length,
        instanceAvailable: Boolean(instance),
        status: record ? ("solved" as const) : ("pending" as const),
        ...(record ? { solvedAt: record.solvedAt } : {}),
      };
    }),
  };
}

export function createApiServer(config: AppConfig, dependencies: ApiServerDependencies = {}) {
  const permissionBroker = dependencies.permissionBroker ?? new PermissionBroker(config.profile?.approvalPolicy ?? "never");
  const orchestrationRoot = join(config.runtime.artifactRoot, "..", "orchestration");
  const memoryStore = dependencies.memoryStore ?? new MemoryStore(orchestrationRoot);
  const knowledgeStore = dependencies.knowledgeStore ?? new KnowledgeStore(orchestrationRoot);
  const connectorBroker = dependencies.connectorBroker ?? new ConnectorBroker(config.connectors ?? []);
  const targetConnectorId = config.profile?.preferredExecutor === "connector" ? config.profile.executorTargetId : undefined;
  const runtime = new XuanShuRuntime(config, {
    permissionGate: permissionBroker,
    memoryStore,
    knowledgeStore,
    ...(dependencies.gateway ? { gateway: dependencies.gateway } : {}),
    ...(targetConnectorId ? { executorFactory: () => new ConnectorExecutor(targetConnectorId, connectorBroker) } : {}),
  });
  const manager = new RunManager(runtime);
  const agentStore = dependencies.agentStore ?? new DurableAgentStore(orchestrationRoot);
  const agentWorker = dependencies.agentWorker ?? new BoundedAgentWorker(agentStore, runManagerAgentTaskRunner(manager));
  agentWorker.start();
  const workflowStore = dependencies.workflowStore ?? new DurableWorkflowStore(orchestrationRoot);
  const workflowWorker = dependencies.workflowWorker ?? new BoundedWorkflowWorker(workflowStore, runManagerWorkflowNodeRunner(manager));
  workflowWorker.start();
  const evaluationLedger = dependencies.evaluationLedger ?? new EvaluationLedger(orchestrationRoot);
  const disclosureLedger = dependencies.disclosureLedger ?? new DisclosureLedger(orchestrationRoot);
  const adaptiveCampaigns = dependencies.adaptiveCampaigns ?? new AdaptiveCampaignManager({
    store: new DurableAdaptiveCampaignStore(orchestrationRoot),
    runManager: manager,
  });
  const experience = new ExperienceStore(config.runtime.artifactRoot);
  const manualJobs = dependencies.manualJobs ?? new ManualJobManager({ runManager: manager });
  const manualUploads = dependencies.manualUploads ?? new ManualUploadStore(join(config.runtime.scratchRoot, "manual-uploads"));
  const questionBank = dependencies.questionBank ?? new QuestionBank(config.questionBank);
  const questionBankProgress = dependencies.questionBankProgress ?? new QuestionBankProgressStore(config);
  const questionBankInstances = dependencies.questionBankInstances ?? new QuestionBankInstanceRunner(config);
  const frontendRoot = dependencies.frontendRoot ?? join(process.cwd(), "frontend", "dist");
  const streamClients = new Set<ServerResponse>();
  const terminalStatuses = new Set(["completed", "blocked", "failed", "aborted"]);
  const sendStreamRecord = (response: ServerResponse, runId: string, record: Awaited<ReturnType<typeof readAuditRecords>>[number]): void => {
    const eventId = `${runId}:${record.sequence}`;
    const envelope = {
      streamVersion: 1,
      runId,
      eventId,
      sequence: record.sequence,
      type: record.type,
      timestamp: record.timestamp,
      source: record.source ?? inferTrajectorySource(record.type),
      ...(record.actor ? { actor: record.actor } : {}),
      ...(record.correlationId ? { correlationId: record.correlationId } : {}),
      ...(record.parentSequence !== undefined ? { parentSequence: record.parentSequence } : {}),
      data: truncateTraceData(record.data),
    };
    response.write(`id: ${eventId}\nevent: run-event\ndata: ${JSON.stringify(envelope)}\n\n`);
  };
  const streamRunEvents = async (request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> => {
    const active = manager.get(runId);
    const persisted = await loadPersistedRun(config.runtime.artifactRoot, runId);
    if (!active && !persisted) { json(response, 404, { error: "run not found" }); return; }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write("retry: 2000\n\n");
    streamClients.add(response);
    let closed = false;
    const lastEventId = String(request.headers["last-event-id"] ?? "");
    const resumeValue = lastEventId.includes(":") ? lastEventId.slice(lastEventId.lastIndexOf(":") + 1) : (lastEventId || new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).searchParams.get("after") || "0");
    let lastSequence = Number(resumeValue);
    if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) lastSequence = 0;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); streamClients.delete(response); };
    response.on("close", cleanup);
    const poll = async () => {
      if (closed) return;
      try {
        const records = await readAuditRecords(join(config.runtime.artifactRoot, runId, "audit.jsonl"));
        for (const record of records.sort((left, right) => left.sequence - right.sequence)) if (record.sequence > lastSequence) { sendStreamRecord(response, runId, record); lastSequence = record.sequence; }
        const current = manager.get(runId)?.status ?? (await loadPersistedRun(config.runtime.artifactRoot, runId))?.status;
        if (current && terminalStatuses.has(current)) { response.end(); cleanup(); return; }
      } catch {
        // The stream is a delivery channel; the HTTP snapshot and trace remain authoritative.
      }
      timer = setTimeout(() => { void poll(); }, 250);
    };
    await poll();
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", service: "zhulong-xuanshu", version: "0.2.2" });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui" || !url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/health"))) {
        const built = await frontendAsset(url.pathname, frontendRoot);
        if (built) { asset(response, built); return; }
        html(response, dashboardHtml());
        return;
      }
      if (!authorized(request, config)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/question-bank") {
        json(response, 200, { questionBank: await questionBankSnapshot(questionBank, questionBankProgress) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/permissions") {
        json(response, 200, { permissions: permissionBroker.list() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/campaigns") {
        json(response, 200, { campaigns: await adaptiveCampaigns.list() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/campaigns") {
        try {
          const campaign = await adaptiveCampaigns.start(adaptiveCampaignInput(await bodyJson(request)));
          json(response, 202, { campaign, statusUrl: `/v1/campaigns/${campaign.id}` });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const campaignStopMatch = url.pathname.match(/^\/v1\/campaigns\/([0-9a-f-]+)\/stop$/i);
      if (request.method === "POST" && campaignStopMatch?.[1]) {
        const campaign = await adaptiveCampaigns.stop(campaignStopMatch[1]);
        if (!campaign) json(response, 404, { error: "Campaign not found" });
        else json(response, 202, { campaign });
        return;
      }
      const campaignMatch = url.pathname.match(/^\/v1\/campaigns\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && campaignMatch?.[1]) {
        const campaign = await adaptiveCampaigns.get(campaignMatch[1]);
        if (!campaign) json(response, 404, { error: "Campaign not found" });
        else json(response, 200, { campaign });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/agents") {
        json(response, 200, await agentStore.snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/memory") {
        json(response, 200, { records: await memoryStore.list({ ...(url.searchParams.get("userId") ? { userId: url.searchParams.get("userId")! } : {}), ...(url.searchParams.get("projectId") ? { projectId: url.searchParams.get("projectId")! } : {}), includeDisabled: url.searchParams.get("includeDisabled") === "true" }) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/memory") {
        const input = inputRecord(await bodyJson(request));
        if (!input || !["user", "project"].includes(String(input.scope)) || !["note", "synthesized"].includes(String(input.kind)) || typeof input.scopeId !== "string" || typeof input.content !== "string") { json(response, 400, { error: "scope, scopeId, kind, content, and ttlMs are required" }); return; }
        await clientRequest(response, async () => ({ record: await memoryStore.add({ scope: input.scope as MemoryScope, scopeId: input.scopeId as string, kind: input.kind as MemoryKind, content: input.content as string, ...(Array.isArray(input.sourceSessionIds) && input.sourceSessionIds.every((item) => typeof item === "string") ? { sourceSessionIds: input.sourceSessionIds as string[] } : {}), ...(["low", "medium", "high"].includes(String(input.confidence)) ? { confidence: input.confidence as MemoryConfidence } : {}), ...(typeof input.userConfirmed === "boolean" ? { userConfirmed: input.userConfirmed } : {}), ttlMs: Number(input.ttlMs) }) }), 201); return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/memory") {
        const scope = url.searchParams.get("scope"); const kind = url.searchParams.get("kind"); const scopeId = url.searchParams.get("scopeId");
        if (scope !== null && !["user", "project"].includes(scope)) { json(response, 400, { error: "scope is invalid" }); return; }
        if (kind !== null && !["note", "synthesized"].includes(kind)) { json(response, 400, { error: "kind is invalid" }); return; }
        if (scope === null && kind === null && scopeId === null) { json(response, 400, { error: "memory clear requires at least one filter" }); return; }
        json(response, 200, { removed: await memoryStore.clear({ ...(scope ? { scope: scope as MemoryScope } : {}), ...(kind ? { kind: kind as MemoryKind } : {}), ...(scopeId ? { scopeId } : {}) }) }); return;
      }
      const memoryMatch = url.pathname.match(/^\/v1\/memory\/([0-9a-f-]+)$/i);
      if (request.method === "PATCH" && memoryMatch?.[1]) {
        const input = inputRecord(await bodyJson(request));
        await clientRequest(response, async () => ({ record: await memoryStore.update(memoryMatch[1]!, { ...(typeof input.content === "string" ? { content: input.content } : {}), ...(["active", "disabled"].includes(String(input.status)) ? { status: input.status as MemoryStatus } : {}), ...(typeof input.userConfirmed === "boolean" ? { userConfirmed: input.userConfirmed } : {}), ...(["low", "medium", "high"].includes(String(input.confidence)) ? { confidence: input.confidence as MemoryConfidence } : {}), ...(input.ttlMs === undefined ? {} : { ttlMs: Number(input.ttlMs) }) }) })); return;
      }
      if (request.method === "DELETE" && memoryMatch?.[1]) {
        if (await memoryStore.remove(memoryMatch[1])) json(response, 200, { removed: true }); else json(response, 404, { error: "memory record not found" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/workflows") { json(response, 200, await workflowStore.snapshot()); return; }
      if (request.method === "POST" && url.pathname === "/v1/workflows") {
        try {
          const input = await bodyJson(request) as Record<string, unknown>;
          if (!input || typeof input.name !== "string") throw new Error("name is required");
          const workflow = await workflowStore.create({ name: input.name, nodes: workflowNodes(input.nodes), budget: workflowBudget(input.budget, config) });
          json(response, 202, { workflow, statusUrl: `/v1/workflows/${workflow.id}` });
        } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      const workflowMatch = url.pathname.match(/^\/v1\/workflows\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && workflowMatch?.[1]) { const workflow = await workflowStore.get(workflowMatch[1]); if (workflow) json(response, 200, { workflow }); else json(response, 404, { error: "workflow not found" }); return; }
      const workflowCancelMatch = url.pathname.match(/^\/v1\/workflows\/([0-9a-f-]+)\/cancel$/i);
      if (request.method === "POST" && workflowCancelMatch?.[1]) { const workflow = await workflowStore.get(workflowCancelMatch[1]); if (!workflow) json(response, 404, { error: "workflow not found" }); else await clientRequest(response, async () => { await workflowWorker.cancel(workflow.id); return { workflow: await workflowStore.get(workflow.id) }; }, 202); return; }
      if (request.method === "GET" && url.pathname === "/v1/connectors") { json(response, 200, { connectors: connectorBroker.list() }); return; }
      const connectorRegisterMatch = url.pathname.match(/^\/v1\/connectors\/([A-Za-z0-9_.-]+)\/register$/);
      if (request.method === "POST" && connectorRegisterMatch?.[1]) { const input = inputRecord(await bodyJson(request)); if (typeof input.instanceId !== "string") { json(response, 400, { error: "instanceId is required" }); return; } await clientRequest(response, async () => ({ connector: connectorBroker.register(connectorRegisterMatch[1]!, input.instanceId as string) })); return; }
      const connectorHeartbeatMatch = url.pathname.match(/^\/v1\/connectors\/([A-Za-z0-9_.-]+)\/heartbeat$/);
      if (request.method === "POST" && connectorHeartbeatMatch?.[1]) { const input = inputRecord(await bodyJson(request)); await clientRequest(response, async () => ({ connector: connectorBroker.heartbeat(connectorHeartbeatMatch[1]!, String(input.instanceId ?? ""), Number(input.generation)) })); return; }
      const connectorDisconnectMatch = url.pathname.match(/^\/v1\/connectors\/([A-Za-z0-9_.-]+)\/disconnect$/);
      if (request.method === "POST" && connectorDisconnectMatch?.[1]) { const input = inputRecord(await bodyJson(request)); await clientRequest(response, async () => { connectorBroker.disconnect(connectorDisconnectMatch[1]!, String(input.instanceId ?? ""), Number(input.generation)); return { connector: connectorBroker.get(connectorDisconnectMatch[1]!) }; }); return; }
      const connectorClaimMatch = url.pathname.match(/^\/v1\/connectors\/([A-Za-z0-9_.-]+)\/claim$/);
      if (request.method === "POST" && connectorClaimMatch?.[1]) { const input = inputRecord(await bodyJson(request)); await clientRequest(response, async () => ({ task: connectorBroker.claim(connectorClaimMatch[1]!, String(input.instanceId ?? ""), Number(input.generation), Math.min(Number(input.leaseMs) || 30_000, 120_000)) ?? null })); return; }
      const connectorResultMatch = url.pathname.match(/^\/v1\/connectors\/([A-Za-z0-9_.-]+)\/tasks\/([0-9a-f-]+)$/i);
      if (request.method === "POST" && connectorResultMatch?.[1] && connectorResultMatch[2]) { const input = inputRecord(await bodyJson(request)); await clientRequest(response, async () => { connectorBroker.resolve(connectorResultMatch[1]!, String(input.instanceId ?? ""), Number(input.generation), connectorResultMatch[2]!, Number(input.leaseGeneration), { ...(input.result === undefined ? {} : { result: input.result }), ...(typeof input.error === "string" ? { error: input.error } : {}) }); return { accepted: true }; }); return; }
      if (request.method === "GET" && url.pathname === "/v1/knowledge") {
        try { json(response, 200, { documents: await knowledgeStore.list(boundedLimit(url.searchParams.get("limit"), 100, 1_000)) }); }
        catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/knowledge") {
        const input = inputRecord(await bodyJson(request));
        if (typeof input.sourceUrl !== "string" || typeof input.title !== "string" || typeof input.mediaType !== "string" || typeof input.source !== "string" || typeof input.summary !== "string" || !["operator", "verified", "community", "untrusted"].includes(String(input.trust))) { json(response, 400, { error: "sourceUrl, title, mediaType, trust, source, and summary are required" }); return; }
        const stringList = (key: string): string[] | undefined => { const value = input[key]; if (value === undefined) return undefined; if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${key} must be an array of strings`); return value as string[]; };
        await clientRequest(response, async () => {
          const keyParameters = stringList("keyParameters"); const codeSnippets = stringList("codeSnippets"); const citations = stringList("citations");
          return { document: await knowledgeStore.ingest({ ...(typeof input.docId === "string" ? { docId: input.docId } : {}), sourceUrl: input.sourceUrl as string, title: input.title as string, mediaType: input.mediaType as string, trust: input.trust as KnowledgeTrust, source: input.source as string, ...(typeof input.markdown === "string" ? { markdown: input.markdown } : {}), summary: input.summary as string, ...(keyParameters ? { keyParameters } : {}), ...(codeSnippets ? { codeSnippets } : {}), ...(citations ? { citations } : {}) }) };
        }, 201); return;
      }
      const knowledgeMatch = url.pathname.match(/^\/v1\/knowledge\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/);
      if (request.method === "GET" && knowledgeMatch?.[1]) { const document = await knowledgeStore.get(knowledgeMatch[1]); if (document) json(response, 200, { document }); else json(response, 404, { error: "knowledge document not found" }); return; }
      if (request.method === "DELETE" && knowledgeMatch?.[1]) { if (await knowledgeStore.remove(knowledgeMatch[1])) json(response, 200, { removed: true }); else json(response, 404, { error: "knowledge document not found" }); return; }
      if (request.method === "GET" && url.pathname === "/v1/evaluations") {
        try { json(response, 200, { manifests: await evaluationLedger.listManifests(boundedLimit(url.searchParams.get("limit"), 64, 64)) }); }
        catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/evaluations") {
        const input = inputRecord(await bodyJson(request)); const model = inputRecord(input.model, "model"); const budget = inputRecord(input.budget, "budget");
        if (typeof input.suite !== "string" || typeof input.datasetVersion !== "string" || !["development", "validation", "hidden"].includes(String(input.split)) || typeof model.provider !== "string" || typeof model.id !== "string" || typeof model.thinkingLevel !== "string") { json(response, 400, { error: "suite, datasetVersion, split, model, and budget are required" }); return; }
        await clientRequest(response, async () => ({ manifest: await evaluationLedger.createManifest({ suite: input.suite as string, datasetVersion: input.datasetVersion as string, split: input.split as "development" | "validation" | "hidden", model: { provider: model.provider as string, id: model.id as string, thinkingLevel: model.thinkingLevel as string }, budget: { maxAttempts: Number(budget.maxAttempts), maxRuntimeMsPerAttempt: Number(budget.maxRuntimeMsPerAttempt), maxTokensPerAttempt: Number(budget.maxTokensPerAttempt), maxCostMicrosPerAttempt: Number(budget.maxCostMicrosPerAttempt), networkAllowed: budget.networkAllowed === true }, ...(Array.isArray(input.artifactPaths) && input.artifactPaths.every((item) => typeof item === "string") ? { artifactPaths: input.artifactPaths as string[] } : {}), ...(input.containerDigests && typeof input.containerDigests === "object" && !Array.isArray(input.containerDigests) ? { containerDigests: input.containerDigests as Record<string, string> } : {}) }) }), 201); return;
      }
      const evaluationMatch = url.pathname.match(/^\/v1\/evaluations\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && evaluationMatch?.[1]) { await clientRequest(response, async () => ({ report: await evaluationLedger.report(evaluationMatch[1]!), attempts: await evaluationLedger.listAttempts(evaluationMatch[1]!, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) })); return; }
      const evaluationAttemptMatch = url.pathname.match(/^\/v1\/evaluations\/([0-9a-f-]+)\/attempts$/i);
      if (request.method === "POST" && evaluationAttemptMatch?.[1]) {
        const input = inputRecord(await bodyJson(request)); const trace = inputRecord(input.trace, "trace");
        const attempt = { manifestId: evaluationAttemptMatch[1], taskId: String(input.taskId ?? ""), runId: String(input.runId ?? ""), outcome: input.outcome as EvaluationAttempt["outcome"], durationMs: Number(input.durationMs), tokensUsed: Number(input.tokensUsed), costMicros: Number(input.costMicros), toolCalls: Number(input.toolCalls), ...(input.timeToFirstHypothesisMs === undefined ? {} : { timeToFirstHypothesisMs: Number(input.timeToFirstHypothesisMs) }), ...(typeof input.errorCode === "string" ? { errorCode: input.errorCode as NonNullable<EvaluationAttempt["errorCode"]> } : {}), trace: { ...(typeof trace.auditPath === "string" ? { auditPath: trace.auditPath } : {}), ...(typeof trace.auditSha256 === "string" ? { auditSha256: trace.auditSha256 } : {}), runArtifactId: String(trace.runArtifactId ?? "") } };
        await clientRequest(response, async () => ({ attempt: await evaluationLedger.record(attempt) }), 201); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        const input = await bodyJson(request) as Record<string, unknown>;
        if (!input || !["joined", "addressable"].includes(String(input.purpose)) || typeof input.profileId !== "string") {
          json(response, 400, { error: "purpose and profileId are required" });
          return;
        }
        const agent = await agentStore.createAgent({
          purpose: input.purpose as AgentPurpose,
          profileId: input.profileId,
          ...(typeof input.parentAgentId === "string" ? { parentAgentId: input.parentAgentId } : {}),
        });
        json(response, 201, { agent });
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && agentMatch?.[1]) {
        const value = await agentStore.getAgent(agentMatch[1]);
        if (!value) json(response, 404, { error: "agent not found" }); else json(response, 200, value);
        return;
      }
      const agentTaskMatch = url.pathname.match(/^\/v1\/agents\/([0-9a-f-]+)\/tasks$/i);
      if (request.method === "POST" && agentTaskMatch?.[1]) {
        const input = await bodyJson(request) as Record<string, unknown>;
        if (typeof input.message !== "string") { json(response, 400, { error: "message is required" }); return; }
        const context = input.context === undefined ? undefined : input.context;
        if (context !== undefined && (!Array.isArray(context) || context.some((item) => typeof item !== "string"))) { json(response, 400, { error: "context must be an array of strings" }); return; }
        const task = await agentStore.followupTask(agentTaskMatch[1], input.message, {
          ...(typeof input.parentTaskId === "string" ? { parentTaskId: input.parentTaskId } : {}),
          ...(typeof input.ownerTurnId === "string" ? { ownerTurnId: input.ownerTurnId } : {}),
          ...(input.awaitPolicy === "join" || input.awaitPolicy === "background" ? { awaitPolicy: input.awaitPolicy } : {}),
          ...(input.cancelPolicy === "linked" || input.cancelPolicy === "detached" ? { cancelPolicy: input.cancelPolicy } : {}),
          ...(context ? { context: context as string[] } : {}),
          budget: agentTaskBudget(input.budget, config),
        });
        json(response, 202, { task, statusUrl: `/v1/agent-tasks/${task.id}` });
        return;
      }
      const agentMessageMatch = url.pathname.match(/^\/v1\/agents\/([0-9a-f-]+)\/messages$/i);
      if (request.method === "POST" && agentMessageMatch?.[1]) {
        const input = await bodyJson(request) as Record<string, unknown>;
        if (typeof input.text !== "string") { json(response, 400, { error: "text is required" }); return; }
        json(response, 201, { message: await agentStore.sendMessage(agentMessageMatch[1], input.text, typeof input.senderAgentId === "string" ? input.senderAgentId : undefined) });
        return;
      }
      const agentInterruptMatch = url.pathname.match(/^\/v1\/agents\/([0-9a-f-]+)\/interrupt$/i);
      if (request.method === "POST" && agentInterruptMatch?.[1]) {
        await agentWorker.interruptAgent(agentInterruptMatch[1]);
        json(response, 202, { agent: (await agentStore.getAgent(agentInterruptMatch[1]))?.agent });
        return;
      }
      const agentTaskStatusMatch = url.pathname.match(/^\/v1\/agent-tasks\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && agentTaskStatusMatch?.[1]) {
        const waitMs = Math.max(0, Math.min(Number(url.searchParams.get("waitMs") ?? 0) || 0, 30_000));
        if (waitMs > 0) {
          const controller = new AbortController();
          const abort = () => controller.abort(new Error("Agent task wait connection closed"));
          request.once("aborted", abort);
          try { await agentStore.waitResult(agentTaskStatusMatch[1], { timeoutMs: waitMs, signal: controller.signal }); }
          finally { request.off("aborted", abort); }
        }
        const value = await agentStore.getTask(agentTaskStatusMatch[1]);
        if (!value) json(response, 404, { error: "agent task not found" }); else json(response, 200, value);
        return;
      }
      const agentTaskAckMatch = url.pathname.match(/^\/v1\/agent-tasks\/([0-9a-f-]+)\/ack$/i);
      if (request.method === "POST" && agentTaskAckMatch?.[1]) {
        json(response, 200, { result: await agentStore.acknowledge(agentTaskAckMatch[1]) });
        return;
      }
      const permissionMatch = url.pathname.match(/^\/v1\/permissions\/([0-9a-f-]+)$/i);
      if (request.method === "POST" && permissionMatch?.[1]) {
        const input = await bodyJson(request) as { decision?: unknown };
        if (!["deny", "approve_once", "approve_session"].includes(String(input.decision))) {
          json(response, 400, { error: "decision must be deny, approve_once, or approve_session" });
          return;
        }
        const resolution = permissionBroker.resolve(permissionMatch[1], input.decision as PermissionDecision);
        if (!resolution) json(response, 404, { error: "permission request not found" });
        else json(response, 200, { resolution });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/settings/model") {
        json(response, 200, { model: runtime.modelStatus() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/settings/model") {
        try {
          const input = modelSessionInput(await bodyJson(request));
          runtime.configureModel(input);
          json(response, 200, { model: runtime.modelStatus() });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/settings/model") {
        runtime.clearConfiguredModel();
        json(response, 200, { model: runtime.modelStatus() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/question-bank/jobs") {
        try {
          const body = await bodyJson(request);
          const record = body && typeof body === "object" && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {};
          const questions = await questionBank.load();
          if (questions.length === 0) throw new Error("Question bank is empty");
          await questionBankProgress.syncCompletedRunArtifacts(questions);
          const pending = await questionBankProgress.pending(questions);
          if (pending.length === 0) throw new Error("All question-bank entries have already been solved");
          const input = validateManualJobInput({
            tasks: pending.map((question) => questionToTaskRequest(question)),
            concurrency: 1,
            raceAgents: config.questionBank?.raceAgents ?? 1,
            writeup: record.writeup === undefined ? true : record.writeup,
            strictSubmission: true,
            skipBlocked: true,
            transientRetryLimit: 2,
          });
          const pendingById = new Map(pending.map((question) => [question.id, question]));
          const job = manualJobs.start(input, {
            prepareTask: async (task, signal) => {
              const questionId = task.metadata?.questionId;
              const question = questionId ? pendingById.get(questionId) : undefined;
              if (!question) throw new Error("Question-bank task no longer matches the configured bank");
              return await questionBankInstances.prepare(question, signal);
            },
            onTaskSettled: async ({ request: task, state }) => {
              const questionId = task.metadata?.questionId;
              const question = questionId ? pendingById.get(questionId) : undefined;
              if (question) await questionBankProgress.recordCompleted(question, state);
            },
          });
          json(response, 202, { job, statusUrl: `/v1/manual/jobs/${job.id}` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(response, 400, { error: message });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const input = await bodyJson(request);
        if (!isTaskRequest(input)) {
          json(response, 400, { error: "body must contain task and optional string attachments" });
          return;
        }
        const id = manager.start(input);
        json(response, 202, { id, status: "queued", statusUrl: `/v1/runs/${id}` });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/manual/uploads") {
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Upload connection closed"));
        request.once("aborted", abort);
        try {
          const uploadId = singleHeader(request, "x-upload-id");
          const contentLength = uploadContentLength(request);
          const upload = await manualUploads.save(request, {
            fileName: uploadFileName(request),
            ...(uploadId ? { uploadId } : {}),
            ...(contentLength === undefined ? {} : { contentLength }),
          }, controller.signal);
          json(response, 201, { upload });
        } catch (error) {
          const status = error instanceof ManualUploadError ? error.status : 500;
          json(response, status, { error: error instanceof Error ? error.message : String(error) });
        } finally {
          request.off("aborted", abort);
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/manual/jobs") {
        json(response, 200, { jobs: manualJobs.list() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/manual/jobs") {
        let claimedUploadId: string | undefined;
        try {
          const body = await bodyJson(request);
          const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
          if (record?.uploadId !== undefined && typeof record.uploadId !== "string") {
            throw new ManualUploadError("uploadId must be a string");
          }
          const uploadId = record?.uploadId as string | undefined;
          const input = validateManualJobInput(body);
          const withAttachments = uploadId ? attachUploadedFiles(input, manualUploads.paths(uploadId)) : input;
          if (uploadId) {
            manualUploads.claim(uploadId);
            claimedUploadId = uploadId;
          }
          const job = manualJobs.start(withAttachments, {
            ...(uploadId ? { onSettled: async () => await manualUploads.release(uploadId) } : {}),
          });
          json(response, 202, { job, statusUrl: `/v1/manual/jobs/${job.id}` });
        } catch (error) {
          if (claimedUploadId) await manualUploads.release(claimedUploadId);
          const status = error instanceof ManualUploadError ? error.status : 400;
          json(response, status, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const manualStopMatch = url.pathname.match(/^\/v1\/manual\/jobs\/([0-9a-f-]+)\/stop$/i);
      if (request.method === "POST" && manualStopMatch?.[1]) {
        const job = manualJobs.stop(manualStopMatch[1]);
        if (!job) json(response, 404, { error: "Manual job not found" });
        else json(response, 202, { job });
        return;
      }
      const manualJobMatch = url.pathname.match(/^\/v1\/manual\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && manualJobMatch?.[1]) {
        const job = manualJobs.get(manualJobMatch[1]);
        if (!job) json(response, 404, { error: "Manual job not found" });
        else json(response, 200, { job });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/disclosures") {
        const windowParam = url.searchParams.get("windowDays");
        const windowDays = windowParam === null ? undefined : Number.parseInt(windowParam, 10);
        if (windowDays !== undefined && (!Number.isFinite(windowDays) || windowDays < 0)) {
          json(response, 400, { error: "windowDays must be a non-negative integer" });
          return;
        }
        const listed = await disclosureLedger.list(windowDays);
        json(response, 200, { ...listed, reasonLabels: DISCLOSURE_REASON_LABELS });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/disclosures") {
        const input = await bodyJson(request);
        try {
          const body = input as { runId?: unknown; taskId?: unknown; reason?: unknown; detail?: unknown; disclosedBy?: unknown };
          const record = await disclosureLedger.disclose(body);
          json(response, 201, { record });
        } catch (error) {
          const status = error instanceof DisclosureLedgerError ? error.status : 500;
          json(response, status, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        const persisted = await listPersistedRuns(config.runtime.artifactRoot);
        const known = new Set(persisted.map((run) => run.id));
        const active = manager.list().filter((run) => !known.has(run.id)).map((run) => ({
          id: run.id,
          status: run.status,
          phase: run.state?.phase ?? "intake",
          task: run.state?.task.task ?? "Queued run",
          createdAt: run.state?.createdAt ?? new Date().toISOString(),
          turns: run.state?.turns ?? 0,
          toolCalls: run.state?.toolCalls ?? 0,
          lessons: run.state?.lessons.length ?? 0,
        }));
        json(response, 200, { runs: [...active, ...persisted] });
        return;
      }
      const eventsMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/events$/i);
      if (request.method === "GET" && eventsMatch?.[1]) {
        await streamRunEvents(request, response, eventsMatch[1]);
        return;
      }
      const traceMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/trace$/i);
      if (request.method === "GET" && traceMatch?.[1]) {
        json(response, 200, await loadDecisionTrace(config.runtime.artifactRoot, traceMatch[1]));
        return;
      }
      const continuationMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/(fork|resume)$/i);
      if (request.method === "POST" && continuationMatch?.[1] && continuationMatch[2]) {
        const parentRunId = continuationMatch[1];
        const mode = continuationMatch[2].toLowerCase() as "fork" | "resume";
        const parent = manager.get(parentRunId)?.state ?? await loadPersistedRun(config.runtime.artifactRoot, parentRunId);
        if (!parent) { json(response, 404, { error: "parent run not found" }); return; }
        const input = inputRecord(await bodyJson(request));
        if (input.boundarySequence !== undefined && !Number.isSafeInteger(input.boundarySequence)) {
          json(response, 400, { error: "boundarySequence must be a safe integer" });
          return;
        }
        if (input.instruction !== undefined && typeof input.instruction !== "string") {
          json(response, 400, { error: "instruction must be a string" });
          return;
        }
        try {
          const prepared = await prepareRunContinuation(
            config.runtime.artifactRoot,
            parentRunId,
            mode,
            input.boundarySequence === undefined ? undefined : Number(input.boundarySequence),
            typeof input.instruction === "string" ? input.instruction : undefined,
          );
          const id = manager.start(prepared.request, { workspaceMode: prepared.workspaceMode, lineage: prepared.lineage });
          json(response, 202, { id, status: "queued", statusUrl: `/v1/runs/${id}`, lineage: prepared.lineage });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const reviewMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/reviews$/i);
      if (request.method === "POST" && reviewMatch?.[1]) {
        const input = await bodyJson(request) as Record<string, unknown>;
        if (
          !Number.isInteger(input.sequence) ||
          !["correct", "incorrect", "uncertain"].includes(String(input.verdict)) ||
          typeof input.note !== "string"
        ) {
          json(response, 400, { error: "review requires sequence, verdict, and note" });
          return;
        }
        const reviewInput = {
          sequence: Number(input.sequence),
          verdict: input.verdict as "correct" | "incorrect" | "uncertain",
          note: input.note,
          ...(typeof input.correction === "string" ? { correction: input.correction } : {}),
        };
        json(response, 201, await appendRunReview(config.runtime.artifactRoot, reviewMatch[1], reviewInput));
        return;
      }
      const writeupMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/writeup$/i);
      if (request.method === "POST" && writeupMatch?.[1]) {
        const id = writeupMatch[1];
        const active = manager.get(id);
        const state = active?.state ?? await loadPersistedRun(config.runtime.artifactRoot, id);
        if (!state) { json(response, 404, { error: "run not found" }); return; }
        if (!["completed", "blocked", "failed", "aborted"].includes(state.status)) { json(response, 409, { error: "run must be terminal before generating a writeup" }); return; }
        if (state.writeup?.trim()) { json(response, 200, { writeup: state.writeup, state }); return; }
        await new AuditChain(join(config.runtime.artifactRoot, id, "audit.jsonl"), id).append("writeup.generation_requested", {
          status: state.status,
          submissionPresent: Boolean(state.submission),
          source: "operator_request",
        }, { source: "orchestrator", actor: "writeup-generator" });
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Writeup generation connection closed"));
        request.once("aborted", abort);
        try {
          let transcript: unknown[] = [];
          try {
            const value = JSON.parse(await readFile(join(config.runtime.artifactRoot, id, "transcript.json"), "utf8"));
            if (Array.isArray(value)) transcript = value;
          } catch { /* A missing transcript still permits a bounded structured writeup. */ }
          const generatedWriteup = await runtime.generateWriteup(state, transcript, controller.signal);
          state.writeup = generatedWriteup;
          delete state.writeupError;
          await new AuditChain(join(config.runtime.artifactRoot, id, "audit.jsonl"), id).append("writeup.generated", { characters: generatedWriteup.length, source: "operator_request" }, { source: "orchestrator", actor: "writeup-generator" });
          await writeRunState(join(config.runtime.artifactRoot, id), state);
          json(response, 200, { writeup: state.writeup, state });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.writeupError = sanitizeSensitiveText(message).slice(0, 600);
          await new AuditChain(join(config.runtime.artifactRoot, id, "audit.jsonl"), id).append("writeup.failed", { error: state.writeupError, source: "operator_request" }, { source: "orchestrator", actor: "writeup-generator" });
          await writeRunState(join(config.runtime.artifactRoot, id), state);
          json(response, 400, { error: state.writeupError, state });
        } finally { request.off("aborted", abort); }
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/experiences") {
        json(response, 200, { experiences: await experience.list() });
        return;
      }
      const experienceMatch = url.pathname.match(/^\/v1\/experiences\/([a-z0-9_-]+)$/i);
      if (request.method === "PATCH" && experienceMatch?.[1]) {
        const input = await bodyJson(request) as ExperienceUpdate;
        if (input.status !== undefined && input.status !== "active" && input.status !== "disabled") {
          json(response, 400, { error: "experience status must be active or disabled" });
          return;
        }
        json(response, 200, await experience.update(experienceMatch[1], input));
        return;
      }
      const match = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && match?.[1]) {
        const id = match[1];
        const active = manager.get(id);
        const persistedState = active ? undefined : await loadPersistedRun(config.runtime.artifactRoot, id);
        const snapshot = active ?? (persistedState ? { id, status: persistedState.status, state: persistedState, events: [] } : undefined);
        if (!snapshot) json(response, 404, { error: "run not found" });
        else json(response, 200, snapshot);
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, error instanceof RequestInputError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { server, manager, manualJobs, manualUploads, questionBank, permissionBroker, agentStore, agentWorker, memoryStore, workflowStore, workflowWorker, connectorBroker, evaluationLedger, knowledgeStore, adaptiveCampaigns, closeStreams: () => { for (const client of streamClients) client.end(); streamClients.clear(); } };
}

export async function startApiServer(
  config: AppConfig,
  dependencies: ApiServerDependencies = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(config.server.host) && !process.env[config.server.tokenEnv]) {
    throw new Error(`Refusing non-loopback API without ${config.server.tokenEnv}`);
  }
  await recoverInterruptedRuns(config.runtime.artifactRoot);
  // One loopback gateway per API process: every embedded agent session and
  // writeup subprocess routes through it, so credential injection, request
  // gating, and model audit stay centralized. Owned here unless injected.
  const gateway = dependencies.gateway ?? await startModelGateway();
  const { server, manualJobs, manualUploads, agentWorker, workflowWorker, adaptiveCampaigns, closeStreams } = createApiServer(config, { ...dependencies, gateway });
  await adaptiveCampaigns.resumePending();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, resolveListen);
  });
  const address = server.address() as AddressInfo;
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    close: async () => {
      closeStreams();
      await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
      await manualJobs.close();
      await manualUploads.close();
      await adaptiveCampaigns.close();
      await agentWorker.close();
      await workflowWorker.close();
      // Stop the gateway last: workers may still drain in-flight runs whose
      // next model request needs its route.
      await gateway.stop();
    },
  };
}

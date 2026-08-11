import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { AppConfig, TaskRequest } from "./types.js";
import { dashboardHtml } from "./dashboard.js";
import { ExperienceStore, type ExperienceUpdate } from "./experience.js";
import { RunManager } from "./run-manager.js";
import { XuanShuRuntime } from "./runtime.js";
import { appendRunReview, listPersistedRuns, loadDecisionTrace, loadPersistedRun, readAuditRecords, truncateTraceData } from "./trace.js";
import { ArenaJobManager } from "./arena-jobs.js";
import { ManualJobManager, validateManualJobInput } from "./manual-jobs.js";
import { ManualUploadError, ManualUploadStore } from "./manual-uploads.js";
import { QuestionBank, questionToTaskRequest } from "./question-bank.js";
import { QuestionBankInstanceRunner } from "./question-bank-instances.js";
import { QuestionBankProgressStore } from "./question-bank-progress.js";

const MAX_BODY_BYTES = 1024 * 1024;

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
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  arenaJobs?: ArenaJobManager;
  manualJobs?: ManualJobManager;
  manualUploads?: ManualUploadStore;
  questionBank?: QuestionBank;
  questionBankProgress?: QuestionBankProgressStore;
  questionBankInstances?: QuestionBankInstanceRunner;
  frontendRoot?: string;
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
  const manager = new RunManager(new XuanShuRuntime(config));
  const experience = new ExperienceStore(config.runtime.artifactRoot);
  const arenaJobs = dependencies.arenaJobs ?? new ArenaJobManager(config);
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
    const envelope = { streamVersion: 1, runId, eventId, sequence: record.sequence, type: record.type, timestamp: record.timestamp, data: truncateTraceData(record.data) };
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
      if (request.method === "GET" && url.pathname === "/v1/arena/status") {
        const [readiness, wrongQuestions] = await Promise.all([
          arenaJobs.readiness(),
          arenaJobs.listWrongQuestions(),
        ]);
        json(response, 200, { readiness, jobs: arenaJobs.list(), wrongQuestions });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/arena/jobs") {
        const input = await bodyJson(request) as Record<string, unknown>;
        const maxAttempts = input.maxAttempts === undefined ? 1 : Number(input.maxAttempts);
        const idleSeconds = input.idleSeconds === undefined ? 1 : Number(input.idleSeconds);
        const autoSubmit = input.autoSubmit === undefined ? true : input.autoSubmit;
        const continuous = input.continuous === undefined ? true : input.continuous;
        if (typeof autoSubmit !== "boolean") {
          json(response, 400, { error: "autoSubmit must be a boolean" });
          return;
        }
        if (typeof continuous !== "boolean") {
          json(response, 400, { error: "continuous must be a boolean" });
          return;
        }
        try {
          const job = arenaJobs.start({ maxAttempts, idleSeconds, autoSubmit, continuous });
          json(response, 202, { job, statusUrl: `/v1/arena/jobs/${job.id}` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(response, message.includes("already active") ? 409 : 400, { error: message });
        }
        return;
      }
      const wrongQuestionMatch = url.pathname.match(/^\/v1\/arena\/wrong-questions\/(\d+)$/);
      if (request.method === "GET" && wrongQuestionMatch?.[1]) {
        const wrongQuestion = await arenaJobs.getWrongQuestion(Number(wrongQuestionMatch[1]));
        if (!wrongQuestion) json(response, 404, { error: "Arena wrong question not found" });
        else json(response, 200, { wrongQuestion });
        return;
      }
      const arenaStopMatch = url.pathname.match(/^\/v1\/arena\/jobs\/([0-9a-f-]+)\/stop$/i);
      if (request.method === "POST" && arenaStopMatch?.[1]) {
        const job = arenaJobs.stop(arenaStopMatch[1]);
        if (!job) json(response, 404, { error: "Arena job not found" });
        else json(response, 202, { job });
        return;
      }
      const arenaJobMatch = url.pathname.match(/^\/v1\/arena\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && arenaJobMatch?.[1]) {
        const job = arenaJobs.get(arenaJobMatch[1]);
        if (!job) json(response, 404, { error: "Arena job not found" });
        else json(response, 200, { job });
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
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { server, manager, arenaJobs, manualJobs, manualUploads, questionBank, closeStreams: () => { for (const client of streamClients) client.end(); streamClients.clear(); } };
}

export async function startApiServer(
  config: AppConfig,
  dependencies: ApiServerDependencies = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(config.server.host) && !process.env[config.server.tokenEnv]) {
    throw new Error(`Refusing non-loopback API without ${config.server.tokenEnv}`);
  }
  const { server, arenaJobs, manualJobs, manualUploads, closeStreams } = createApiServer(config, dependencies);
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
      await arenaJobs.close();
      await manualJobs.close();
      await manualUploads.close();
    },
  };
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import type { AppConfig, TaskRequest } from "./types.js";
import { dashboardHtml } from "./dashboard.js";
import { ExperienceStore, type ExperienceUpdate } from "./experience.js";
import { RunManager } from "./run-manager.js";
import { XuanShuRuntime } from "./runtime.js";
import { appendRunReview, listPersistedRuns, loadDecisionTrace, loadPersistedRun, readAuditRecords, truncateTraceData } from "./trace.js";

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

async function frontendAsset(pathname: string): Promise<{ body: Buffer; contentType: string } | undefined> {
  const assetRoot = join(process.cwd(), "frontend", "dist");
  const requested = pathname === "/" || !extname(pathname) ? "index.html" : pathname.slice(1);
  const candidate = normalize(join(assetRoot, requested));
  if (!candidate.startsWith(assetRoot)) return undefined;
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

export function createApiServer(config: AppConfig) {
  const manager = new RunManager(new XuanShuRuntime(config));
  const experience = new ExperienceStore(config.runtime.artifactRoot);
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
        const built = await frontendAsset(url.pathname);
        if (built) { asset(response, built); return; }
        html(response, dashboardHtml());
        return;
      }
      if (!authorized(request, config)) {
        json(response, 401, { error: "unauthorized" });
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
  return { server, manager, closeStreams: () => { for (const client of streamClients) client.end(); streamClients.clear(); } };
}

export async function startApiServer(config: AppConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(config.server.host) && !process.env[config.server.tokenEnv]) {
    throw new Error(`Refusing non-loopback API without ${config.server.tokenEnv}`);
  }
  const { server, closeStreams } = createApiServer(config);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, resolveListen);
  });
  const address = server.address() as AddressInfo;
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => { closeStreams(); server.close((error) => (error ? reject(error) : resolveClose())); }),
  };
}

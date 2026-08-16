import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { constants } from "node:fs";
import type { AddressInfo } from "node:net";
import { access, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isPathInside } from "./policy.js";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface SandboxExecRequest {
  program: string;
  args: string[];
  namespace?: string;
  cwd?: "scratch" | "workspace";
  stdin?: string;
  stdinEncoding?: "utf8" | "base64";
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBase64: string;
  stderrBase64: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxHealth {
  status: "ok";
  service: "ctf-sandbox";
  workspaceRoot: string;
  scratchRoot: string;
  allowedPrograms: string[];
  missingPrograms: string[];
  network: string;
  isolation: "run-namespace";
}

export interface SandboxServerOptions {
  socketPath: string;
  workspaceRoot: string;
  scratchRoot: string;
  allowedPrograms: string[];
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  network?: string;
}

type SandboxEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number };

function parseSandboxEndpoint(value: string, allowZeroPort = false): SandboxEndpoint {
  if (!value.startsWith("tcp://")) return { kind: "unix", path: value };
  const url = new URL(value);
  const port = Number(url.port);
  if (
    url.protocol !== "tcp:" ||
    !url.hostname ||
    !Number.isInteger(port) ||
    port < (allowZeroPort ? 0 : 1) ||
    port > 65535 ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(`Invalid sandbox TCP endpoint: ${value}`);
  }
  return { kind: "tcp", host: url.hostname, port };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function bodyJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Sandbox request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.includes("\0") && !value.split(/[\\/]/).includes("..");
}

function safeNamespace(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function validateExecInput(value: unknown): SandboxExecRequest {
  if (!value || typeof value !== "object") throw new Error("Sandbox exec request must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.program !== "string" || input.program.length === 0) throw new Error("program is required");
  if (input.namespace !== undefined && (typeof input.namespace !== "string" || !safeNamespace(input.namespace))) {
    throw new Error("namespace must contain only letters, numbers, underscores, or hyphens");
  }
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be an array of strings");
  }
  if (input.cwd !== undefined && input.cwd !== "scratch" && input.cwd !== "workspace") {
    throw new Error("cwd must be scratch or workspace");
  }
  if (input.stdin !== undefined && typeof input.stdin !== "string") throw new Error("stdin must be a string");
  if (input.stdinEncoding !== undefined && input.stdinEncoding !== "utf8" && input.stdinEncoding !== "base64") {
    throw new Error("stdinEncoding must be utf8 or base64");
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || Number(input.timeoutMs) <= 0)) {
    throw new Error("timeoutMs must be a positive integer");
  }
  if (
    input.maxOutputBytes !== undefined &&
    (!Number.isInteger(input.maxOutputBytes) || Number(input.maxOutputBytes) <= 0)
  ) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  return input as unknown as SandboxExecRequest;
}

function validateCommandPaths(workspaceRoot: string, scratchRoot: string, cwd: string, args: string[]): void {
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    if (arg.includes("\0")) throw new Error("Command argument contains a NUL byte");
    if (isAbsolute(arg)) {
      if (!isPathInside(workspaceRoot, arg) && !isPathInside(scratchRoot, arg)) {
        throw new Error(`Command argument points outside sandbox roots: ${arg}`);
      }
      continue;
    }
    if (!safeRelativePath(arg)) throw new Error(`Command argument contains an unsafe relative path: ${arg}`);
    if (!isPathInside(cwd, resolve(cwd, arg))) throw new Error(`Command argument escapes cwd: ${arg}`);
  }
}

function decodeStdin(input: SandboxExecRequest): Buffer | undefined {
  if (input.stdin === undefined) return undefined;
  return input.stdinEncoding === "base64" ? Buffer.from(input.stdin, "base64") : Buffer.from(input.stdin, "utf8");
}

async function programAvailable(program: string): Promise<boolean> {
  const name = basename(program);
  const paths = (process.env.PATH ?? DEFAULT_PATH).split(":").filter(Boolean);
  for (const entry of paths) {
    try {
      await access(resolve(entry, name), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function executeCommand(
  input: SandboxExecRequest,
  options: SandboxServerOptions,
  signal?: AbortSignal,
): Promise<SandboxExecResult> {
  signal?.throwIfAborted();
  const program = basename(input.program);
  if (!options.allowedPrograms.includes(program)) throw new Error(`Program is outside the sandbox allowlist: ${program}`);
  const scratchRoot = input.namespace
    ? resolve(options.scratchRoot, "runs", input.namespace)
    : options.scratchRoot;
  if (!isPathInside(options.scratchRoot, scratchRoot)) throw new Error("Sandbox namespace escapes scratchRoot");
  await mkdir(scratchRoot, { recursive: true });
  const [realBaseScratch, realScratch] = await Promise.all([realpath(options.scratchRoot), realpath(scratchRoot)]);
  if (!isPathInside(realBaseScratch, realScratch)) throw new Error("Sandbox namespace resolves outside scratchRoot");
  const scratchStats = await lstat(realScratch);
  if (!scratchStats.isDirectory() || scratchStats.isSymbolicLink()) throw new Error("Sandbox namespace is not a directory");
  const cwd = input.cwd === "workspace" ? options.workspaceRoot : realScratch;
  validateCommandPaths(options.workspaceRoot, realScratch, cwd, input.args);

  const timeoutMs = Math.min(input.timeoutMs ?? options.defaultTimeoutMs, options.defaultTimeoutMs);
  const maxOutputBytes = Math.min(input.maxOutputBytes ?? options.maxOutputBytes, options.maxOutputBytes);
  const stdin = decodeStdin(input);
  const started = Date.now();

  return await new Promise<SandboxExecResult>((resolveCommand, reject) => {
    const child = spawn(program, input.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? DEFAULT_PATH,
        HOME: realScratch,
        TMPDIR: realScratch,
        XUANSHU_RUN_NAMESPACE: input.namespace ?? "shared",
        LC_ALL: "C.UTF-8",
        LANG: "C.UTF-8",
      },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let closed = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortCommand);
    };

    const terminate = () => {
      if (closed) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 500);
      killTimer.unref();
    };

    const abortCommand = () => terminate();
    signal?.addEventListener("abort", abortCommand, { once: true });
    if (signal?.aborted) abortCommand();

    const collect = (target: Buffer[], chunk: Buffer) => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      target.push(chunk.subarray(0, remaining));
      outputBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(error);
    });

    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();

    // Windows process creation can consume most of a very small timeout before
    // the child emits its first byte. Preserve the caller's timeout for real
    // workloads while giving only sub-second probes a bounded startup grace.
    const effectiveTimeoutMs = process.platform === "win32" && timeoutMs <= 1000 ? timeoutMs + 1000 : timeoutMs;
    termTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, effectiveTimeoutMs);

    child.once("close", (exitCode, signal) => {
      closed = true;
      cleanup();
      if (settled) return;
      settled = true;
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolveCommand({
        exitCode,
        signal,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: stderrBuffer.toString("utf8"),
        stdoutBase64: stdoutBuffer.toString("base64"),
        stderrBase64: stderrBuffer.toString("base64"),
        truncated,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function startSandboxServer(options: SandboxServerOptions): Promise<{
  server: Server;
  endpoint: string;
  close: () => Promise<void>;
}> {
  const endpoint = parseSandboxEndpoint(options.socketPath, true);
  if (endpoint.kind === "unix") await mkdir(dirname(endpoint.path), { recursive: true });
  await mkdir(options.scratchRoot, { recursive: true });
  if (endpoint.kind === "unix") await rm(endpoint.path, { force: true });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://sandbox.local");
      if (request.method === "GET" && url.pathname === "/health") {
        const availability = await Promise.all(
          options.allowedPrograms.map(async (program) => ({ program, available: await programAvailable(program) })),
        );
        const health: SandboxHealth = {
          status: "ok",
          service: "ctf-sandbox",
          workspaceRoot: options.workspaceRoot,
          scratchRoot: options.scratchRoot,
          allowedPrograms: availability.filter((item) => item.available).map((item) => item.program),
          missingPrograms: availability.filter((item) => !item.available).map((item) => item.program),
          network: options.network ?? "external",
          isolation: "run-namespace",
        };
        json(response, 200, health);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/exec") {
        const input = validateExecInput(await bodyJson(request));
        const abortController = new AbortController();
        const abortCommand = () => {
          if (!response.writableEnded) abortController.abort(new Error("Sandbox client disconnected"));
        };
        response.once("close", abortCommand);
        try {
          const result = await executeCommand(input, options, abortController.signal);
          if (!response.destroyed) json(response, 200, result);
        } finally {
          response.off("close", abortCommand);
        }
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    if (endpoint.kind === "unix") server.listen(endpoint.path, resolveListen);
    else server.listen(endpoint.port, endpoint.host, resolveListen);
  });

  const listeningEndpoint = endpoint.kind === "unix"
    ? endpoint.path
    : `tcp://${endpoint.host}:${(server.address() as AddressInfo).port}`;

  return {
    server,
    endpoint: listeningEndpoint,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close(async (error) => {
          if (error) {
            reject(error);
            return;
          }
          if (endpoint.kind === "unix") await rm(endpoint.path, { force: true });
          resolveClose();
        });
      }),
  };
}

async function requestJson<T>(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  const endpoint = parseSandboxEndpoint(socketPath);
  return await new Promise<T>((resolveRequest, reject) => {
    const request = httpRequest(
      {
        ...(endpoint.kind === "unix"
          ? { socketPath: endpoint.path }
          : { host: endpoint.host, port: endpoint.port }),
        method,
        path,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": payload.length,
            }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const parsed = text ? JSON.parse(text) : {};
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(String((parsed as { error?: unknown }).error ?? `Sandbox returned ${response.statusCode}`)));
            return;
          }
          resolveRequest(parsed as T);
        });
      },
    );
    const abort = () => request.destroy(new Error("Sandbox request aborted"));
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Sandbox request timed out")));
    signal?.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => signal?.removeEventListener("abort", abort));
    if (payload) request.end(payload);
    else request.end();
  });
}

export class SandboxClient {
  constructor(
    readonly socketPath: string,
    readonly timeoutMs: number,
  ) {}

  async health(signal?: AbortSignal): Promise<SandboxHealth> {
    return await requestJson<SandboxHealth>(this.socketPath, "GET", "/health", undefined, this.timeoutMs, signal);
  }

  async execute(input: SandboxExecRequest, signal?: AbortSignal): Promise<SandboxExecResult> {
    const timeoutMs = Math.max(this.timeoutMs, input.timeoutMs ?? 0) + 1000;
    return await requestJson<SandboxExecResult>(this.socketPath, "POST", "/v1/exec", input, timeoutMs, signal);
  }
}

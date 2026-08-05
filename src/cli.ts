#!/usr/bin/env node
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { ArenaClient, summarizeArenaAttempt } from "./arena.js";
import {
  buildArenaEvaluationReport,
  compactAttemptResult,
  solveArenaOnce,
  writeArenaEvaluationReport,
  type ArenaAttemptEvaluation,
} from "./arena-evaluation.js";
import { loadConfig, loadScopeFile, mergeScope } from "./config.js";
import { loadDotEnv } from "./env.js";
import { AuditChain } from "./audit.js";
import { exportResources, loadResourceIds, writeResourceExportReport } from "./resource-export.js";
import { XuanShuRuntime } from "./runtime.js";
import { SandboxClient, startSandboxServer } from "./sandbox.js";
import { startApiServer } from "./server.js";
import { resolveWorkspacePath } from "./policy.js";
import type { AppConfig } from "./types.js";

interface ParsedArgs {
  command: string;
  config?: string;
  task?: string;
  taskFile?: string;
  scope?: string;
  attemptId?: number;
  flag?: string;
  autoSubmit?: boolean;
  maxAttempts?: number;
  idleSeconds?: number;
  idsPath?: string;
  endpoint?: string;
  appId?: string;
  authKey?: string;
  model?: string;
  output?: string;
  attachments: string[];
}

function usage(): string {
  return `烛龙·玄枢 v0.2.2

Usage:
  xuan-shu doctor [--config path]
  xuan-shu run --task "..." [--attach path ...] [--scope path] [--config path]
  xuan-shu run --task-file task.txt [--attach path ...] [--scope path] [--config path]
  xuan-shu serve [--config path]
  xuan-shu sandbox [--config path]
  xuan-shu sandbox-health [--config path]
  xuan-shu arena-current [--config path]
  xuan-shu arena-next [--config path]
  xuan-shu arena-attempt --attempt-id id [--config path]
  xuan-shu arena-submit --attempt-id id --flag "..." [--config path]
  xuan-shu arena-abandon --attempt-id id [--config path]
  xuan-shu arena-solve-once [--no-auto-submit] [--config path]
  xuan-shu arena-loop [--no-auto-submit] [--max-attempts n] [--idle-seconds n] [--config path]
  xuan-shu arena-evaluate [--max-attempts 20] [--idle-seconds n] [--config path]
  xuan-shu resource-export --endpoint URL [--ids task_ids.json] [--output report.json] [--config path]
`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: argv[0] ?? "help", attachments: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg) continue;
    if (arg === "--auto-submit") {
      result.autoSubmit = true;
      continue;
    }
    if (arg === "--no-auto-submit") {
      result.autoSubmit = false;
      continue;
    }
    if (
      ["--config", "--task", "--task-file", "--scope", "--attach", "--attempt-id", "--flag", "--max-attempts", "--idle-seconds", "--ids", "--endpoint", "--app-id", "--auth-key", "--model", "--output"].includes(
        arg,
      )
    ) {
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--config") result.config = value;
      if (arg === "--task") result.task = value;
      if (arg === "--task-file") result.taskFile = value;
      if (arg === "--scope") result.scope = value;
      if (arg === "--attach") result.attachments.push(value);
      if (arg === "--attempt-id") {
        const attemptId = Number(value);
        if (!Number.isInteger(attemptId) || attemptId <= 0) throw new Error("--attempt-id must be a positive integer");
        result.attemptId = attemptId;
      }
      if (arg === "--flag") result.flag = value;
      if (arg === "--max-attempts") {
        const maxAttempts = Number(value);
        if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error("--max-attempts must be a positive integer");
        result.maxAttempts = maxAttempts;
      }
      if (arg === "--idle-seconds") {
        const idleSeconds = Number(value);
        if (!Number.isFinite(idleSeconds) || idleSeconds < 0) throw new Error("--idle-seconds must be a non-negative number");
        result.idleSeconds = idleSeconds;
      }
      if (arg === "--ids") result.idsPath = value;
      if (arg === "--endpoint") result.endpoint = value;
      if (arg === "--app-id") result.appId = value;
      if (arg === "--auth-key") result.authKey = value;
      if (arg === "--model") result.model = value;
      if (arg === "--output") result.output = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function delay(seconds: number): Promise<void> {
  if (seconds <= 0) return;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, seconds * 1000));
}

async function doctor(configPath?: string): Promise<number> {
  const config = await loadConfig(configPath);
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ check: "Node.js", ok: nodeMajor >= 22, detail: process.versions.node });
  try {
    await access(config.scope.workspaceRoot, constants.R_OK);
    checks.push({ check: "Workspace", ok: true, detail: config.scope.workspaceRoot });
  } catch {
    checks.push({ check: "Workspace", ok: false, detail: `${config.scope.workspaceRoot} is not readable` });
  }
  try {
    await mkdir(config.runtime.scratchRoot, { recursive: true });
    await access(config.runtime.scratchRoot, constants.R_OK | constants.W_OK);
    checks.push({ check: "Scratch", ok: true, detail: config.runtime.scratchRoot });
  } catch {
    checks.push({ check: "Scratch", ok: false, detail: `${config.runtime.scratchRoot} is not writable` });
  }
  checks.push({
    check: "Model credential",
    ok: Boolean(process.env[config.model.apiKeyEnv]),
    detail: process.env[config.model.apiKeyEnv] ? `${config.model.apiKeyEnv} is set` : `${config.model.apiKeyEnv} is not set`,
  });
  try {
    const health = await new SandboxClient(config.runtime.sandbox.socketPath, config.runtime.sandbox.connectTimeoutMs).health();
    const missing = config.scope.allowedPrograms.filter((program) => !health.allowedPrograms.includes(program));
    checks.push({
      check: "CTF sandbox",
      ok: missing.length === 0,
      detail: missing.length
        ? `reachable but missing allowlisted programs: ${missing.join(", ")}`
        : `reachable at ${config.runtime.sandbox.socketPath}`,
    });
  } catch (error) {
    checks.push({
      check: "CTF sandbox",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  for (const check of checks) console.log(`${check.ok ? "OK  " : "FAIL"} ${check.check}: ${check.detail}`);
  return checks.every((check) => check.ok) ? 0 : 1;
}

function requireArenaCredentials(config: AppConfig): void {
  if (!config.arena?.enabled) throw new Error("Arena integration is disabled in the selected config");
  if (!process.env[config.arena.tokenEnv]) {
    throw new Error(`Missing NSSCTF Arena token in environment variable ${config.arena.tokenEnv}`);
  }
  if (!process.env[config.model.apiKeyEnv]) {
    throw new Error(`Missing model credential in environment variable ${config.model.apiKeyEnv}`);
  }
}

async function ensureSandbox(config: AppConfig): Promise<{ close: () => Promise<void>; owned: boolean }> {
  const client = new SandboxClient(config.runtime.sandbox.socketPath, config.runtime.sandbox.connectTimeoutMs);
  try {
    await client.health();
    return { close: async () => {}, owned: false };
  } catch {
    const running = await startSandboxServer({
      socketPath: config.runtime.sandbox.socketPath,
      workspaceRoot: config.scope.workspaceRoot,
      scratchRoot: config.runtime.scratchRoot,
      allowedPrograms: config.scope.allowedPrograms,
      defaultTimeoutMs: config.runtime.commandTimeoutMs,
      maxOutputBytes: config.runtime.maxOutputBytes,
      network: process.env.XUANSHU_SANDBOX_NETWORK ?? "external",
    });
    return { close: running.close, owned: true };
  }
}

function evaluationEventLogger() {
  return (event: { type: string; data: unknown }) => {
    if (["tool.started", "policy.decision", "run.settled"].includes(event.type)) {
      console.error(`[${event.type}] ${JSON.stringify(event.data)}`);
    }
  };
}

function isRetryableInfrastructureError(message: string): boolean {
  return /(?:\b429\b|too\s*many\s*requests|rate\s*limit|\b5\d\d\b|econnreset|etimedout|fetch failed|socket hang up|container unavailable)/i.test(
    message,
  );
}

async function runArenaEvaluation(
  config: AppConfig,
  targetAttempts: number,
  autoSubmit: boolean,
  idleSeconds: number,
): Promise<number> {
  requireArenaCredentials(config);
  if (targetAttempts <= 0) throw new Error("targetAttempts must be positive");
  const sandbox = await ensureSandbox(config);
  const client = new ArenaClient(config.arena);
  const startedAt = new Date().toISOString();
  const attempts: ArenaAttemptEvaluation[] = [];
  const seen = new Set<number>();
  let startAgent;
  let endAgent;
  let infrastructureError: string | undefined;
  let infrastructureRetries = 0;
  try {
    const current = await client.current();
    startAgent = current.agent;
    while (attempts.filter((attempt) => attempt.settled).length < targetAttempts) {
      let solved;
      try {
        solved = await solveArenaOnce(config, client, {
          autoSubmit,
          seenAttemptIds: seen,
          onEvent: evaluationEventLogger(),
        });
      } catch (error) {
        infrastructureError = error instanceof Error ? error.message : String(error);
        if (isRetryableInfrastructureError(infrastructureError)) {
          const waitSeconds = Math.min(60 * 2 ** infrastructureRetries, 300);
          infrastructureRetries += 1;
          console.error(
            `[arena-evaluate] transient infrastructure error; retrying the active attempt in ${waitSeconds}s: ${infrastructureError}`,
          );
          await delay(waitSeconds);
          continue;
        }
        console.error(`[arena-evaluate] stopped before settling the next attempt: ${infrastructureError}`);
        break;
      }
      attempts.push(solved.evaluation);
      printJson(compactAttemptResult(solved.evaluation));
      if (!solved.evaluation.settled) {
        infrastructureError = solved.evaluation.reason ?? "Attempt was not settled";
        if (isRetryableInfrastructureError(infrastructureError)) {
          const waitSeconds = Math.min(60 * 2 ** infrastructureRetries, 300);
          infrastructureRetries += 1;
          console.error(
            `[arena-evaluate] transient model/runtime error; retrying attempt ${solved.attemptId} in ${waitSeconds}s`,
          );
          await delay(waitSeconds);
          continue;
        }
        break;
      }
      seen.add(solved.attemptId);
      infrastructureRetries = 0;
      infrastructureError = undefined;
      await delay(idleSeconds);
    }
    try {
      endAgent = (await client.current()).agent;
    } catch (error) {
      infrastructureError ??= error instanceof Error ? error.message : String(error);
    }
    const report = buildArenaEvaluationReport({
      startedAt,
      targetAttempts,
      config,
      attempts,
      ...(startAgent === undefined ? {} : { startAgent }),
      ...(endAgent === undefined ? {} : { endAgent }),
      ...(infrastructureError === undefined ? {} : { infrastructureError }),
    });
    const reportPath = await writeArenaEvaluationReport(config, report);
    printJson({
      evaluation: {
        targetAttempts: report.targetAttempts,
        evaluatedAttempts: report.evaluatedAttempts,
        correct: report.correct,
        incorrect: report.incorrect,
        accuracy: report.accuracy,
        accuracyPercent: report.accuracyPercent,
        completed: report.completed,
        infrastructureError: report.infrastructureError,
      },
      reportPath,
      model: report.model,
      agent: report.endAgent ?? report.startAgent,
    });
    return report.completed ? 0 : 2;
  } finally {
    if (sandbox.owned) await sandbox.close();
  }
}

async function runResourceExport(config: AppConfig, args: ParsedArgs): Promise<number> {
  const scopeOverride = args.scope ? await loadScopeFile(args.scope) : undefined;
  const scope = mergeScope(config.scope, scopeOverride);
  const idsPath = resolveWorkspacePath(scope.workspaceRoot, args.idsPath ?? "task_ids.json");
  const outputPath = resolveWorkspacePath(scope.workspaceRoot, args.output ?? "resource-export-report.json");
  const endpoint = args.endpoint ?? process.env.RESOURCE_EXPORT_ENDPOINT;
  const appId = args.appId ?? process.env.RESOURCE_EXPORT_APP_ID;
  const authKey = args.authKey ?? process.env.RESOURCE_EXPORT_AUTH_KEY;
  if (!endpoint) throw new Error("resource-export requires --endpoint or RESOURCE_EXPORT_ENDPOINT");
  if (!appId) throw new Error("resource-export requires --app-id or RESOURCE_EXPORT_APP_ID");
  if (!authKey) throw new Error("resource-export requires --auth-key or RESOURCE_EXPORT_AUTH_KEY");
  const modelName = args.model ?? process.env.RESOURCE_EXPORT_MODEL ?? "default";
  const modelRoutesText = process.env.RESOURCE_EXPORT_MODEL_ROUTES ?? '{"default":"default"}';
  let modelRoutes: Record<string, string>;
  try {
    const parsed = JSON.parse(modelRoutesText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("route map must be an object");
    modelRoutes = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch (error) {
    throw new Error(`Invalid RESOURCE_EXPORT_MODEL_ROUTES: ${error instanceof Error ? error.message : String(error)}`);
  }
  const resourceIds = await loadResourceIds(idsPath);
  const auditPath = resolve(config.runtime.artifactRoot, "resource-export", `${Date.now()}.jsonl`);
  const audit = new AuditChain(auditPath, "resource-export");
  const report = await exportResources({
    endpoint,
    appId,
    authKey,
    modelRoutes,
    modelName,
    resourceIds,
    scope,
    runtime: config.runtime,
    audit,
  });
  await audit.flush();
  const reportPath = await writeResourceExportReport(outputPath, report);
  printJson({ reportPath, report });
  return report.successRate >= 0.8 ? 0 : 2;
}

async function main(): Promise<void> {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(usage());
    return;
  }
  if (args.command === "doctor") {
    process.exitCode = await doctor(args.config);
    return;
  }
  const config = await loadConfig(args.config);
  if (args.command === "arena-current") {
    const data = await new ArenaClient(config.arena).current();
    printJson(data);
    return;
  }
  if (args.command === "arena-next") {
    const data = await new ArenaClient(config.arena).next();
    printJson({ summary: summarizeArenaAttempt(data), data });
    return;
  }
  if (args.command === "arena-attempt") {
    if (!args.attemptId) throw new Error("arena-attempt requires --attempt-id");
    const data = await new ArenaClient(config.arena).attempt(args.attemptId);
    printJson(data);
    return;
  }
  if (args.command === "arena-submit") {
    if (!args.attemptId) throw new Error("arena-submit requires --attempt-id");
    if (!args.flag) throw new Error("arena-submit requires --flag");
    const data = await new ArenaClient(config.arena).submit(args.attemptId, args.flag);
    printJson({ submitted: true, response: data });
    return;
  }
  if (args.command === "arena-abandon") {
    if (!args.attemptId) throw new Error("arena-abandon requires --attempt-id");
    const data = await new ArenaClient(config.arena).abandon(args.attemptId);
    printJson({ abandoned: true, response: data });
    return;
  }
  if (args.command === "arena-solve-once") {
    process.exitCode = await runArenaEvaluation(config, 1, args.autoSubmit ?? true, 0);
    return;
  }
  if (args.command === "arena-loop") {
    const maxAttempts = args.maxAttempts ?? Number.POSITIVE_INFINITY;
    const idleSeconds = args.idleSeconds ?? 10;
    process.exitCode = await runArenaEvaluation(config, maxAttempts, args.autoSubmit ?? true, idleSeconds);
    return;
  }
  if (args.command === "arena-evaluate") {
    const targetAttempts = args.maxAttempts ?? 20;
    const idleSeconds = args.idleSeconds ?? 1;
    process.exitCode = await runArenaEvaluation(config, targetAttempts, args.autoSubmit ?? true, idleSeconds);
    return;
  }
  if (args.command === "resource-export") {
    process.exitCode = await runResourceExport(config, args);
    return;
  }
  if (args.command === "serve") {
    const running = await startApiServer(config);
    console.log(`烛龙·玄枢 API listening at ${running.url}`);
    console.log(`scope=${config.scope.mode} workspace=${config.scope.workspaceRoot}`);
    return;
  }
  if (args.command === "sandbox") {
    const sandboxEndpoint = process.env.XUANSHU_SANDBOX_ENDPOINT ?? config.runtime.sandbox.socketPath;
    const running = await startSandboxServer({
      socketPath: sandboxEndpoint,
      workspaceRoot: config.scope.workspaceRoot,
      scratchRoot: config.runtime.scratchRoot,
      allowedPrograms: config.scope.allowedPrograms,
      defaultTimeoutMs: config.runtime.commandTimeoutMs,
      maxOutputBytes: config.runtime.maxOutputBytes,
      network: process.env.XUANSHU_SANDBOX_NETWORK ?? "external",
    });
    console.log(`CTF sandbox listening at ${running.endpoint}`);
    console.log(`workspace=${config.scope.workspaceRoot} scratch=${config.runtime.scratchRoot}`);
    process.on("SIGINT", () => void running.close().then(() => process.exit(0)));
    process.on("SIGTERM", () => void running.close().then(() => process.exit(0)));
    return;
  }
  if (args.command === "sandbox-health") {
    const health = await new SandboxClient(
      config.runtime.sandbox.socketPath,
      config.runtime.sandbox.connectTimeoutMs,
    ).health();
    console.log(JSON.stringify(health, null, 2));
    return;
  }
  if (args.command === "run") {
    const task = args.task ?? (args.taskFile ? await readFile(args.taskFile, "utf8") : undefined);
    if (!task) throw new Error("run requires --task or --task-file");
    const scope = args.scope ? await loadScopeFile(args.scope) : undefined;
    const runtime = new XuanShuRuntime(config, {
      onEvent: (event) => {
        if (["tool.started", "policy.decision", "run.settled"].includes(event.type)) {
          console.error(`[${event.type}] ${JSON.stringify(event.data)}`);
        }
      },
    });
    const state = await runtime.run({
      task,
      attachments: args.attachments,
      ...(scope ? { scope } : {}),
    });
    console.log(JSON.stringify(state, null, 2));
    process.exitCode = state.status === "completed" ? 0 : 2;
    return;
  }
  throw new Error(`Unknown command: ${args.command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

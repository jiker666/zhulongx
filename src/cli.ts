#!/usr/bin/env node
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, loadScopeFile, mergeScope } from "./config.js";
import { loadDotEnv } from "./env.js";
import { AuditChain } from "./audit.js";
import { exportResources, loadResourceIds, writeResourceExportReport } from "./resource-export.js";
import { XuanShuRuntime } from "./runtime.js";
import { SandboxClient, startSandboxServer } from "./sandbox.js";
import { startApiServer } from "./server.js";
import { resolveWorkspacePath } from "./policy.js";
import { QuestionBank, questionToTaskRequest } from "./question-bank.js";
import { QuestionBankInstanceRunner } from "./question-bank-instances.js";
import { QuestionBankProgressStore } from "./question-bank-progress.js";
import { ManualJobManager } from "./manual-jobs.js";
import { RunManager } from "./run-manager.js";
import type { AppConfig } from "./types.js";

interface ParsedArgs {
  command: string;
  config?: string;
  task?: string;
  taskFile?: string;
  scope?: string;
  idsPath?: string;
  endpoint?: string;
  appId?: string;
  authKey?: string;
  model?: string;
  output?: string;
  concurrency?: number;
  raceAgents?: number;
  writeup?: boolean;
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
  xuan-shu resource-export --endpoint URL [--ids task_ids.json] [--output report.json] [--config path]
  xuan-shu question-bank-list [--config path]
  xuan-shu question-bank-solve [--concurrency n] [--race-agents n] [--no-writeup] [--config path]
`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: argv[0] ?? "help", attachments: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg) continue;
    if (arg === "--no-writeup") {
      result.writeup = false;
      continue;
    }
    if (
      ["--config", "--task", "--task-file", "--scope", "--attach", "--ids", "--endpoint", "--app-id", "--auth-key", "--model", "--output", "--concurrency", "--race-agents"].includes(
        arg,
      )
    ) {
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--config") result.config = value;
      if (arg === "--task") result.task = value;
      if (arg === "--task-file") result.taskFile = value;
      if (arg === "--scope") result.scope = value;
      if (arg === "--attach") result.attachments.push(value);
      if (arg === "--ids") result.idsPath = value;
      if (arg === "--endpoint") result.endpoint = value;
      if (arg === "--app-id") result.appId = value;
      if (arg === "--auth-key") result.authKey = value;
      if (arg === "--model") result.model = value;
      if (arg === "--output") result.output = value;
      if (arg === "--concurrency") {
        const concurrency = Number(value);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--concurrency must be an integer between 1 and 8");
        result.concurrency = concurrency;
      }
      if (arg === "--race-agents") {
        const raceAgents = Number(value);
        if (!Number.isInteger(raceAgents) || raceAgents < 1 || raceAgents > 8) throw new Error("--race-agents must be an integer between 1 and 8");
        result.raceAgents = raceAgents;
      }
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
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, seconds * 1000));
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
    const missingPythonModules = config.scope.pythonModules?.filter((moduleName) => !health.pythonModules?.includes(moduleName)) ?? [];
    checks.push({
      check: "CTF sandbox",
      ok: missing.length === 0 && missingPythonModules.length === 0,
      detail: missing.length || missingPythonModules.length
        ? `reachable but missing ${[
            ...(missing.length ? [`allowlisted programs: ${missing.join(", ")}`] : []),
            ...(missingPythonModules.length ? [`Python modules: ${missingPythonModules.join(", ")}`] : []),
          ].join("; ")}`
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

async function runQuestionBankSolve(config: AppConfig, args: ParsedArgs): Promise<number> {
  const bank = new QuestionBank(config.questionBank);
  const questions = await bank.load();
  if (questions.length === 0) throw new Error("Question bank is empty");
  const progress = new QuestionBankProgressStore(config);
  await progress.syncCompletedRunArtifacts(questions);
  const pending = await progress.pending(questions);
  if (pending.length === 0) {
    printJson({ status: "already-solved", total: questions.length, pending: 0 });
    return 0;
  }
  const runtime = new XuanShuRuntime(config, { onEvent: (event) => {
    if (["tool.started", "policy.decision", "run.settled"].includes(event.type)) {
      console.error(`[${event.type}] ${JSON.stringify(event.data)}`);
    }
  }});
  const manager = new RunManager(runtime);
  const jobs = new ManualJobManager({ runManager: manager });
  const instances = new QuestionBankInstanceRunner(config);
  const started = jobs.start({
    tasks: pending.map((question) => questionToTaskRequest(question)),
    concurrency: instances.enabled() ? 1 : args.concurrency ?? 1,
    raceAgents: args.raceAgents ?? config.questionBank?.raceAgents ?? 1,
    writeup: args.writeup ?? true,
    skipBlocked: true,
    transientRetryLimit: 2,
  }, {
    prepareTask: async (request, signal) => {
      const questionId = request.metadata?.questionId;
      const question = questionId ? pending.find((candidate) => candidate.id === questionId) : undefined;
      if (!question) throw new Error("Question-bank task no longer matches the configured bank");
      return await instances.prepare(question, signal);
    },
    onTaskSettled: async ({ request, state }) => {
      const questionId = request.metadata?.questionId;
      const question = questionId ? pending.find((candidate) => candidate.id === questionId) : undefined;
      if (question) await progress.recordCompleted(question, state);
    },
  });
  const stop = () => jobs.stop(started.id);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (true) {
      const current = jobs.get(started.id);
      if (!current || ["completed", "aborted"].includes(current.status)) {
        printJson({ job: current ?? started });
        return current?.status === "completed" ? 0 : 2;
      }
      await delay(0.25);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await jobs.close();
  }
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
  if (args.command === "question-bank-list") {
    const bank = new QuestionBank(config.questionBank);
    const snapshot = await bank.snapshot();
    if (!snapshot.configured) {
      printJson(snapshot);
      return;
    }
    const questions = await bank.load();
    const progress = new QuestionBankProgressStore(config);
    await progress.syncCompletedRunArtifacts(questions);
    const solved = await progress.progressFor(questions);
    printJson({
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
          status: record ? "solved" : "pending",
          ...(record ? { solvedAt: record.solvedAt } : {}),
        };
      }),
    });
    return;
  }
  if (args.command === "question-bank-solve") {
    process.exitCode = await runQuestionBankSolve(config, args);
    return;
  }
  if (args.command === "resource-export") {
    process.exitCode = await runResourceExport(config, args);
    return;
  }
  if (args.command === "serve") {
    let sandboxRunning: Awaited<ReturnType<typeof startSandboxServer>> | undefined;
    const autoStartSandbox = process.env.XUANSHU_AUTO_START_SANDBOX !== "0";
    if (autoStartSandbox) {
      try {
        await new SandboxClient(config.runtime.sandbox.socketPath, config.runtime.sandbox.connectTimeoutMs).health();
        console.log(`CTF sandbox already reachable at ${config.runtime.sandbox.socketPath}`);
      } catch {
        try {
          sandboxRunning = await startSandboxServer({
            socketPath: config.runtime.sandbox.socketPath,
            workspaceRoot: config.scope.workspaceRoot,
            scratchRoot: config.runtime.scratchRoot,
            allowedPrograms: config.scope.allowedPrograms,
            ...(config.scope.pythonModules ? { pythonModules: config.scope.pythonModules } : {}),
            defaultTimeoutMs: config.runtime.commandTimeoutMs,
            maxOutputBytes: config.runtime.maxOutputBytes,
            network: process.env.XUANSHU_SANDBOX_NETWORK ?? "none",
            ...(config.scope.extraPaths ? { extraPaths: config.scope.extraPaths } : {}),
            ...(config.scope.readOnlyPaths ? { readOnlyPaths: config.scope.readOnlyPaths } : {}),
          });
          console.log(`Started local CTF sandbox at ${sandboxRunning.endpoint}`);
        } catch (error) {
          console.warn(`CTF sandbox is unavailable; run_command will be disabled: ${error instanceof Error ? error.message : String(error)}`);
          console.warn("Start a sidecar with `npm run sandbox` or set XUANSHU_AUTO_START_SANDBOX=0 to disable auto-start.");
        }
      }
    }
    const running = await startApiServer(config);
    console.log(`烛龙·玄枢 API listening at ${running.url}`);
    console.log(`scope=${config.scope.mode} workspace=${config.scope.workspaceRoot}`);
    const close = async () => {
      await running.close();
      await sandboxRunning?.close();
    };
    process.once("SIGINT", () => void close().then(() => process.exit(0)));
    process.once("SIGTERM", () => void close().then(() => process.exit(0)));
    return;
  }
  if (args.command === "sandbox") {
    const sandboxEndpoint = process.env.XUANSHU_SANDBOX_ENDPOINT ?? config.runtime.sandbox.socketPath;
    const running = await startSandboxServer({
      socketPath: sandboxEndpoint,
      workspaceRoot: config.scope.workspaceRoot,
      scratchRoot: config.runtime.scratchRoot,
      allowedPrograms: config.scope.allowedPrograms,
      ...(config.scope.pythonModules ? { pythonModules: config.scope.pythonModules } : {}),
      defaultTimeoutMs: config.runtime.commandTimeoutMs,
      maxOutputBytes: config.runtime.maxOutputBytes,
      network: process.env.XUANSHU_SANDBOX_NETWORK ?? "none",
      ...(config.scope.extraPaths ? { extraPaths: config.scope.extraPaths } : {}),
      ...(config.scope.readOnlyPaths ? { readOnlyPaths: config.scope.readOnlyPaths } : {}),
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

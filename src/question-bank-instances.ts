import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuditChain } from "./audit.js";
import { mergeScope } from "./config.js";
import { isPathInside, PolicyEngine } from "./policy.js";
import { questionToTaskRequest, type QuestionBankQuestion } from "./question-bank.js";
import type { AppConfig, TaskRequest } from "./types.js";

interface DockerCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  outputSha256: string;
  truncated: boolean;
  timedOut: boolean;
}

interface DockerCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface PreparedQuestionBankTask {
  request: TaskRequest;
  cleanup: () => Promise<void>;
}

export interface QuestionBankInstanceDependencies {
  command?: (args: string[], options: DockerCommandOptions) => Promise<DockerCommandResult>;
  waitForPort?: (host: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
}

let composeBinary: Promise<"docker-compose" | "docker"> | undefined;

async function resolveComposeBinary(): Promise<"docker-compose" | "docker"> {
  composeBinary ??= (async () => {
    for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      try {
        await access(join(directory, "docker-compose"), constants.X_OK);
        return "docker-compose";
      } catch {
        // Continue to the Docker CLI plugin when the standalone binary is absent.
      }
    }
    return "docker";
  })();
  return await composeBinary;
}

async function boundedDockerCommand(args: string[], options: DockerCommandOptions): Promise<DockerCommandResult> {
  options.signal?.throwIfAborted();
  const executable = args[0] === "compose" ? await resolveComposeBinary() : "docker";
  const executableArgs = args[0] === "compose" && executable === "docker-compose" ? args.slice(1) : args;
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, executableArgs, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "XDG_CONFIG_HOME"]
          .flatMap((name) => process.env[name] ? [[name, process.env[name] as string]] : []),
      ),
    });
    const hash = createHash("sha256");
    let outputBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, options.maxOutputBytes - outputBytes);
      const accepted = chunk.subarray(0, remaining);
      hash.update(Buffer.from(kind));
      hash.update(accepted);
      outputBytes += accepted.length;
      if (kind === "stdout") stdoutBytes += accepted.length;
      else stderrBytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      if (settled) return;
      settled = true;
      rejectCommand(error);
    });
    child.once("close", (exitCode, signal) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (options.signal?.aborted) {
        rejectCommand(options.signal.reason ?? new Error("Question-bank instance startup aborted"));
        return;
      }
      resolveCommand({
        exitCode,
        signal,
        stdoutBytes,
        stderrBytes,
        outputSha256: hash.digest("hex"),
        truncated,
        timedOut,
      });
    });
  });
}

function connectOnce(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Question-bank instance startup aborted"));
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolveConnection(ready);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectConnection(signal?.reason ?? new Error("Question-bank instance startup aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Question-bank instance startup aborted"));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason ?? new Error("Question-bank instance startup aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await connectOnce(host, port, signal)) return;
    await abortableDelay(250, signal);
  }
  throw new Error(`Question-bank instance did not become ready at ${host}:${port}`);
}

async function regularDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function prepareCompatibilityBuildContext(
  source: string,
  destinationRoot: string,
): Promise<string | undefined> {
  const dockerfile = join(source, "Dockerfile");
  if (!await regularFile(dockerfile)) return undefined;
  const contents = await readFile(dockerfile, "utf8");
  if (!/\bbuster\b/i.test(contents)) return undefined;
  const destination = join(destinationRoot, "build-context");
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  const compatible = contents
    .replace(/\bpython:([0-9][^\s:]*)-slim-buster\b/gi, "python:$1-slim")
    .replace(/\bbuster\b/gi, "bookworm");
  await writeFile(join(destination, "Dockerfile"), compatible, "utf8");
  return destination;
}

function overrideCompose(
  service: string,
  containerName: string,
  hostPort: number,
  containerPort: number,
  buildContext?: string,
): string {
  return [
    "services:",
    `  ${JSON.stringify(service)}:`,
    `    container_name: ${JSON.stringify(containerName)}`,
    "    ports: !override",
    `      - ${JSON.stringify(`127.0.0.1:${hostPort}:${containerPort}`)}`,
    ...(buildContext ? ["    build:", `      context: ${JSON.stringify(buildContext)}`] : []),
    "",
  ].join("\n");
}

export class QuestionBankInstanceRunner {
  private readonly command: NonNullable<QuestionBankInstanceDependencies["command"]>;
  private readonly waitForPort: NonNullable<QuestionBankInstanceDependencies["waitForPort"]>;

  constructor(
    private readonly config: AppConfig,
    dependencies: QuestionBankInstanceDependencies = {},
  ) {
    this.command = dependencies.command ?? boundedDockerCommand;
    this.waitForPort = dependencies.waitForPort ?? waitForPort;
  }

  enabled(): boolean {
    return Boolean(this.config.questionBank?.instanceRunner?.enabled);
  }

  async prepare(question: QuestionBankQuestion, signal?: AbortSignal): Promise<PreparedQuestionBankTask> {
    const runner = this.config.questionBank?.instanceRunner;
    if (!runner?.enabled || !question.instance) {
      return { request: questionToTaskRequest(question), cleanup: async () => {} };
    }
    signal?.throwIfAborted();
    if (!isPathInside(question.root, question.instance.composeFile)) {
      throw new Error("Question-bank compose file escapes the configured question root");
    }
    const unexpectedNetwork = question.instance.externalNetworks.find((name) => name !== runner.networkName);
    if (unexpectedNetwork) {
      throw new Error(`Question-bank compose requires unconfigured external network: ${unexpectedNetwork}`);
    }
    const host = "127.0.0.1";
    const authority = `${host}:${question.instance.hostPort}`;
    const effectiveScope = mergeScope(this.config.scope, { mode: "controlled", allowedHosts: [authority] });
    const networkDecision = PolicyEngine.evaluateScopedTcpTarget(effectiveScope, host, question.instance.hostPort);
    if (!networkDecision.allowed) throw new Error(networkDecision.reason);

    const instanceId = randomUUID();
    const slug = createHash("sha256").update(question.id).digest("hex").slice(0, 12);
    const projectName = `xq-${slug}-${instanceId.slice(0, 8)}`;
    const containerName = `${projectName}-${question.instance.service}`.slice(0, 120);
    const auditRoot = resolve(this.config.runtime.artifactRoot, "..", "question-bank-instances", instanceId);
    const scratchRoot = resolve(this.config.runtime.scratchRoot, "question-bank-instances", instanceId);
    const overridePath = join(scratchRoot, "compose.override.yaml");
    const audit = new AuditChain(join(auditRoot, "audit.jsonl"), instanceId);
    await mkdir(scratchRoot, { recursive: true });

    let buildOverride: string | undefined;
    try {
      let effectiveBuildContext = question.instance.buildContext;
      if (effectiveBuildContext && !isPathInside(question.root, effectiveBuildContext)) {
        throw new Error("Question-bank compose build context escapes the configured question root");
      }
      if (effectiveBuildContext && !await regularDirectory(effectiveBuildContext)) {
        const fallback = resolve(question.root, "challenge");
        if (!isPathInside(question.root, fallback) || !await regularDirectory(fallback) || !await regularFile(join(fallback, "Dockerfile"))) {
          throw new Error("Question-bank compose build context is missing and no challenge/Dockerfile fallback is available");
        }
        effectiveBuildContext = fallback;
        buildOverride = fallback;
      }
      if (effectiveBuildContext) {
        const compatible = await prepareCompatibilityBuildContext(effectiveBuildContext, scratchRoot);
        if (compatible) {
          buildOverride = compatible;
          await audit.append("question_bank.instance_build_compatibility", {
            questionId: question.id,
            reason: "legacy Debian buster references",
          });
        }
      }
      await writeFile(overridePath, overrideCompose(
        question.instance.service,
        containerName,
        question.instance.hostPort,
        question.instance.containerPort,
        buildOverride,
      ), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      await rm(scratchRoot, { recursive: true, force: true });
      throw error;
    }

    const composeArgs = [
      "compose",
      "-f",
      question.instance.composeFile,
      "-f",
      overridePath,
      "-p",
      projectName,
    ];
    let started = false;
    let cleaned = false;
    const runDocker = async (operation: string, args: string[], commandSignal?: AbortSignal) => {
      const result = await this.command(args, {
        cwd: question.root,
        timeoutMs: runner.commandTimeoutMs,
        maxOutputBytes: runner.maxOutputBytes,
        ...(commandSignal ? { signal: commandSignal } : {}),
      });
      await audit.append("question_bank.instance_command", {
        operation,
        args,
        exitCode: result.exitCode,
        signal: result.signal,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        outputSha256: result.outputSha256,
        truncated: result.truncated,
        timedOut: result.timedOut,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`Question-bank instance ${operation} failed`);
      }
    };
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      let cleanupError: unknown;
      if (started) {
        try {
          await runDocker("stop", [...composeArgs, "down", "--remove-orphans"]);
          await audit.append("question_bank.instance_stopped", { questionId: question.id });
        } catch (error) {
          await audit.append("question_bank.instance_cleanup_failed", {
            questionId: question.id,
            error: error instanceof Error ? error.message : String(error),
          });
          cleanupError = error;
        }
      }
      await rm(scratchRoot, { recursive: true, force: true });
      await audit.append("question_bank.instance_scratch_cleaned", { questionId: question.id });
      await audit.flush();
      if (cleanupError) throw cleanupError;
    };

    try {
      await audit.append("question_bank.instance_prepare", {
        questionId: question.id,
        composeFile: question.instance.composeFile,
        service: question.instance.service,
        endpoint: authority,
        networkName: runner.networkName,
      });
      await audit.append("policy.decision", {
        capability: "question_bank_instance_probe",
        target: authority,
        allowed: networkDecision.allowed,
        reason: networkDecision.reason,
        signature: networkDecision.signature,
      });
      const inspected = await this.command(["network", "inspect", runner.networkName], {
        cwd: question.root,
        timeoutMs: runner.commandTimeoutMs,
        maxOutputBytes: runner.maxOutputBytes,
        ...(signal ? { signal } : {}),
      });
      await audit.append("question_bank.instance_network_checked", {
        networkName: runner.networkName,
        exists: inspected.exitCode === 0,
        outputSha256: inspected.outputSha256,
      });
      if (inspected.exitCode !== 0) {
        await runDocker("create-network", ["network", "create", "--internal", runner.networkName], signal);
      }
      started = true;
      await runDocker(
        "start",
        [...composeArgs, "up", "-d", "--build", "--force-recreate", question.instance.service],
        signal,
      );
      await this.waitForPort(host, question.instance.hostPort, runner.startupTimeoutMs, signal);
      await audit.append("question_bank.instance_ready", { questionId: question.id, endpoint: authority });
      return { request: questionToTaskRequest(question, { host, port: question.instance.hostPort }), cleanup };
    } catch (error) {
      await audit.append("question_bank.instance_failed", {
        questionId: question.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await cleanup();
      } catch {
        // The original startup error remains the actionable failure.
      }
      throw error;
    }
  }
}

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { hostMatches, isPathInside } from "./policy.js";
import type { AppConfig, ScopeConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = resolve("config/default.yaml");

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...new Set(value)];
}

function categoryArray(value: unknown, label: string): string[] {
  const values = stringArray(value, label).map((item) => item.trim().toLowerCase());
  if (values.some((item) => item.length === 0)) throw new Error(`${label} must not contain empty categories`);
  return [...new Set(values)];
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireObject(value, label);
  if (Object.values(record).some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} values must be non-empty environment variable names`);
  }
  return Object.fromEntries(Object.entries(record) as Array<[string, string]>);
}

function validateConfig(value: unknown, configPath: string): AppConfig {
  const root = requireObject(value, "config");
  const model = requireObject(root.model, "model");
  const runtime = requireObject(root.runtime, "runtime");
  const sandbox = requireObject(runtime.sandbox, "runtime.sandbox");
  const scope = requireObject(root.scope, "scope");
  const server = requireObject(root.server, "server");
  const arena = root.arena === undefined ? undefined : requireObject(root.arena, "arena");
  const questionBank = root.questionBank === undefined ? undefined : requireObject(root.questionBank, "questionBank");
  const baseDir = resolve(configPath, "..");
  const workspaceRoot = requireString(scope.workspaceRoot, "scope.workspaceRoot");
  const artifactRoot = requireString(runtime.artifactRoot, "runtime.artifactRoot");
  const scratchRoot = requireString(runtime.scratchRoot, "runtime.scratchRoot");
  const socketPath = requireString(sandbox.socketPath, "runtime.sandbox.socketPath");
  const thinkingLevel = requireString(runtime.thinkingLevel, "runtime.thinkingLevel");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
    throw new Error("runtime.thinkingLevel is invalid");
  }
  const mode = requireString(scope.mode, "scope.mode");
  if (mode !== "observe" && mode !== "controlled") throw new Error("scope.mode must be observe or controlled");
  const api = requireString(model.api, "model.api");
  if (api !== "anthropic-messages" && api !== "openai-completions" && api !== "openai-responses") {
    throw new Error("model.api must be anthropic-messages, openai-completions, or openai-responses");
  }

  const result: AppConfig = {
    model: {
      provider: requireString(model.provider, "model.provider"),
      id: requireString(model.id, "model.id"),
      name: requireString(model.name, "model.name"),
      api,
      baseUrl: requireString(model.baseUrl, "model.baseUrl").replace(/\/$/, ""),
      apiKeyEnv: requireString(model.apiKeyEnv, "model.apiKeyEnv"),
      reasoning: Boolean(model.reasoning),
      contextWindow: requireNumber(model.contextWindow, "model.contextWindow"),
      maxTokens: requireNumber(model.maxTokens, "model.maxTokens"),
      ...(model.headersFromEnv === undefined
        ? {}
        : { headersFromEnv: stringRecord(model.headersFromEnv, "model.headersFromEnv") }),
    },
    runtime: {
      thinkingLevel: thinkingLevel as AppConfig["runtime"]["thinkingLevel"],
      artifactRoot: isAbsolute(artifactRoot) ? artifactRoot : resolve(baseDir, "..", artifactRoot),
      scratchRoot: isAbsolute(scratchRoot) ? scratchRoot : resolve(baseDir, "..", scratchRoot),
      maxTurns: requireNumber(runtime.maxTurns, "runtime.maxTurns"),
      maxToolCalls: requireNumber(runtime.maxToolCalls, "runtime.maxToolCalls"),
      maxRuntimeMs: requireNumber(runtime.maxRuntimeMs, "runtime.maxRuntimeMs"),
      modelMinIntervalMs:
        runtime.modelMinIntervalMs === undefined ? 0 : requireNumber(runtime.modelMinIntervalMs, "runtime.modelMinIntervalMs"),
      modelRequestsPerMinute:
        runtime.modelRequestsPerMinute === undefined
          ? 0
          : requireNumber(runtime.modelRequestsPerMinute, "runtime.modelRequestsPerMinute"),
      modelTokensPerMinute:
        runtime.modelTokensPerMinute === undefined
          ? 0
          : requireNumber(runtime.modelTokensPerMinute, "runtime.modelTokensPerMinute"),
      modelMaxRetryDelayMs:
        runtime.modelMaxRetryDelayMs === undefined
          ? 120000
          : requireNumber(runtime.modelMaxRetryDelayMs, "runtime.modelMaxRetryDelayMs"),
      maxActionsWithoutCheckpoint: requireNumber(
        runtime.maxActionsWithoutCheckpoint,
        "runtime.maxActionsWithoutCheckpoint",
      ),
      maxRepeatedAction: requireNumber(runtime.maxRepeatedAction, "runtime.maxRepeatedAction"),
      maxOutputBytes: requireNumber(runtime.maxOutputBytes, "runtime.maxOutputBytes"),
      maxImageBytes: requireNumber(runtime.maxImageBytes, "runtime.maxImageBytes"),
      maxImageObservations: requireNumber(runtime.maxImageObservations, "runtime.maxImageObservations"),
      maxScratchFileBytes: requireNumber(runtime.maxScratchFileBytes, "runtime.maxScratchFileBytes"),
      finalizationReserveMs: requireNumber(runtime.finalizationReserveMs, "runtime.finalizationReserveMs"),
      commandTimeoutMs: requireNumber(runtime.commandTimeoutMs, "runtime.commandTimeoutMs"),
      httpTimeoutMs: requireNumber(runtime.httpTimeoutMs, "runtime.httpTimeoutMs"),
      maxHttpRequests: requireNumber(runtime.maxHttpRequests, "runtime.maxHttpRequests"),
      maxTcpSessions: requireNumber(runtime.maxTcpSessions, "runtime.maxTcpSessions"),
      maxTcpBytes: requireNumber(runtime.maxTcpBytes, "runtime.maxTcpBytes"),
      sandbox: {
        socketPath: socketPath.startsWith("tcp://")
          ? socketPath
          : isAbsolute(socketPath)
            ? socketPath
            : resolve(baseDir, "..", socketPath),
        connectTimeoutMs: requireNumber(sandbox.connectTimeoutMs, "runtime.sandbox.connectTimeoutMs"),
      },
    },
    scope: {
      mode,
      workspaceRoot: isAbsolute(workspaceRoot) ? workspaceRoot : resolve(baseDir, "..", workspaceRoot),
      allowedHosts: stringArray(scope.allowedHosts, "scope.allowedHosts"),
      allowedPrograms: stringArray(scope.allowedPrograms, "scope.allowedPrograms"),
    },
    server: {
      host: requireString(server.host, "server.host"),
      port: requireNumber(server.port, "server.port"),
      tokenEnv: requireString(server.tokenEnv, "server.tokenEnv"),
    },
  };
  if (result.runtime.finalizationReserveMs >= result.runtime.maxRuntimeMs) {
    throw new Error("runtime.finalizationReserveMs must be smaller than runtime.maxRuntimeMs");
  }
  if (arena) {
    result.arena = {
      enabled: arena.enabled !== undefined ? Boolean(arena.enabled) : true,
      baseUrl: requireString(arena.baseUrl, "arena.baseUrl").replace(/\/$/, ""),
      tokenEnv: requireString(arena.tokenEnv, "arena.tokenEnv"),
      timeoutMs: requireNumber(arena.timeoutMs, "arena.timeoutMs"),
      maxResponseBytes: requireNumber(arena.maxResponseBytes, "arena.maxResponseBytes"),
      ...(arena.allowedCategories === undefined ? {} : { allowedCategories: categoryArray(arena.allowedCategories, "arena.allowedCategories") }),
      maxCategorySkips: arena.maxCategorySkips === undefined ? 10 : requireNumber(arena.maxCategorySkips, "arena.maxCategorySkips"),
    };
  }
  if (questionBank) {
    const rootPath = questionBank.root === undefined ? undefined : requireString(questionBank.root, "questionBank.root");
    const rootEnv = questionBank.rootEnv === undefined ? undefined : requireString(questionBank.rootEnv, "questionBank.rootEnv");
    if (!rootPath && !rootEnv) throw new Error("questionBank requires root or rootEnv");
    if (rootPath && rootEnv) throw new Error("questionBank cannot define both root and rootEnv");
    result.questionBank = {
      enabled: questionBank.enabled === undefined ? true : Boolean(questionBank.enabled),
      ...(rootPath ? { root: isAbsolute(rootPath) ? rootPath : resolve(baseDir, "..", rootPath) } : {}),
      ...(rootEnv ? { rootEnv } : {}),
      listFiles: questionBank.listFiles === undefined
        ? ["task_list_crypto.txt", "task_list_misc.txt"]
        : stringArray(questionBank.listFiles, "questionBank.listFiles"),
      maxQuestions: questionBank.maxQuestions === undefined ? 20 : requireNumber(questionBank.maxQuestions, "questionBank.maxQuestions"),
      ...(questionBank.raceAgents === undefined ? {} : { raceAgents: requireNumber(questionBank.raceAgents, "questionBank.raceAgents") }),
    };
    if (result.questionBank.raceAgents !== undefined && (!Number.isInteger(result.questionBank.raceAgents) || result.questionBank.raceAgents > 8)) {
      throw new Error("questionBank.raceAgents must be an integer between 1 and 8");
    }
    if (questionBank.instanceRunner !== undefined) {
      const instanceRunner = requireObject(questionBank.instanceRunner, "questionBank.instanceRunner");
      const networkName = requireString(instanceRunner.networkName, "questionBank.instanceRunner.networkName");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(networkName)) {
        throw new Error("questionBank.instanceRunner.networkName is invalid");
      }
      result.questionBank.instanceRunner = {
        enabled: instanceRunner.enabled === undefined ? false : Boolean(instanceRunner.enabled),
        networkName,
        startupTimeoutMs: requireNumber(instanceRunner.startupTimeoutMs, "questionBank.instanceRunner.startupTimeoutMs"),
        commandTimeoutMs: requireNumber(instanceRunner.commandTimeoutMs, "questionBank.instanceRunner.commandTimeoutMs"),
        maxOutputBytes: requireNumber(instanceRunner.maxOutputBytes, "questionBank.instanceRunner.maxOutputBytes"),
      };
    }
    if (result.questionBank.listFiles.length === 0) throw new Error("questionBank.listFiles must not be empty");
  }
  return result;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<AppConfig> {
  const absolutePath = resolve(configPath);
  const content = await readFile(absolutePath, "utf8");
  return validateConfig(parse(content), absolutePath);
}

export async function loadScopeFile(path: string): Promise<Partial<ScopeConfig>> {
  const value = requireObject(parse(await readFile(resolve(path), "utf8")), "scope override");
  const result: Partial<ScopeConfig> = {};
  if (value.mode !== undefined) {
    if (value.mode !== "observe" && value.mode !== "controlled") throw new Error("scope override mode is invalid");
    result.mode = value.mode;
  }
  if (value.workspaceRoot !== undefined) result.workspaceRoot = resolve(requireString(value.workspaceRoot, "workspaceRoot"));
  if (value.allowedHosts !== undefined) result.allowedHosts = stringArray(value.allowedHosts, "allowedHosts");
  if (value.allowedPrograms !== undefined) result.allowedPrograms = stringArray(value.allowedPrograms, "allowedPrograms");
  return result;
}

export function mergeScope(base: ScopeConfig, override?: Partial<ScopeConfig>): ScopeConfig {
  if (!override) return { ...base, allowedHosts: [...base.allowedHosts], allowedPrograms: [...base.allowedPrograms] };
  const workspaceRoot = resolve(override.workspaceRoot ?? base.workspaceRoot);
  if (!isPathInside(base.workspaceRoot, workspaceRoot)) {
    throw new Error("A per-run scope cannot expand workspaceRoot beyond the configured scope");
  }
  if (base.mode === "observe" && override.mode === "controlled") {
    throw new Error("A per-run scope cannot elevate observe mode to controlled mode");
  }
  const allowedHosts = override.allowedHosts ?? base.allowedHosts;
  if (allowedHosts.some((host) => !base.allowedHosts.some((allowed) => host === allowed || hostMatches(host, allowed)))) {
    throw new Error("A per-run scope cannot add hosts beyond the configured scope");
  }
  const allowedPrograms = override.allowedPrograms ?? base.allowedPrograms;
  if (allowedPrograms.some((program) => !base.allowedPrograms.includes(program))) {
    throw new Error("A per-run scope cannot add programs beyond the configured scope");
  }
  return {
    ...base,
    ...override,
    mode: override.mode ?? base.mode,
    workspaceRoot,
    allowedHosts: [...allowedHosts],
    allowedPrograms: [...allowedPrograms],
  };
}

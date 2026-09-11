import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { hostMatches, isPathInside } from "./policy.js";
import type { AppConfig, ModelThinkingFormat, ScopeConfig, WebReasoningConfig } from "./types.js";

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

function pythonModuleArray(value: unknown, label: string): string[] {
  const modules = stringArray(value, label);
  if (modules.some((moduleName) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName))) {
    throw new Error(`${label} contains an invalid Python module name`);
  }
  return modules;
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
  const questionBank = root.questionBank === undefined ? undefined : requireObject(root.questionBank, "questionBank");
  const webReasoning = root.webReasoning === undefined ? undefined : requireObject(root.webReasoning, "webReasoning");
  const browser = root.browser === undefined ? undefined : requireObject(root.browser, "browser");
  const profile = root.profile === undefined ? undefined : requireObject(root.profile, "profile");
  const connectors = root.connectors === undefined ? [] : root.connectors;
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
  const thinkingFormat = model.thinkingFormat === undefined ? undefined : requireString(model.thinkingFormat, "model.thinkingFormat");
  const validThinkingFormats: ModelThinkingFormat[] = ["openai", "openrouter", "deepseek", "together", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"];
  if (thinkingFormat !== undefined && !validThinkingFormats.includes(thinkingFormat as ModelThinkingFormat)) {
    throw new Error("model.thinkingFormat is invalid");
  }
  if (model.supportsReasoningEffort !== undefined && typeof model.supportsReasoningEffort !== "boolean") {
    throw new Error("model.supportsReasoningEffort must be a boolean");
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
      ...(thinkingFormat ? { thinkingFormat: thinkingFormat as ModelThinkingFormat } : {}),
      ...(model.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: model.supportsReasoningEffort }),
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
      ...(scope.extraPaths !== undefined ? { extraPaths: stringArray(scope.extraPaths, "scope.extraPaths") } : {}),
      ...(scope.pythonModules !== undefined ? { pythonModules: pythonModuleArray(scope.pythonModules, "scope.pythonModules") } : {}),
      ...(scope.readOnlyPaths !== undefined ? { readOnlyPaths: stringArray(scope.readOnlyPaths, "scope.readOnlyPaths") } : {}),
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
  if (webReasoning) {
    const positiveOrDefault = (key: keyof WebReasoningConfig, fallback: number): number =>
      webReasoning[key] === undefined ? fallback : requireNumber(webReasoning[key], `webReasoning.${String(key)}`);
    result.webReasoning = {
      enabled: webReasoning.enabled === undefined ? true : Boolean(webReasoning.enabled),
      autoDetectWebTasks: webReasoning.autoDetectWebTasks === undefined ? true : Boolean(webReasoning.autoDetectWebTasks),
      persistState: webReasoning.persistState === undefined ? true : Boolean(webReasoning.persistState),
      enableHypothesisManagement: webReasoning.enableHypothesisManagement === undefined ? true : Boolean(webReasoning.enableHypothesisManagement),
      enableReflection: webReasoning.enableReflection === undefined ? true : Boolean(webReasoning.enableReflection),
      enableActionDeduplication: webReasoning.enableActionDeduplication === undefined ? true : Boolean(webReasoning.enableActionDeduplication),
      noEvidenceRoundLimit: positiveOrDefault("noEvidenceRoundLimit", 3), duplicateActionLimit: positiveOrDefault("duplicateActionLimit", 2),
      toolFailureLimit: positiveOrDefault("toolFailureLimit", 3), finalizationRoundReserve: positiveOrDefault("finalizationRoundReserve", 2),
      maxObservations: positiveOrDefault("maxObservations", 80), maxHypotheses: positiveOrDefault("maxHypotheses", 40),
      maxActions: positiveOrDefault("maxActions", 80), maxReflections: positiveOrDefault("maxReflections", 12),
    };
  }
  if (browser) {
    const positive = (key: string, fallback: number): number => browser[key] === undefined ? fallback : requireNumber(browser[key], "browser." + key);
    result.browser = { enabled: browser.enabled === undefined ? true : Boolean(browser.enabled), headless: browser.headless === undefined ? true : Boolean(browser.headless), maxSessionsPerRun: positive("maxSessionsPerRun", 1), maxPagesPerSession: positive("maxPagesPerSession", 2), maxNavigationsPerRun: positive("maxNavigationsPerRun", 10), maxActionsPerRun: positive("maxActionsPerRun", 40), maxNetworkEventsPerRun: positive("maxNetworkEventsPerRun", 500), maxDomElementsPerSnapshot: positive("maxDomElementsPerSnapshot", 200), maxDomSnapshotsPerRun: positive("maxDomSnapshotsPerRun", 40), maxScreenshotsPerRun: browser.maxScreenshotsPerRun === undefined ? 0 : requireNumber(browser.maxScreenshotsPerRun, "browser.maxScreenshotsPerRun"), maxResponseBodyBytes: positive("maxResponseBodyBytes", 65536), maxScriptBytes: positive("maxScriptBytes", 131072), navigationTimeoutMs: positive("navigationTimeoutMs", 15000), actionTimeoutMs: positive("actionTimeoutMs", 10000), sessionTimeoutMs: positive("sessionTimeoutMs", 900000), blockDownloads: browser.blockDownloads === undefined ? true : Boolean(browser.blockDownloads), blockUploads: browser.blockUploads === undefined ? true : Boolean(browser.blockUploads), blockPopups: browser.blockPopups === undefined ? true : Boolean(browser.blockPopups), blockExternalProtocols: browser.blockExternalProtocols === undefined ? true : Boolean(browser.blockExternalProtocols) };
  }
  if (profile) {
    const preferredExecutor = requireString(profile.preferredExecutor, "profile.preferredExecutor");
    if (!["sandbox", "local", "ssh", "connector"].includes(preferredExecutor)) throw new Error("profile.preferredExecutor is invalid");
    if (preferredExecutor === "local" || preferredExecutor === "ssh") {
      throw new Error(`profile.preferredExecutor=${preferredExecutor} requires an operator-provided executor adapter; built-in backends are sandbox and connector`);
    }
    const approvalPolicy = profile.approvalPolicy === undefined ? undefined : requireString(profile.approvalPolicy, "profile.approvalPolicy");
    if (approvalPolicy !== undefined && !["always", "on-request", "never"].includes(approvalPolicy)) throw new Error("profile.approvalPolicy is invalid");
    const contextPolicy = requireObject(profile.contextPolicy, "profile.contextPolicy");
    const compactAtRatio = requireNumber(contextPolicy.compactAtRatio, "profile.contextPolicy.compactAtRatio");
    if (compactAtRatio >= 1) throw new Error("profile.contextPolicy.compactAtRatio must be smaller than 1");
    result.profile = {
      id: requireString(profile.id, "profile.id"),
      ...(profile.systemPrompt === undefined ? {} : { systemPrompt: requireString(profile.systemPrompt, "profile.systemPrompt") }),
      preferredExecutor: preferredExecutor as NonNullable<AppConfig["profile"]>["preferredExecutor"],
      ...(profile.executorTargetId === undefined ? {} : { executorTargetId: requireString(profile.executorTargetId, "profile.executorTargetId") }),
      requiredCapabilities: stringArray(profile.requiredCapabilities, "profile.requiredCapabilities"),
      toolAllowlist: stringArray(profile.toolAllowlist, "profile.toolAllowlist"),
      ...(approvalPolicy === undefined ? {} : { approvalPolicy: approvalPolicy as "always" | "on-request" | "never" }),
      contextPolicy: {
        compactAtRatio,
        keepRecentTokens: requireNumber(contextPolicy.keepRecentTokens, "profile.contextPolicy.keepRecentTokens"),
        maxSummaryChars: requireNumber(contextPolicy.maxSummaryChars, "profile.contextPolicy.maxSummaryChars"),
      },
    };
  }
  if (!Array.isArray(connectors)) throw new Error("connectors must be an array");
  if (connectors.length > 32) throw new Error("connectors may contain at most 32 entries");
  result.connectors = connectors.map((entry, index) => {
    const connector = requireObject(entry, `connectors[${index}]`);
    if (connector.networkAccess !== false) throw new Error(`connectors[${index}].networkAccess must be false; active network remains behind PolicyEngine`);
    return {
      id: requireString(connector.id, `connectors[${index}].id`),
      capabilities: stringArray(connector.capabilities, `connectors[${index}].capabilities`),
      allowedPrograms: stringArray(connector.allowedPrograms, `connectors[${index}].allowedPrograms`),
      networkAccess: false,
      heartbeatTimeoutMs: requireNumber(connector.heartbeatTimeoutMs, `connectors[${index}].heartbeatTimeoutMs`),
      maxPendingTasks: requireNumber(connector.maxPendingTasks, `connectors[${index}].maxPendingTasks`),
      maxOutputBytes: requireNumber(connector.maxOutputBytes, `connectors[${index}].maxOutputBytes`),
    };
  });
  const connectorIds = new Set(result.connectors.map((connector) => connector.id));
  if (connectorIds.size !== result.connectors.length) throw new Error("connector ids must be unique");
  if (result.profile?.preferredExecutor === "connector") {
    if (!result.profile.executorTargetId) throw new Error("connector profile requires profile.executorTargetId");
    if (!connectorIds.has(result.profile.executorTargetId)) throw new Error("profile.executorTargetId must reference an operator-configured connector");
  } else if (result.profile?.executorTargetId) {
    throw new Error("profile.executorTargetId is only valid for connector profiles");
  }
  return result;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<AppConfig> {
  const absolutePath = resolve(configPath);
  const content = await readFile(absolutePath, "utf8");
  const config = validateConfig(parse(content), absolutePath);
  const configuredMode = process.env.XUANSHU_SCOPE_MODE?.trim();
  if (configuredMode) {
    if (configuredMode !== "observe" && configuredMode !== "controlled") {
      throw new Error("XUANSHU_SCOPE_MODE must be observe or controlled");
    }
    config.scope.mode = configuredMode;
  }
  const configuredHosts = process.env.XUANSHU_ALLOWED_HOSTS;
  if (configuredHosts !== undefined) {
    config.scope.allowedHosts = [...new Set(configuredHosts.split(/[\s,]+/).map((host) => host.trim()).filter(Boolean))];
  }
  return config;
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
  if (value.pythonModules !== undefined) result.pythonModules = pythonModuleArray(value.pythonModules, "pythonModules");
  return result;
}

export function mergeScope(base: ScopeConfig, override?: Partial<ScopeConfig>): ScopeConfig {
  if (!override) return {
    ...base,
    allowedHosts: [...base.allowedHosts],
    allowedPrograms: [...base.allowedPrograms],
    ...(base.pythonModules ? { pythonModules: [...base.pythonModules] } : {}),
  };
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
  const pythonModules = override.pythonModules ?? base.pythonModules;
  if (pythonModules && base.pythonModules && pythonModules.some((moduleName) => !base.pythonModules?.includes(moduleName))) {
    throw new Error("A per-run scope cannot add Python modules beyond the configured scope");
  }
  return {
    ...base,
    ...override,
    mode: override.mode ?? base.mode,
    workspaceRoot,
    allowedHosts: [...allowedHosts],
    allowedPrograms: [...allowedPrograms],
    ...(pythonModules ? { pythonModules: [...pythonModules] } : {}),
  };
}

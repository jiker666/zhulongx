import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { ProxyAgent } from "undici";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { lazyStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { AuditChain } from "./audit.js";
import { mergeScope } from "./config.js";
import { projectModelMessages } from "./context-projection.js";
import { SandboxExecutor } from "./executor.js";
import { ExperienceStore, renderExperienceContext } from "./experience.js";
import { renderRunHandoff } from "./handoff.js";
import { normalizeTask, renderTaskContext } from "./input.js";
import { estimateModelRequestTokens, ModelRequestGate } from "./model-rate-limit.js";
import { PolicyEngine } from "./policy.js";
import { classifyProviderError } from "./provider-errors.js";
import { filterProfileTools, narrowToolsForCategory, resolveAgentProfile, validateProfileCapabilities } from "./profiles.js";
import { renderCapabilityPlaybook } from "./playbooks.js";
import { sanitizeSecrets } from "./sanitize.js";
import { boundedContextSection, modelContextSnapshot } from "./session-trajectory.js";
import type { SharedEvidenceBoard } from "./shared-evidence.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createToolSet } from "./tools.js";
import { toolDescriptorMap, type ToolEffect } from "./tool-catalog.js";
import type { AppConfig, NormalizedTask, RunEvent, RunLineage, RunState, RuntimeOverrides, TaskRequest } from "./types.js";
import { submissionPolicyFor, validateSubmission } from "./submission-policy.js";
import { createWebReasoningController } from "./web-reasoning/controller.js";
import { detectWebTask } from "./web-reasoning/task-detector.js";
import { generateWriteup as generateWriteupDocument } from "./writeup-generator.js";
import { resolveCtfSkillCategory } from "./skill-catalog.js";

type SupportedModelApi = "anthropic-messages" | "openai-completions" | "openai-responses";
const MAX_LENGTH_RECOVERY_ATTEMPTS = 2;
// Some gateways can end a reasoning turn with no visible text or tool call. Give
// the agent a small, explicit continuation window instead of losing a valid run.
const MAX_NO_ACTION_RECOVERY_ATTEMPTS = 2;
const MAX_PROVIDER_RETRY_ATTEMPTS = 3;
const sharedModelRequestGates = new WeakMap<AppConfig, ModelRequestGate>();

export { ModelRequestGate } from "./model-rate-limit.js";

export interface RuntimeModelSessionConfig {
  model: AppConfig["model"];
  apiKey: string;
  headers?: Record<string, string>;
}

export interface RuntimeModelStatus {
  configured: boolean;
  source: "session" | "environment" | "missing";
  provider: string;
  id: string;
  name: string;
  api: SupportedModelApi;
  baseUrl: string;
  reasoning: boolean;
  thinkingFormat?: AppConfig["model"]["thinkingFormat"];
  appKeyHeaderConfigured: boolean;
}

export function createModel(config: AppConfig["model"], extraHeaders: Record<string, string> = {}): Model<SupportedModelApi> {
  const headers = Object.fromEntries(
    Object.entries(config.headersFromEnv ?? {}).flatMap(([header, envName]) => {
      const value = process.env[envName];
      return value ? [[header, value]] : [];
    }),
  );
  const mergedHeaders = { ...headers, ...extraHeaders };
  return {
    id: config.id,
    name: config.name,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    ...(config.thinkingLevelMap ? { thinkingLevelMap: config.thinkingLevelMap } : {}),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
    ...(config.api === "openai-responses"
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
    ...(config.api === "openai-responses"
      ? {
          compat: {
            supportsDeveloperRole: false,
            supportsLongCacheRetention: false,
            supportsStrictMode: true,
          },
        }
      : config.api === "openai-completions"
        ? {
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsStrictMode: true,
              ...(config.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: config.supportsReasoningEffort }),
              ...(config.thinkingFormat ? { thinkingFormat: config.thinkingFormat } : {}),
            },
          }
        : {
            compat: {
              supportsEagerToolInputStreaming: false,
              supportsLongCacheRetention: false,
              supportsCacheControlOnTools: false,
            },
          }),
  };
}

function defaultStreamFn(): StreamFn {
  const proxyUrl = process.env.XUANSHU_MODEL_PROXY?.trim();
  const proxy = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const modelFetch = proxy
    ? ((input: string | URL | Request, init?: RequestInit) => fetch(input, { ...(init ?? {}), dispatcher: proxy } as RequestInit))
    : undefined;
  return (model, context, options) => {
    if (model.api === "anthropic-messages") {
      return streamAnthropicMessages(model as Model<"anthropic-messages">, context, { ...options, ...(modelFetch ? { fetch: modelFetch } : {}) });
    }
    if (model.api === "openai-responses") {
      return streamOpenAIResponses(model as Model<"openai-responses">, context, { ...options, ...(modelFetch ? { fetch: modelFetch } : {}) });
    }
    return streamOpenAICompletions(model as Model<"openai-completions">, context, { ...options, ...(modelFetch ? { fetch: modelFetch } : {}) });
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function renderKnowledgeQuery(task: NormalizedTask): string {
  const attachmentSignals = task.attachments
    .map((attachment) => [attachment.source, attachment.summary, attachment.content].filter(Boolean).join("\n"))
    .join("\n")
    .slice(0, 8_000);
  return [task.task, task.metadata.category, attachmentSignals].filter(Boolean).join("\n").slice(0, 12_000);
}

function hitOutputLimitWithoutToolCall(message: AssistantMessage): boolean {
  return message.stopReason === "length" && !message.content.some((item) => item.type === "toolCall");
}

function lengthRecoveryThinkingLevel(
  configured: AppConfig["runtime"]["thinkingLevel"],
): AppConfig["runtime"]["thinkingLevel"] {
  return ["medium", "high", "xhigh", "max"].includes(configured) ? "low" : configured;
}

function effectiveThinkingLevel(
  category: ReturnType<typeof resolveCtfSkillCategory>,
  configured: AppConfig["runtime"]["thinkingLevel"],
): AppConfig["runtime"]["thinkingLevel"] {
  // Offline binary work benefits more from short, complete tool arguments than
  // from long hidden deliberation that can consume the provider output budget.
  return category === "reverse" && configured !== "off"
    ? "off"
    : configured;
}

function isRetryableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|too\s*many\s*requests|rate\s*limit|temporarily\s+unavailable|\b5\d\d\b|econnreset|etimedout|fetch failed|socket hang up)/i.test(message);
}

function providerRetryDelayMs(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const hintedSeconds = message.match(/(?:wait|retry(?:-after)?)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*s/i)?.[1];
  const hinted = hintedSeconds ? Math.ceil(Number(hintedSeconds) * 1_000) : 0;
  return Math.min(30_000, Math.max(hinted, 4_000 * (2 ** Math.max(0, attempt - 1))));
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw signal.reason ?? new Error("Model request aborted");
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason ?? new Error("Model request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function writeupLooksComplete(value: string | undefined): Promise<boolean> {
  const text = value?.trim() ?? "";
  return /^---\s*\n[\s\S]*?\n---\s*\n/m.test(text)
    && text.includes("## Summary")
    && text.includes("## Solution")
    && text.includes("## Flag")
    && /```[A-Za-z0-9_+-]+\n[\s\S]*?```/.test(text);
}

function publicContent(content: unknown[]): unknown[] {
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [block];
    const value = block as { type?: string; data?: unknown; mimeType?: unknown };
    if (value.type === "thinking") return [];
    if (value.type !== "image") return [block];
    const encodedLength = typeof value.data === "string" ? value.data.length : 0;
    const approximateBytes = Math.floor((encodedLength * 3) / 4);
    return [{
      type: "text",
      text: `[image omitted from persisted artifacts: ${String(value.mimeType ?? "unknown")}, approximately ${approximateBytes} bytes]`,
    }];
  });
}

function publicMessage(message: unknown): unknown {
  if (!message || typeof message !== "object" || !("role" in message)) return message;
  const value = message as { role: string; content?: unknown[]; [key: string]: unknown };
  if (!Array.isArray(value.content)) return sanitizeSecrets(value);
  return sanitizeSecrets({
    ...value,
    content: publicContent(value.content),
  });
}

function stagedAttachmentName(source: string, index: number): string {
  const leaf = basename(source).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
  return `${String(index + 1).padStart(2, "0")}-${leaf || "attachment.bin"}`;
}

async function stageAttachmentsOnly(
  task: NormalizedTask,
  inputRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(inputRoot, { recursive: true });
  for (const [index, attachment] of task.attachments.entries()) {
    signal?.throwIfAborted();
    const source = resolve(attachment.source);
    const stats = await lstat(source);
    if (!stats.isFile() || stats.isSymbolicLink() || attachment.kind === "directory") {
      throw new Error("attachments-only runs accept regular-file attachments only");
    }
    const alreadyStaged = relative(inputRoot, source);
    const target = alreadyStaged !== "" && !alreadyStaged.startsWith("..")
      ? source
      : join(inputRoot, stagedAttachmentName(source, index));
    if (target !== source) await copyFile(source, target);
    await chmod(target, 0o444);
    attachment.source = target;
    attachment.toolPath = { source: "workspace", path: relative(inputRoot, target) };
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(sanitizeSecrets(value), null, 2)}\n`, "utf8");
}

export interface RunOptions {
  id?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  signal?: AbortSignal;
  workspaceMode?: "configured" | "attachments-only";
  sharedEvidence?: SharedEvidenceBoard;
  allowedToolEffects?: ToolEffect[];
  contextSections?: Array<{ name: string; content: string }>;
  lineage?: RunLineage & { context: string };
  writeup?: boolean;
}

export class XuanShuRuntime {
  readonly config: AppConfig;
  readonly overrides: RuntimeOverrides;
  private readonly modelRequestGate: ModelRequestGate;

  constructor(config: AppConfig, overrides: RuntimeOverrides = {}) {
    this.config = config;
    this.overrides = overrides;
    const sharedGate = sharedModelRequestGates.get(config) ?? new ModelRequestGate();
    sharedModelRequestGates.set(config, sharedGate);
    this.modelRequestGate = sharedGate;
  }

  configureModel(input: RuntimeModelSessionConfig): void {
    this.overrides.model = createModel(input.model, input.headers);
    this.overrides.modelApiKey = input.apiKey;
    if (input.headers) this.overrides.modelHeaders = input.headers;
    else delete this.overrides.modelHeaders;
  }

  clearConfiguredModel(): void {
    delete this.overrides.model;
    delete this.overrides.modelApiKey;
    delete this.overrides.modelHeaders;
  }

  modelStatus(): RuntimeModelStatus {
    const model = this.overrides.model ?? createModel(this.config.model, this.overrides.modelHeaders);
    const session = Boolean(this.overrides.modelApiKey);
    const environment = Boolean(process.env[this.config.model.apiKeyEnv]);
    const thinkingFormat = model.compat && typeof model.compat === "object" && "thinkingFormat" in model.compat
      ? (model.compat as { thinkingFormat?: AppConfig["model"]["thinkingFormat"] }).thinkingFormat
      : undefined;
    return {
      configured: session || environment,
      source: session ? "session" : environment ? "environment" : "missing",
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api as SupportedModelApi,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      ...(thinkingFormat ? { thinkingFormat } : {}),
      appKeyHeaderConfigured: Boolean(this.overrides.modelHeaders && Object.keys(this.overrides.modelHeaders).length > 0),
    };
  }

  async generateWriteup(state: RunState, transcript: unknown[], signal?: AbortSignal): Promise<string> {
    const model = this.overrides.model ?? createModel(this.config.model, this.overrides.modelHeaders);
    const apiKey = this.overrides.modelApiKey ?? process.env[this.config.model.apiKeyEnv];
    const providerStreamFn = this.overrides.streamFn ?? defaultStreamFn();
    const streamFn: StreamFn = (turnModel, context, streamOptions) => lazyStream(turnModel, async () => {
      for (let attempt = 1; attempt <= MAX_PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
        await this.modelRequestGate.wait({
          minimumIntervalMs: this.config.runtime.modelMinIntervalMs,
          requestsPerMinute: this.config.runtime.modelRequestsPerMinute,
          tokensPerMinute: this.config.runtime.modelTokensPerMinute,
          estimatedTokens: estimateModelRequestTokens(turnModel, context, streamOptions),
        }, streamOptions?.signal);
        try {
          return await providerStreamFn(turnModel, context, streamOptions);
        } catch (error) {
          if (!isRetryableModelError(error) || attempt >= MAX_PROVIDER_RETRY_ATTEMPTS) throw error;
          await abortableDelay(providerRetryDelayMs(error, attempt), streamOptions?.signal);
        }
      }
      throw new Error("Model provider retry budget exhausted");
    });
    const result = await generateWriteupDocument({
      runId: state.id,
      task: state.task as NormalizedTask,
      state,
      transcript,
      model,
      streamFn,
      ...(apiKey ? { apiKey } : {}),
      maxRetryDelayMs: this.config.runtime.modelMaxRetryDelayMs,
      ...(signal ? { signal } : {}),
      timeoutMs: this.config.runtime.finalizationReserveMs,
    });
    return result.markdown;
  }

  async run(request: TaskRequest, options: RunOptions = {}): Promise<RunState> {
    const id = options.id ?? randomUUID();
    const configuredScope = mergeScope(this.config.scope, request.scope);
    const task = await normalizeTask(request);
    const taskCategory = resolveCtfSkillCategory(task.metadata.category) ?? resolveCtfSkillCategory(task.task);
    const memoryContext = this.overrides.memoryStore
      ? await this.overrides.memoryStore.context({
          ...(task.metadata.userId ? { userId: task.metadata.userId } : {}),
          ...(task.metadata.projectId ? { projectId: task.metadata.projectId } : {}),
        })
      : "";
    const runDirectory = join(this.config.runtime.artifactRoot, id);
    const runScratchRoot = join(this.config.runtime.scratchRoot, "runs", id);
    // Native reversing often needs one extra evidence/verification cycle after
    // a parser correction. Keep this bounded and category-driven rather than
    // embedding any challenge-specific assumptions in the core loop.
    const runtimeConfig = {
      ...this.config.runtime,
      scratchRoot: runScratchRoot,
      ...(taskCategory === "reverse"
        ? {
            maxTurns: Math.max(this.config.runtime.maxTurns, 40),
            maxToolCalls: Math.max(this.config.runtime.maxToolCalls, 100),
          }
        : {}),
    };
    const workspaceMode = options.workspaceMode ?? "configured";
    const isolatedInputRoot = join(runScratchRoot, "inputs");
    await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(runScratchRoot, { recursive: true })]);
    if (workspaceMode === "attachments-only") {
      await stageAttachmentsOnly(task, isolatedInputRoot, options.signal);
    }
    const executor = this.overrides.executorFactory
      ? await this.overrides.executorFactory({
          runId: id,
          workspaceRoot: workspaceMode === "attachments-only" ? isolatedInputRoot : configuredScope.workspaceRoot,
          scratchRoot: runScratchRoot,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : new SandboxExecutor({
          id: `sandbox:${id}`,
          socketPath: runtimeConfig.sandbox.socketPath,
          connectTimeoutMs: runtimeConfig.sandbox.connectTimeoutMs,
          workspaceRoot: workspaceMode === "attachments-only" ? isolatedInputRoot : configuredScope.workspaceRoot,
          scratchRoot: runScratchRoot,
        });
    const externalTools = this.overrides.externalTools ?? [];
    const profile = resolveAgentProfile(this.config, externalTools.map((item) => item.descriptor.name));
    const runThinkingLevel = effectiveThinkingLevel(taskCategory, this.config.runtime.thinkingLevel);
    let sandboxReachable = false;
    let sandboxNetwork = "unknown";
    let availablePrograms: string[] = [];
    const executorHealth = await executor.health(options.signal);
    try {
      validateProfileCapabilities(profile, executorHealth);
      const health = executorHealth;
      sandboxReachable = health.status === "online";
      sandboxNetwork = health.network;
      const reported = new Set(health.allowedPrograms);
      availablePrograms = configuredScope.allowedPrograms.filter((program) => reported.has(program));
    } catch {
      // Keep non-sandbox tools usable; run_command is disabled through the effective empty allowlist.
    }
    const unavailablePrograms = configuredScope.allowedPrograms.filter((program) => !availablePrograms.includes(program));
    const scope = {
      ...configuredScope,
      workspaceRoot: workspaceMode === "attachments-only" ? isolatedInputRoot : configuredScope.workspaceRoot,
      allowedPrograms: availablePrograms,
    };
    const model = this.overrides.model ?? createModel(this.config.model, this.overrides.modelHeaders);
    const audit = new AuditChain(join(runDirectory, "audit.jsonl"), id);
    const webClassification = detectWebTask(task);
    const experience = await new ExperienceStore(this.config.runtime.artifactRoot).relevant(
      task.metadata.category ?? (webClassification.isWeb ? "Web" : undefined),
    );
    const now = new Date().toISOString();
    const profileState = {
      id: profile.id,
      executorId: executor.id,
      executorKind: executor.kind,
      capabilities: [...executorHealth.capabilities],
      tools: [] as string[],
    };
    const state: RunState = {
      id,
      status: "running",
      phase: "intake",
      task,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      findings: [],
      lessons: [],
      hypotheses: [],
      strategyRevisions: [],
      strategyRevisionRequired: false,
      sandboxNamespace: id,
      scratchRoot: runScratchRoot,
      workspaceMode,
      appliedExperienceIds: experience.map((record) => record.id),
      turns: 0,
      toolCalls: 0,
      imageObservations: 0,
      httpRequests: 0,
      tcpSessions: 0,
      actionsSinceCheckpoint: 0,
      repeatedActions: {},
      profile: profileState,
      ...(options.lineage ? {
        lineage: {
          parentRunId: options.lineage.parentRunId,
          boundarySequence: options.lineage.boundarySequence,
          mode: options.lineage.mode,
          inheritedEventCount: options.lineage.inheritedEventCount,
        },
      } : {}),
    };
    const emit = async (type: string, data: unknown) => {
      const event: RunEvent = { type, runId: id, timestamp: new Date().toISOString(), data };
      await (options.onEvent ?? this.overrides.onEvent)?.(event);
    };

    await audit.append("run.started", {
      task: task.task,
      attachments: task.attachments.map(({ content: _content, ...attachment }) => attachment),
      scope: { ...scope, allowedPrograms: [...scope.allowedPrograms], allowedHosts: [...scope.allowedHosts] },
      sandboxCapabilities: {
        reachable: sandboxReachable,
        network: sandboxNetwork,
        configuredPrograms: configuredScope.allowedPrograms,
        availablePrograms,
        unavailablePrograms,
      },
      model: {
        provider: model.provider,
        id: model.id,
        api: model.api,
        baseUrl: model.baseUrl,
      },
      budgets: runtimeConfig,
      appliedExperience: experience.map((record) => ({ id: record.id, title: record.title, category: record.category })),
      ...(state.lineage ? { lineage: state.lineage } : {}),
    });
    if (state.lineage) {
      await audit.append(`session.${state.lineage.mode === "fork" ? "forked" : "resumed"}`, state.lineage, {
        source: "orchestrator",
        actor: "run-manager",
        correlationId: state.lineage.parentRunId,
      });
    }
    await writeJson(join(runDirectory, "state.json"), state);
    await emit("run.started", { status: state.status, phase: state.phase });
    const webReasoning = createWebReasoningController(state, audit, this.config.webReasoning);
    await webReasoning.initialize();
    if (webReasoning.enabled && this.config.webReasoning?.persistState !== false) await writeJson(join(runDirectory, "state.json"), state);

    const descriptors = new Map([
      ...toolDescriptorMap().entries(),
      ...externalTools.map((item) => [item.descriptor.name, item.descriptor] as const),
    ]);
    const policy = new PolicyEngine(scope, runtimeConfig, externalTools.map((item) => item.descriptor));
    const toolSet = createToolSet({
      state,
      scope,
      runtime: runtimeConfig,
      audit,
      executor,
      externalTools,
      sandboxNamespace: id,
      ...(options.sharedEvidence ? { sharedEvidence: options.sharedEvidence } : {}),
      ...(this.config.browser ? { browser: this.config.browser } : {}),
    });
    toolSet.tools = filterProfileTools(profile, toolSet.tools);
    toolSet.tools = narrowToolsForCategory(taskCategory, toolSet.tools);
    if (options.allowedToolEffects) {
      const allowedEffects = new Set(options.allowedToolEffects);
      toolSet.tools = toolSet.tools.filter((tool) => {
        const descriptor = descriptors.get(tool.name);
        return descriptor?.kind === "control" || (descriptor ? allowedEffects.has(descriptor.effect) : false);
      });
    }
    profileState.tools = toolSet.tools.map((tool) => tool.name);
    const submissionPolicy = submissionPolicyFor(task);
    const providerStreamFn = this.overrides.streamFn ?? defaultStreamFn();
    let modelRequestNumber = 0;
    let activeModelRequestId: string | undefined;
    const toolRequestSequences = new Map<string, number>();
    const observedToolOutputs: string[] = [];
    const streamFn: StreamFn = (turnModel, context, streamOptions) => lazyStream(turnModel, async () => {
      const requestId = `${id}:request:${++modelRequestNumber}`;
      activeModelRequestId = requestId;
      for (let attempt = 1; attempt <= MAX_PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
        const contextRecord = await audit.append("model.context", {
          requestId,
          attempt,
          turn: state.turns,
          model: { provider: turnModel.provider, id: turnModel.id, api: turnModel.api },
          thinkingLevel: runThinkingLevel,
          ...modelContextSnapshot(context),
        }, { source: "context", actor: "primary-agent", correlationId: requestId });
        const reservation = await this.modelRequestGate.wait({
          minimumIntervalMs: runtimeConfig.modelMinIntervalMs,
          requestsPerMinute: runtimeConfig.modelRequestsPerMinute,
          tokensPerMinute: runtimeConfig.modelTokensPerMinute,
          estimatedTokens: estimateModelRequestTokens(turnModel, context, streamOptions),
        }, streamOptions?.signal);
        await audit.append("model.request_reserved", {
          requestId,
          attempt,
          estimatedTokens: reservation.estimatedTokens,
          waitedMs: reservation.waitedMs,
          requestsPerMinute: runtimeConfig.modelRequestsPerMinute,
          tokensPerMinute: runtimeConfig.modelTokensPerMinute,
        }, { source: "orchestrator", actor: "model-request-gate", correlationId: requestId, parentSequence: contextRecord.sequence });
        if (reservation.waitedMs > 0) {
          await emit("model.request_throttled", {
            estimatedTokens: reservation.estimatedTokens,
            waitedMs: reservation.waitedMs,
          });
        }
        try {
          return await providerStreamFn(turnModel, context, streamOptions);
        } catch (error) {
          if (!isRetryableModelError(error) || attempt >= MAX_PROVIDER_RETRY_ATTEMPTS) throw error;
          const delayMs = providerRetryDelayMs(error, attempt);
          await audit.append("model.provider_retry", {
            requestId,
            attempt,
            delayMs,
            errorClass: classifyProviderError(error),
          }, { source: "orchestrator", actor: "model-retry", correlationId: requestId, parentSequence: contextRecord.sequence });
          await emit("model.provider_retry", { attempt, delayMs, errorClass: classifyProviderError(error) });
          await abortableDelay(delayMs, streamOptions?.signal);
        }
      }
      throw new Error("Model provider retry budget exhausted");
    });
    const apiKey = this.overrides.modelApiKey ?? process.env[this.config.model.apiKeyEnv];
    const recoveryThinkingLevel = lengthRecoveryThinkingLevel(runThinkingLevel);
    let lengthRecoveryAttempts = 0;
    let noActionRecoveryAttempts = 0;
    let lastContextCutId: string | undefined;
    const agent = new Agent({
      streamFn,
      sessionId: id,
      toolExecution: "sequential",
      transformContext: async (messages) => {
        try {
          const projection = projectModelMessages(messages, {
            contextWindow: model.contextWindow,
            compactAtRatio: 0.75,
            keepRecentTokens: Math.max(2_000, Math.floor(model.contextWindow * 0.25)),
            maxSummaryChars: 12_000,
          });
          if (projection.cut && projection.cut.id !== lastContextCutId) {
            const cut = projection.cut;
            const record = await audit.append("context.compacted", ({ previousSequence }: { previousSequence: number }) => ({
              id: cut.id,
              throughSeq: previousSequence,
              throughMessageCount: cut.throughMessageCount,
              sourceEventCount: cut.sourceEventCount,
              summary: cut.summary,
            }));
            state.contextCuts ??= [];
            state.contextCuts.push({ ...cut, throughSeq: record.sequence - 1, createdAt: record.timestamp });
            state.contextCuts = state.contextCuts.slice(-20);
            lastContextCutId = cut.id;
          }
          return projection.messages;
        } catch {
          return messages;
        }
      },
      getApiKey: () => apiKey,
      maxRetryDelayMs: runtimeConfig.modelMaxRetryDelayMs,
      prepareNextTurnWithContext: ({ message }) =>
        message.stopReason === "length" ? { thinkingLevel: recoveryThinkingLevel } : undefined,
      initialState: {
        systemPrompt: buildSystemPrompt(scope, runtimeConfig, {
          reachable: sandboxReachable,
          network: sandboxNetwork,
          configuredPrograms: [...configuredScope.allowedPrograms],
          unavailablePrograms,
          availablePythonModules: [...(executorHealth.pythonModules ?? [])],
          unavailablePythonModules: [...(executorHealth.missingPythonModules ?? [])],
        }, { sharedEvidence: Boolean(options.sharedEvidence) }, { id: profile.id, instructions: profile.systemPrompt }),
        model,
        thinkingLevel: runThinkingLevel,
        tools: toolSet.tools,
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const requested = await audit.append("tool.requested", {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: sanitizeSecrets(args),
          description: descriptors.get(toolCall.name)?.sideEffects.join("; ") || "Agent requested a bounded tool action",
        }, { source: "model", actor: "primary-agent", correlationId: toolCall.id });
        toolRequestSequences.set(toolCall.id, requested.sequence);
        if (toolCall.name === "finish_task" && submissionPolicy === "strict") {
          const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
          const verification = Array.isArray(input.verification)
            ? input.verification.filter((item): item is string => typeof item === "string")
            : [];
          const validation = validateSubmission({
            policy: submissionPolicy,
            status: input.status === "completed" ? "completed" : "blocked",
            ...(typeof input.submission === "string" ? { candidate: input.submission } : {}),
            observedOutputs: observedToolOutputs,
            verification,
            independentlyVerified: input.independentlyVerified === true,
          });
          state.submissionValidation = validation;
          await audit.append("submission.validation", validation, { source: "system", actor: "submission-gate", correlationId: toolCall.id, parentSequence: requested.sequence });
          await emit("submission.validation", { status: validation.status, reason: validation.reason });
          if (validation.status !== "accepted") return { block: true, reason: `Submission gate: ${validation.reason}` };
        }
        const guard = webReasoning.guardToolCall(toolCall.name, args, toolSet.tools.map((tool) => tool.name));
        if (!guard.allowed) {
          await audit.append("WEB_ACTION_GUARD_REJECTED", { toolCallId: toolCall.id, toolName: toolCall.name, decision: guard.decision, reason: guard.reason }, { source: "policy", actor: "web-action-guard", correlationId: toolCall.id, parentSequence: requested.sequence });
          await emit("WEB_ACTION_GUARD_REJECTED", { toolName: toolCall.name, decision: guard.decision, reason: guard.reason });
          return { block: true, reason: guard.reason };
        }
        const webAction = webReasoning.prepareToolCall(toolCall.name, args, toolCall.id);
        if (webAction.duplicate) {
          await audit.append("WEB_ACTION_SKIPPED_DUPLICATE", { actionId: webAction.actionId, toolName: toolCall.name }, { source: "policy", actor: "web-action-deduplicator", correlationId: toolCall.id, parentSequence: requested.sequence });
          return { block: true, reason: "Duplicate Web action skipped; use new evidence or change strategy." };
        }
        const decision = policy.evaluate(toolCall.name, args, state);
        await audit.append("policy.decision", {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: sanitizeSecrets(args),
          allowed: decision.allowed,
          reason: decision.reason,
          signature: decision.signature,
        }, { source: "policy", actor: "policy-engine", correlationId: toolCall.id, parentSequence: requested.sequence });
        await emit("policy.decision", { toolName: toolCall.name, allowed: decision.allowed, reason: decision.reason });
        if (!decision.allowed) {
          webReasoning.markPolicyRejected(toolCall.id, decision.reason);
          if (state.plan && !["submit_plan", "checkpoint", "record_finding", "record_lesson", "finish_task"].includes(toolCall.name)) {
            state.actionsSinceCheckpoint = runtimeConfig.maxActionsWithoutCheckpoint;
            state.strategyRevisionRequired = true;
            state.lastFailure = {
              classification: "policy",
              toolName: toolCall.name,
              reason: decision.reason,
              createdAt: new Date().toISOString(),
            };
          }
          return { block: true, reason: decision.reason };
        }
        const descriptor = descriptors.get(toolCall.name);
        const risk = descriptor?.riskEvaluator(args);
        if (risk && this.overrides.permissionGate) {
          await audit.append("permission.request", {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            risk,
            args: sanitizeSecrets(args),
          }, { source: "policy", actor: "permission-broker", correlationId: toolCall.id, parentSequence: requested.sequence });
          const resolution = await this.overrides.permissionGate.authorize({ sessionId: id, toolCallId: toolCall.id, toolName: toolCall.name, args: sanitizeSecrets(args), risk }, options.signal);
          await audit.append("permission.resolved", {
            requestId: resolution.request.id,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            decision: resolution.decision,
            source: resolution.source,
          }, { source: "operator", actor: resolution.source, correlationId: toolCall.id, parentSequence: requested.sequence });
          if (resolution.decision === "deny") return { block: true, reason: `Tool permission denied (${resolution.source})` };
        }
        policy.recordAllowed(toolCall.name, decision, state);
        state.updatedAt = new Date().toISOString();
        return undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        const persistedContent = sanitizeSecrets(publicContent(result.content));
        const persistedDetails = sanitizeSecrets(result.details);
        await audit.append("tool.result", {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: sanitizeSecrets(args),
          isError,
          content: persistedContent,
          details: persistedDetails,
        }, {
          source: "tool",
          actor: toolCall.name,
          correlationId: toolCall.id,
          ...(toolRequestSequences.get(toolCall.id) !== undefined ? { parentSequence: toolRequestSequences.get(toolCall.id)! } : {}),
        });
        if (!isError && !["submit_plan", "checkpoint", "record_finding", "record_lesson", "finish_task", "read_shared_evidence", "publish_shared_evidence"].includes(toolCall.name)) {
          const observation = JSON.stringify({ content: persistedContent, details: persistedDetails });
          if (observation) {
            observedToolOutputs.push(observation.slice(0, 12_000));
            if (observedToolOutputs.length > 32) observedToolOutputs.shift();
          }
        }
        if (isError && !["submit_plan", "checkpoint", "record_finding", "record_lesson", "finish_task"].includes(toolCall.name)) {
          state.actionsSinceCheckpoint = runtimeConfig.maxActionsWithoutCheckpoint;
          state.strategyRevisionRequired = true;
          state.lastFailure = {
            classification: "tool",
            toolName: toolCall.name,
            reason: "Tool execution returned an error",
            createdAt: new Date().toISOString(),
          };
        }
        await writeJson(join(runDirectory, "state.json"), state);
        await webReasoning.afterToolResult({ toolName: toolCall.name, toolCallId: toolCall.id, args, result: { content: result.content, details: result.details }, isError });
        if (webReasoning.enabled && this.config.webReasoning?.persistState !== false) await writeJson(join(runDirectory, "state.json"), state);
        await emit("tool.result", { toolName: toolCall.name, isError });
        return undefined;
      },
    });
    const abortRun = () => {
      state.stopReason = "Run stopped by operator";
      agent.abort();
    };
    options.signal?.addEventListener("abort", abortRun, { once: true });

    agent.subscribe(async (event) => {
      if (event.type === "turn_start") {
        state.turns += 1;
        state.updatedAt = new Date().toISOString();
        await audit.append("turn.started", { turn: state.turns });
        await emit("turn.started", { turn: state.turns });
        if (state.turns > runtimeConfig.maxTurns) {
          if (webReasoning.enabled) await webReasoning.beforeFinalization(0);
          state.stopReason = "Turn budget exhausted";
          agent.abort();
        } else if (webReasoning.enabled && state.turns >= Math.max(1, runtimeConfig.maxTurns - webReasoning.config.finalizationRoundReserve)) {
          await webReasoning.beforeFinalization(runtimeConfig.maxTurns - state.turns);
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        await audit.append("assistant.message", publicMessage(event.message), { source: "model", actor: "primary-agent", ...(activeModelRequestId ? { correlationId: activeModelRequestId } : {}) });
        if (
          state.status === "running" &&
          hitOutputLimitWithoutToolCall(event.message) &&
          lengthRecoveryAttempts < MAX_LENGTH_RECOVERY_ATTEMPTS
        ) {
          lengthRecoveryAttempts += 1;
          agent.followUp({
            role: "user",
            content: [{
              type: "text",
              text: "The previous response exhausted its output budget before issuing a tool call. Continue from the preserved context with concise reasoning and immediately issue the next required structured tool call. Do not restart the analysis. If the evidence is insufficient, call finish_task with blocked status.",
            }],
            timestamp: Date.now(),
          });
          await audit.append("model.length_recovery", {
            attempt: lengthRecoveryAttempts,
            maximumAttempts: MAX_LENGTH_RECOVERY_ATTEMPTS,
            thinkingLevel: recoveryThinkingLevel,
          });
          await emit("model.length_recovery", {
            attempt: lengthRecoveryAttempts,
            maximumAttempts: MAX_LENGTH_RECOVERY_ATTEMPTS,
            thinkingLevel: recoveryThinkingLevel,
          });
        } else if (
          state.status === "running" &&
          event.message.stopReason === "stop" &&
          assistantText(event.message).trim().length === 0 &&
          !event.message.content.some((item) => item.type === "toolCall") &&
          noActionRecoveryAttempts < MAX_NO_ACTION_RECOVERY_ATTEMPTS
        ) {
          noActionRecoveryAttempts += 1;
          agent.followUp({
            role: "user",
            content: [{
              type: "text",
              text: "The previous turn ended without a structured tool call. Continue from the preserved evidence now: either issue the next required bounded tool call, or call finish_task. Do not return another prose-only response; if the evidence is sufficient, run the smallest independent verification script and then submit the exact result with finish_task.",
            }],
            timestamp: Date.now(),
          });
          await audit.append("model.no_action_recovery", {
            attempt: noActionRecoveryAttempts,
            maximumAttempts: MAX_NO_ACTION_RECOVERY_ATTEMPTS,
            hadVisibleText: assistantText(event.message).trim().length > 0,
          });
          await emit("model.no_action_recovery", {
            attempt: noActionRecoveryAttempts,
            maximumAttempts: MAX_NO_ACTION_RECOVERY_ATTEMPTS,
          });
        }
      } else if (event.type === "tool_execution_start") {
        await emit("tool.started", { toolName: event.toolName });
      }
    });

    state.phase = "planning";
    const timer = setTimeout(() => {
      state.stopReason = "Runtime budget exhausted";
      agent.abort();
    }, runtimeConfig.maxRuntimeMs);

    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Run stopped by operator");
      if (!this.overrides.streamFn && !apiKey) {
        throw new Error(this.overrides.modelApiKey ? "Missing model credential for the active model session" : `Missing model credential in environment variable ${this.config.model.apiKeyEnv}`);
      }
      const reasoningContext = webReasoning.enabled
        ? await webReasoning.beforeTurn(runtimeConfig.maxTurns - state.turns, runtimeConfig.maxToolCalls - state.toolCalls, toolSet.tools.map((tool) => tool.name))
        : "";
      let knowledgeContext = "";
      if (this.overrides.knowledgeStore) {
        try {
          const retrieval = await this.overrides.knowledgeStore.searchContext(renderKnowledgeQuery(task), { limit: 5, maxChars: 12_000 });
          knowledgeContext = retrieval.context;
          await audit.append("knowledge.retrieved", {
            resultCount: retrieval.results.length,
            documents: retrieval.results.map(({ document, score }) => ({ docId: document.docId, score, trust: document.trust, promptInjectionSuspected: document.promptInjectionSuspected })),
          }, { source: "context", actor: "knowledge-retriever" });
          await emit("knowledge.retrieved", {
            resultCount: retrieval.results.length,
            docIds: retrieval.results.map(({ document }) => document.docId),
          });
        } catch (error) {
          await audit.append("knowledge.retrieval_failed", {
            reason: error instanceof Error ? error.message : String(error),
          }, { source: "context", actor: "knowledge-retriever" });
          await emit("knowledge.retrieval_failed", { reason: "Knowledge retrieval unavailable; continuing without retrieved context" });
        }
      }
      const promptSections = [
        { name: "capability-playbook", content: renderCapabilityPlaybook(task.metadata.category ?? (webReasoning.enabled ? "Web" : undefined)) },
        { name: "reasoning-state", content: reasoningContext },
        { name: "verified-experience", content: renderExperienceContext(experience) },
        { name: "memory", content: memoryContext },
        { name: "knowledge", content: knowledgeContext },
        ...(options.contextSections ?? []).slice(0, 8).map((section) => ({
          name: String(section.name).slice(0, 120),
          content: String(section.content).slice(0, 12_000),
        })),
        ...(options.lineage?.context ? [{ name: "inherited-trajectory", content: options.lineage.context }] : []),
        { name: "task", content: renderTaskContext(task) },
      ].filter((section) => Boolean(section.content));
      await audit.append("context.injected", {
        target: "primary-agent",
        sections: promptSections.map((section) => boundedContextSection(section.name, section.content)),
      }, { source: "context", actor: "context-assembler" });
      await agent.prompt(promptSections.map((section) => section.content).join("\n\n"));
      if (state.status === "running") {
        const last = agent.state.messages.at(-1);
        if (last?.role === "assistant" && last.stopReason === "aborted") {
          state.status = "aborted";
          state.stopReason ??= last.errorMessage ?? "Agent was aborted";
        } else if (last?.role === "assistant" && last.stopReason === "error") {
          state.status = "failed";
          state.stopReason = last.errorMessage ?? "Model request failed";
        } else if (last?.role === "assistant" && last.stopReason === "length") {
          state.status = "failed";
          state.stopReason = `Model exhausted the output token limit after ${lengthRecoveryAttempts} recovery attempt(s)`;
          state.summary = assistantText(last);
        } else {
          state.status = "blocked";
          state.stopReason = "Agent ended without finish_task";
          if (last?.role === "assistant") state.summary = assistantText(last);
        }
      }
    } catch (error) {
      state.status = "failed";
      state.stopReason = error instanceof Error ? error.message : String(error);
      state.providerError = classifyProviderError(error);
      await audit.append("run.error", { message: state.stopReason, providerError: state.providerError });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortRun);
      this.overrides.permissionGate?.cancelSession?.(id);
      await toolSet.cleanup();
      state.phase = "done";
      if (webReasoning.enabled && state.status !== "completed") {
        await webReasoning.beforeFinalization(0);
      }
      if (webReasoning.enabled) await webReasoning.complete(state.status === "completed" ? "completed" : "blocked");
      if (webReasoning.enabled) state.webReasoning = webReasoning.serialize();
      state.updatedAt = new Date().toISOString();
      state.finishedAt = state.updatedAt;
      const transcript = agent.state.messages.map(publicMessage);
      if (options.writeup === true && state.summary?.trim()) {
        if (await writeupLooksComplete(state.summary)) {
          state.writeup = state.summary.trim();
          delete state.writeupError;
          await audit.append("writeup.reused", { characters: state.writeup.length, source: "agent-summary" }, { source: "orchestrator", actor: "writeup-generator" });
        } else {
          await audit.append("writeup.generation_requested", {
            status: state.status,
            submissionPresent: Boolean(state.submission),
            transcriptMessages: transcript.length,
          }, { source: "orchestrator", actor: "writeup-generator" });
          try {
            const generated = await generateWriteupDocument({
              runId: id,
              task,
              state,
              transcript,
              model,
              streamFn,
              ...(apiKey ? { apiKey } : {}),
              maxRetryDelayMs: runtimeConfig.modelMaxRetryDelayMs,
              timeoutMs: runtimeConfig.finalizationReserveMs,
            });
            state.writeup = generated.markdown;
            delete state.writeupError;
            await audit.append("writeup.generated", { attempts: generated.attempts, characters: generated.markdown.length }, { source: "orchestrator", actor: "writeup-generator" });
          } catch (error) {
            state.writeupError = (error instanceof Error ? error.message : String(error)).slice(0, 600);
            await audit.append("writeup.failed", { error: state.writeupError }, { source: "orchestrator", actor: "writeup-generator" });
          }
        }
      }
      state.handoffPath = "handoff.md";
      try {
        const handoff = renderRunHandoff(state);
        await writeFile(join(runDirectory, state.handoffPath), handoff, "utf8");
        await audit.append("run.handoff_written", { path: state.handoffPath, characters: handoff.length }, { source: "orchestrator", actor: "handoff-writer" });
      } catch (error) {
        await audit.append("run.handoff_failed", { reason: error instanceof Error ? error.message : String(error) }, { source: "orchestrator", actor: "handoff-writer" });
      }
      await writeJson(join(runDirectory, "state.json"), state);
      await writeJson(join(runDirectory, "findings.json"), state.findings);
      await writeJson(join(runDirectory, "transcript.json"), transcript);
      await audit.append("run.settled", {
        status: state.status,
        stopReason: state.stopReason,
        turns: state.turns,
        toolCalls: state.toolCalls,
        imageObservations: state.imageObservations,
        httpRequests: state.httpRequests,
        tcpSessions: state.tcpSessions,
        findings: state.findings.length,
        lessons: state.lessons.length,
      });
      await audit.flush();
      await emit("run.settled", { status: state.status, stopReason: state.stopReason });
    }
    return state;
  }
}

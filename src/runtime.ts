import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { AuditChain } from "./audit.js";
import { createAgentSession, type AgentDriverEventType, type AgentSession } from "./agent-driver.js";
import { mergeScope } from "./config.js";
import { SandboxExecutor } from "./executor.js";
import { ExperienceStore, renderExperienceContext } from "./experience.js";
import { renderRunHandoff } from "./handoff.js";
import { normalizeTask, renderTaskContext } from "./input.js";
import { startModelGateway, type ModelGateway, type ModelGatewayUpstream, type ModelRouteOptions } from "./model-gateway.js";
import { PolicyEngine } from "./policy.js";
import { classifyProviderError } from "./provider-errors.js";
import { filterProfileTools, narrowToolsForCategory, resolveAgentProfile, validateProfileCapabilities } from "./profiles.js";
import { renderCapabilityPlaybook } from "./playbooks.js";
import { sanitizeSecrets } from "./sanitize.js";
import { boundedContextSection } from "./session-trajectory.js";
import type { SharedEvidenceBoard } from "./shared-evidence.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createToolSet } from "./tools.js";
import { createToolCallPipeline, createXuanShuMcpServer } from "./tool-adapter.js";
import { toolDescriptorMap, type ToolEffect } from "./tool-catalog.js";
import type { AppConfig, ModelConfig, NormalizedTask, RunEvent, RunLineage, RunState, RuntimeModelSessionConfig, RuntimeOverrides, TaskRequest } from "./types.js";
import { submissionPolicyFor } from "./submission-policy.js";
import { createWebReasoningController } from "./web-reasoning/controller.js";
import { detectWebTask } from "./web-reasoning/task-detector.js";
import { generateWriteup as generateWriteupDocument } from "./writeup-generator.js";
import { resolveCtfSkillCategory } from "./skill-catalog.js";
import { projectRunSummary, RUN_SUMMARY_FILE } from "./run-summary.js";

export type { RuntimeModelSessionConfig } from "./types.js";

/**
 * Rate limiting disabled: the gateway still serializes requests and accounts
 * actual token usage, but never delays or rejects them.
 */
const UNLIMITED_MODEL_LIMITS = {
  minimumIntervalMs: 0,
  requestsPerMinute: Number.POSITIVE_INFINITY,
  tokensPerMinute: Number.POSITIVE_INFINITY,
};

export interface RuntimeModelStatus {
  configured: boolean;
  source: "session" | "environment" | "missing";
  provider: string;
  id: string;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  appKeyHeaderConfigured: boolean;
}

function assistantText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item) && typeof item === "object" && (item as { type?: string }).type === "text")
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

async function writeupLooksComplete(value: string | undefined): Promise<boolean> {
  const text = value?.trim() ?? "";
  return /^---\s*\n[\s\S]*?\n---\s*\n/m.test(text)
    && text.includes("## Summary")
    && text.includes("## Solution")
    && text.includes("## Flag")
    && /```[A-Za-z0-9_+-]+\n[\s\S]*?```/.test(text);
}

function publicContent(content: unknown[]): unknown[] {  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [block];
    const value = block as { type?: string; data?: unknown; mimeType?: unknown; content?: unknown };
    if (value.type === "thinking") return [];
    // Image blocks ride nested inside tool_result content — redact those too.
    if (value.type === "tool_result" && Array.isArray(value.content)) {
      return [{ ...block, content: publicContent(value.content) }];
    }
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

/** Bounds concurrently spawned agent CLI subprocesses; excess runs queue before spawning. */
class SdkSessionLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
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

export async function writeRunState(runDirectory: string, state: RunState): Promise<void> {
  await writeJson(join(runDirectory, "state.json"), state);
  await writeJson(join(runDirectory, RUN_SUMMARY_FILE), projectRunSummary(state));
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
  private gatewayPromise: Promise<ModelGateway> | undefined;
  private limiter: SdkSessionLimiter | undefined;

  constructor(config: AppConfig, overrides: RuntimeOverrides = {}) {
    this.config = config;
    this.overrides = overrides;
  }

  private ensureGateway(): Promise<ModelGateway> {
    if (this.overrides.gateway) return Promise.resolve(this.overrides.gateway);
    this.gatewayPromise ??= startModelGateway();
    return this.gatewayPromise;
  }

  private sdkLimiter(maxConcurrentSdkSessions: number): SdkSessionLimiter {
    this.limiter ??= new SdkSessionLimiter(Math.max(1, maxConcurrentSdkSessions));
    return this.limiter;
  }

  private effectiveModel(): { modelConfig: ModelConfig; apiKey?: string; headers?: Record<string, string> } {
    const session = this.overrides.sessionModel;
    if (session) {
      return { modelConfig: session.model, apiKey: session.apiKey, ...(session.headers ? { headers: session.headers } : {}) };
    }
    const modelConfig = this.config.model;
    const apiKey = process.env[modelConfig.apiKeyEnv];
    return { modelConfig, ...(apiKey ? { apiKey } : {}) };
  }

  private buildUpstream(modelConfig: ModelConfig, apiKey: string | undefined, headers: Record<string, string> | undefined): ModelGatewayUpstream {
    return {
      baseUrl: modelConfig.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(modelConfig.authScheme ? { authScheme: modelConfig.authScheme } : {}),
      ...(headers ? { headers } : {}),
      // The route rewrites the request's model field, guarding against
      // subprocess-environment leakage of a different model id.
      modelId: modelConfig.id,
    };
  }

  configureModel(input: RuntimeModelSessionConfig): void {
    this.overrides.sessionModel = input;
  }

  clearConfiguredModel(): void {
    delete this.overrides.sessionModel;
  }

  modelStatus(): RuntimeModelStatus {
    const { modelConfig, apiKey, headers } = this.effectiveModel();
    const session = Boolean(this.overrides.sessionModel);
    return {
      configured: Boolean(apiKey),
      source: session ? "session" : apiKey ? "environment" : "missing",
      provider: modelConfig.provider,
      id: modelConfig.id,
      name: modelConfig.name,
      baseUrl: modelConfig.baseUrl,
      reasoning: modelConfig.reasoning ?? false,
      appKeyHeaderConfigured: Boolean(headers && Object.keys(headers).length > 0),
    };
  }

  async generateWriteup(state: RunState, transcript: unknown[], signal?: AbortSignal): Promise<string> {
    const { modelConfig, apiKey, headers } = this.effectiveModel();
    const gateway = await this.ensureGateway();
    const writeupKey = `${state.id}:writeup:manual`;
    gateway.setRoute(writeupKey, {
      upstream: this.buildUpstream(modelConfig, apiKey, headers),
      // Rate limiting is disabled: no minimum interval or RPM/TPM caps. The
      // gateway still audits every request and accounts actual token usage.
      limits: UNLIMITED_MODEL_LIMITS,
    });
    try {
      const result = await generateWriteupDocument({
        runId: state.id,
        task: state.task as NormalizedTask,
        state,
        transcript,
        modelId: modelConfig.id,
        baseUrl: gateway.routeUrl(writeupKey),
        timeoutMs: this.config.runtime.finalizationReserveMs,
        ...(this.overrides.sdk ? { sdk: this.overrides.sdk } : {}),
        ...(signal ? { signal } : {}),
      });
      return result.markdown;
    } finally {
      gateway.releaseRoute(writeupKey);
    }
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
    const runtimeConfig = {
      ...this.config.runtime,
      scratchRoot: runScratchRoot,
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
    const { modelConfig, apiKey, headers: sessionHeaders } = this.effectiveModel();
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
        provider: modelConfig.provider,
        id: modelConfig.id,
        baseUrl: modelConfig.baseUrl,
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
    await writeRunState(runDirectory, state);
    await emit("run.started", { status: state.status, phase: state.phase });
    const webReasoning = createWebReasoningController(state, audit, this.config.webReasoning);
    await webReasoning.initialize();
    if (webReasoning.enabled && this.config.webReasoning?.persistState !== false) await writeRunState(runDirectory, state);

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
    const gateway = await this.ensureGateway();
    const runKey = id;
    // Rate limiting is disabled: no minimum interval or RPM/TPM caps. The
    // gateway still audits every request and accounts actual token usage.
    const limits = UNLIMITED_MODEL_LIMITS;
    // The gateway numbers requests `${runKey}:request:N`; contextMeta fires
    // exactly once per request, so this mirror yields the live correlation id.
    let gatewayRequestCount = 0;
    let activeModelRequestId: string | undefined;
    const routeOptions: ModelRouteOptions = {
      upstream: this.buildUpstream(modelConfig, apiKey, sessionHeaders),
      limits,
      audit,
      emit: (event) => emit(event.type, event.data),
      contextMeta: () => {
        gatewayRequestCount += 1;
        activeModelRequestId = `${runKey}:request:${gatewayRequestCount}`;
        return {
          turn: state.turns,
          model: { provider: modelConfig.provider, id: modelConfig.id, baseUrl: modelConfig.baseUrl },
          thinkingLevel: runThinkingLevel,
        };
      },
    };
    gateway.setRoute(runKey, routeOptions);
    let lengthRecoveryAttempts = 0;
    const pipeline = createToolCallPipeline({
      state,
      runtime: runtimeConfig,
      audit,
      policy,
      descriptors,
      webReasoning,
      ...(this.overrides.permissionGate ? { permissionGate: this.overrides.permissionGate } : {}),
      submissionPolicy,
      allowedToolNames: toolSet.tools.map((tool) => tool.name),
      emit,
      persistState: (current) => writeRunState(runDirectory, current),
      webReasoningPersistState: this.config.webReasoning?.persistState !== false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const mcpServer = createXuanShuMcpServer({
      tools: toolSet.tools,
      pipeline,
      ...(options.signal ? { signal: options.signal } : {}),
      // Sandbox commands run long; keep the MCP call timeout above them.
      timeoutMs: runtimeConfig.commandTimeoutMs + 10_000,
    });
    let session: AgentSession | undefined;
    const handleDriverEvent = async (type: AgentDriverEventType, data: unknown): Promise<void> => {
      if (type === "turn.started") {
        state.turns = Math.max(state.turns, (data as { turn: number }).turn);
        state.updatedAt = new Date().toISOString();
        await audit.append("turn.started", { turn: state.turns });
        await emit("turn.started", { turn: state.turns });
      } else if (type === "assistant.message") {
        await audit.append("assistant.message", publicMessage(data), { source: "model", actor: "primary-agent", ...(activeModelRequestId ? { correlationId: activeModelRequestId } : {}) });
      } else if (type === "tool.started") {
        await emit("tool.started", data);
      } else if (type === "model.length_recovery") {
        lengthRecoveryAttempts = (data as { attempt: number }).attempt;
        await audit.append("model.length_recovery", data);
        await emit("model.length_recovery", data);
      } else if (type === "model.no_action_recovery") {
        await audit.append("model.no_action_recovery", data);
        await emit("model.no_action_recovery", data);
      } else if (type === "context.compacted") {
        const cut = data as { trigger?: unknown; preTokens?: unknown; postTokens?: unknown };
        const record = await audit.append("context.compacted", {
          detectedBy: "sdk",
          trigger: cut.trigger,
          preTokens: cut.preTokens,
          ...(cut.postTokens !== undefined ? { postTokens: cut.postTokens } : {}),
        });
        state.contextCuts ??= [];
        state.contextCuts.push({
          id: `sdk-compact-${record.sequence}`,
          throughSeq: record.sequence - 1,
          throughMessageCount: 0,
          sourceEventCount: 0,
          summary: "",
          createdAt: record.timestamp,
        });
        state.contextCuts = state.contextCuts.slice(-20);
        await emit("context.compacted", data);
      } else if (type === "model.provider_retry") {
        const retry = data as { attempt?: unknown; retryDelayMs?: unknown; errorStatus?: unknown; error?: unknown };
        const errorClass = classifyProviderError(new Error(String(retry.error ?? "provider error")));
        const entry = {
          ...(activeModelRequestId ? { requestId: activeModelRequestId } : {}),
          attempt: retry.attempt,
          delayMs: retry.retryDelayMs,
          ...(retry.errorStatus !== undefined ? { errorStatus: retry.errorStatus } : {}),
          errorClass,
        };
        await audit.append("model.provider_retry", entry);
        await emit("model.provider_retry", { attempt: retry.attempt, delayMs: retry.retryDelayMs, errorClass });
      }
    };
    const abortRun = () => {
      state.stopReason = "Run stopped by operator";
      session?.abort("Run stopped by operator");
    };
    options.signal?.addEventListener("abort", abortRun, { once: true });

    state.phase = "planning";
    const limiter = this.sdkLimiter(runtimeConfig.maxConcurrentSdkSessions);

    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Run stopped by operator");
      if (!apiKey) {
        throw new Error(this.overrides.sessionModel ? "Missing model credential for the active model session" : `Missing model credential in environment variable ${modelConfig.apiKeyEnv}`);
      }
      const reasoningContext = webReasoning.enabled
        ? await webReasoning.beforeTurn(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, toolSet.tools.map((tool) => tool.name))
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
      await limiter.acquire();
      try {
        session = createAgentSession({
          runId: id,
          systemPrompt: buildSystemPrompt(scope, runtimeConfig, {
            reachable: sandboxReachable,
            network: sandboxNetwork,
            configuredPrograms: [...configuredScope.allowedPrograms],
            unavailablePrograms,
            availablePythonModules: [...(executorHealth.pythonModules ?? [])],
            unavailablePythonModules: [...(executorHealth.missingPythonModules ?? [])],
          }, { sharedEvidence: Boolean(options.sharedEvidence) }, { id: profile.id, instructions: profile.systemPrompt }),
          modelId: modelConfig.id,
          baseUrl: gateway.routeUrl(runKey),
          thinkingLevel: runThinkingLevel,
          mcpServer,
          sessionId: id,
          isSettled: pipeline.isSettled,
          shouldRecover: () => state.status === "running",
          ...(this.overrides.sdk ? { sdk: this.overrides.sdk } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onEvent: handleDriverEvent,
        });
        session.prompt(promptSections.map((section) => section.content).join("\n\n"));
        const result = await session.done;
        const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        const lastText = lastAssistant ? assistantText(lastAssistant) : "";
        if (state.status === "running") {
          if (result.aborted) {
            state.status = "aborted";
            state.stopReason ??= result.abortReason ?? "Run aborted";
          } else if (result.isError || result.subtype === "error_during_execution") {
            state.status = "failed";
            state.stopReason = result.errorMessage ?? "Model request failed";
            state.providerError = classifyProviderError(new Error(state.stopReason));
          } else if (result.stopReason === "max_tokens") {
            state.status = "failed";
            state.stopReason = `Model exhausted the output token limit after ${lengthRecoveryAttempts} recovery attempt(s)`;
            state.summary = lastText;
          } else {
            state.status = "blocked";
            state.stopReason = "Agent ended without finish_task";
            if (lastText) state.summary = lastText;
          }
        }
      } finally {
        limiter.release();
      }
    } catch (error) {
      state.status = "failed";
      state.stopReason = error instanceof Error ? error.message : String(error);
      state.providerError = classifyProviderError(error);
      await audit.append("run.error", { message: state.stopReason, providerError: state.providerError });
    } finally {
      options.signal?.removeEventListener("abort", abortRun);
      gateway.releaseRoute(runKey);
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
      const transcript = (session?.messages ?? []).map(publicMessage);
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
            const writeupKey = `${id}:writeup`;
            gateway.setRoute(writeupKey, routeOptions);
            let generated: { markdown: string; attempts: number };
            await limiter.acquire();
            try {
              generated = await generateWriteupDocument({
                runId: id,
                task,
                state,
                transcript,
                modelId: modelConfig.id,
                baseUrl: gateway.routeUrl(writeupKey),
                timeoutMs: runtimeConfig.finalizationReserveMs,
                ...(this.overrides.sdk ? { sdk: this.overrides.sdk } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
              });
            } finally {
              limiter.release();
              gateway.releaseRoute(writeupKey);
            }
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
      await writeRunState(runDirectory, state);
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

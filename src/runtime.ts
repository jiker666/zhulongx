import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import { lazyStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { AuditChain } from "./audit.js";
import { mergeScope } from "./config.js";
import { ExperienceStore, renderExperienceContext } from "./experience.js";
import { normalizeTask, renderTaskContext } from "./input.js";
import { estimateModelRequestTokens, ModelRequestGate } from "./model-rate-limit.js";
import { PolicyEngine } from "./policy.js";
import { renderCapabilityPlaybook } from "./playbooks.js";
import { sanitizeSecrets } from "./sanitize.js";
import { SandboxClient } from "./sandbox.js";
import type { SharedEvidenceBoard } from "./shared-evidence.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createToolSet } from "./tools.js";
import type { AppConfig, NormalizedTask, RunEvent, RunState, RuntimeOverrides, TaskRequest } from "./types.js";

type SupportedModelApi = "anthropic-messages" | "openai-completions" | "openai-responses";
const MAX_LENGTH_RECOVERY_ATTEMPTS = 2;
const sharedModelRequestGates = new WeakMap<AppConfig, ModelRequestGate>();

export { ModelRequestGate } from "./model-rate-limit.js";

export function createModel(config: AppConfig["model"]): Model<SupportedModelApi> {
  const headers = Object.fromEntries(
    Object.entries(config.headersFromEnv ?? {}).flatMap(([header, envName]) => {
      const value = process.env[envName];
      return value ? [[header, value]] : [];
    }),
  );
  return {
    id: config.id,
    name: config.name,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
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
  return (model, context, options) => {
    if (model.api === "anthropic-messages") {
      return streamAnthropicMessages(model as Model<"anthropic-messages">, context, options);
    }
    if (model.api === "openai-responses") {
      return streamOpenAIResponses(model as Model<"openai-responses">, context, options);
    }
    return streamOpenAICompletions(model as Model<"openai-completions">, context, options);
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function hitOutputLimitWithoutToolCall(message: AssistantMessage): boolean {
  return message.stopReason === "length" && !message.content.some((item) => item.type === "toolCall");
}

function lengthRecoveryThinkingLevel(
  configured: AppConfig["runtime"]["thinkingLevel"],
): AppConfig["runtime"]["thinkingLevel"] {
  return ["medium", "high", "xhigh", "max"].includes(configured) ? "low" : configured;
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(sanitizeSecrets(value), null, 2)}\n`, "utf8");
}

export interface RunOptions {
  id?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  signal?: AbortSignal;
  workspaceMode?: "configured" | "attachments-only";
  sharedEvidence?: SharedEvidenceBoard;
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

  async run(request: TaskRequest, options: RunOptions = {}): Promise<RunState> {
    const id = options.id ?? randomUUID();
    const configuredScope = mergeScope(this.config.scope, request.scope);
    const task = await normalizeTask(request);
    const runDirectory = join(this.config.runtime.artifactRoot, id);
    const runScratchRoot = join(this.config.runtime.scratchRoot, "runs", id);
    const runtimeConfig = { ...this.config.runtime, scratchRoot: runScratchRoot };
    const workspaceMode = options.workspaceMode ?? "configured";
    const isolatedInputRoot = join(runScratchRoot, "inputs");
    await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(runScratchRoot, { recursive: true })]);
    if (workspaceMode === "attachments-only") {
      await stageAttachmentsOnly(task, isolatedInputRoot, options.signal);
    }
    let sandboxReachable = false;
    let sandboxNetwork = "unknown";
    let availablePrograms: string[] = [];
    try {
      const health = await new SandboxClient(
        runtimeConfig.sandbox.socketPath,
        runtimeConfig.sandbox.connectTimeoutMs,
      ).health();
      sandboxReachable = true;
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
    const audit = new AuditChain(join(runDirectory, "audit.jsonl"), id);
    const experience = await new ExperienceStore(this.config.runtime.artifactRoot).relevant(task.metadata.category);
    const now = new Date().toISOString();
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
        provider: this.config.model.provider,
        id: this.config.model.id,
        api: this.config.model.api,
        baseUrl: this.config.model.baseUrl,
      },
      budgets: runtimeConfig,
      appliedExperience: experience.map((record) => ({ id: record.id, title: record.title, category: record.category })),
    });
    await writeJson(join(runDirectory, "state.json"), state);
    await emit("run.started", { status: state.status, phase: state.phase });

    const policy = new PolicyEngine(scope, runtimeConfig);
    const toolSet = createToolSet({
      state,
      scope,
      runtime: runtimeConfig,
      audit,
      sandboxNamespace: id,
      ...(options.sharedEvidence ? { sharedEvidence: options.sharedEvidence } : {}),
    });
    const model = this.overrides.model ?? createModel(this.config.model);
    const providerStreamFn = this.overrides.streamFn ?? defaultStreamFn();
    const streamFn: StreamFn = (turnModel, context, streamOptions) => lazyStream(turnModel, async () => {
      const reservation = await this.modelRequestGate.wait({
        minimumIntervalMs: runtimeConfig.modelMinIntervalMs,
        requestsPerMinute: runtimeConfig.modelRequestsPerMinute,
        tokensPerMinute: runtimeConfig.modelTokensPerMinute,
        estimatedTokens: estimateModelRequestTokens(turnModel, context, streamOptions),
      }, streamOptions?.signal);
      await audit.append("model.request_reserved", {
        estimatedTokens: reservation.estimatedTokens,
        waitedMs: reservation.waitedMs,
        requestsPerMinute: runtimeConfig.modelRequestsPerMinute,
        tokensPerMinute: runtimeConfig.modelTokensPerMinute,
      });
      if (reservation.waitedMs > 0) {
        await emit("model.request_throttled", {
          estimatedTokens: reservation.estimatedTokens,
          waitedMs: reservation.waitedMs,
        });
      }
      return await providerStreamFn(turnModel, context, streamOptions);
    });
    const apiKey = process.env[this.config.model.apiKeyEnv];
    const recoveryThinkingLevel = lengthRecoveryThinkingLevel(runtimeConfig.thinkingLevel);
    let lengthRecoveryAttempts = 0;
    const agent = new Agent({
      streamFn,
      sessionId: id,
      toolExecution: "sequential",
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
        }, { sharedEvidence: Boolean(options.sharedEvidence) }),
        model,
        thinkingLevel: runtimeConfig.thinkingLevel,
        tools: toolSet.tools,
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const decision = policy.evaluate(toolCall.name, args, state);
        await audit.append("policy.decision", {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: sanitizeSecrets(args),
          allowed: decision.allowed,
          reason: decision.reason,
          signature: decision.signature,
        });
        await emit("policy.decision", { toolName: toolCall.name, allowed: decision.allowed, reason: decision.reason });
        if (!decision.allowed) {
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
        policy.recordAllowed(toolCall.name, decision, state);
        state.updatedAt = new Date().toISOString();
        return undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        await audit.append("tool.result", {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: sanitizeSecrets(args),
          isError,
          content: sanitizeSecrets(publicContent(result.content)),
          details: sanitizeSecrets(result.details),
        });
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
          state.stopReason = "Turn budget exhausted";
          agent.abort();
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        await audit.append("assistant.message", publicMessage(event.message));
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
        throw new Error(`Missing model credential in environment variable ${this.config.model.apiKeyEnv}`);
      }
      await agent.prompt([
        renderCapabilityPlaybook(task.metadata.category),
        renderExperienceContext(experience),
        renderTaskContext(task),
      ].filter(Boolean).join("\n\n"));
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
      await audit.append("run.error", { message: state.stopReason });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortRun);
      await toolSet.cleanup();
      state.phase = "done";
      state.updatedAt = new Date().toISOString();
      state.finishedAt = state.updatedAt;
      const transcript = agent.state.messages.map(publicMessage);
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

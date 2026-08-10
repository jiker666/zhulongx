import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { ProxyAgent } from "undici";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { AuditChain } from "./audit.js";
import { mergeScope } from "./config.js";
import { ExperienceStore, renderExperienceContext } from "./experience.js";
import { normalizeTask, renderTaskContext } from "./input.js";
import { PolicyEngine } from "./policy.js";
import { renderCapabilityPlaybook } from "./playbooks.js";
import { sanitizeSecrets } from "./sanitize.js";
import { SandboxClient } from "./sandbox.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createToolSet } from "./tools.js";
import { createWebReasoningController } from "./web-reasoning/controller.js";
import { detectWebTask } from "./web-reasoning/task-detector.js";
import type { AppConfig, RunEvent, RunState, RuntimeOverrides, TaskRequest } from "./types.js";

export function createModel(config: AppConfig["model"]): Model<"openai-completions" | "openai-responses"> {
  return {
    id: config.id,
    name: config.name,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    ...(config.api === "openai-responses"
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : {}),
    compat: config.api === "openai-responses"
      ? {
          supportsDeveloperRole: false,
          supportsLongCacheRetention: false,
          supportsStrictMode: true,
        }
      : {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsStrictMode: true,
        },
  };
}

function defaultStreamFn(): StreamFn {
  const proxyUrl = process.env.TSEC_PROXY?.trim();
  const proxy = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const modelFetch = proxy
    ? ((input: string | URL | Request, init?: RequestInit) => fetch(input, { ...(init ?? {}), dispatcher: proxy } as RequestInit))
    : undefined;
  return (model, context, options) =>
    model.api === "openai-responses"
      ? streamOpenAIResponses(model as Model<"openai-responses">, context, { ...options, ...(modelFetch ? { fetch: modelFetch } : {}) })
      : streamOpenAICompletions(model as Model<"openai-completions">, context, { ...options, ...(modelFetch ? { fetch: modelFetch } : {}) });
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function waitForModelInterval(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw signal.reason ?? new Error("Model turn aborted");
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(signal?.reason ?? new Error("Model turn aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function publicMessage(message: unknown): unknown {
  if (!message || typeof message !== "object" || !("role" in message)) return message;
  const value = message as { role: string; content?: unknown[]; [key: string]: unknown };
  if (value.role !== "assistant" || !Array.isArray(value.content)) return sanitizeSecrets(value);
  return sanitizeSecrets({
    ...value,
    content: value.content.filter(
      (block) => !block || typeof block !== "object" || (block as { type?: string }).type !== "thinking",
    ),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface RunOptions {
  id?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
}

export class XuanShuRuntime {
  readonly config: AppConfig;
  readonly overrides: RuntimeOverrides;

  constructor(config: AppConfig, overrides: RuntimeOverrides = {}) {
    this.config = config;
    this.overrides = overrides;
  }

  async run(request: TaskRequest, options: RunOptions = {}): Promise<RunState> {
    const id = options.id ?? randomUUID();
    const configuredScope = mergeScope(this.config.scope, request.scope);
    const task = await normalizeTask(request);
    const runDirectory = join(this.config.runtime.artifactRoot, id);
    const runScratchRoot = join(this.config.runtime.scratchRoot, "runs", id);
    const runtimeConfig = { ...this.config.runtime, scratchRoot: runScratchRoot };
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
    const scope = { ...configuredScope, allowedPrograms: availablePrograms };
    await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(runScratchRoot, { recursive: true })]);
    const audit = new AuditChain(join(runDirectory, "audit.jsonl"), id);
    const webClassification = detectWebTask(task);
    const experience = await new ExperienceStore(this.config.runtime.artifactRoot).relevant(
      task.metadata.category ?? (webClassification.isWeb ? "Web" : undefined),
    );
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
      appliedExperienceIds: experience.map((record) => record.id),
      turns: 0,
      toolCalls: 0,
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
    const webReasoning = createWebReasoningController(state, audit, this.config.webReasoning);
    await webReasoning.initialize();
    if (webReasoning.enabled && this.config.webReasoning?.persistState !== false) await writeJson(join(runDirectory, "state.json"), state);

    const policy = new PolicyEngine(scope, runtimeConfig);
    const toolSet = createToolSet({ state, scope, runtime: runtimeConfig, audit, sandboxNamespace: id, ...(this.config.browser ? { browser: this.config.browser } : {}) });
    const model = this.overrides.model ?? createModel(this.config.model);
    const streamFn = this.overrides.streamFn ?? defaultStreamFn();
    const apiKey = process.env[this.config.model.apiKeyEnv];
    let lastModelTurnAt = 0;
    const agent = new Agent({
      streamFn,
      sessionId: id,
      toolExecution: "sequential",
      getApiKey: () => apiKey,
      maxRetryDelayMs: runtimeConfig.modelMaxRetryDelayMs,
      prepareNextTurn: async (signal) => {
        const waitMs = Math.max(0, runtimeConfig.modelMinIntervalMs - (Date.now() - lastModelTurnAt));
        await waitForModelInterval(waitMs, signal);
        lastModelTurnAt = Date.now();
        return undefined;
      },
      initialState: {
        systemPrompt: buildSystemPrompt(scope, runtimeConfig, {
          reachable: sandboxReachable,
          network: sandboxNetwork,
          configuredPrograms: [...configuredScope.allowedPrograms],
          unavailablePrograms,
        }),
        model,
        thinkingLevel: runtimeConfig.thinkingLevel,
        tools: toolSet.tools,
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const guard = webReasoning.guardToolCall(toolCall.name, args, toolSet.tools.map((tool) => tool.name));
        if (!guard.allowed) {
          await audit.append("WEB_ACTION_GUARD_REJECTED", { toolCallId: toolCall.id, toolName: toolCall.name, decision: guard.decision, reason: guard.reason });
          await emit("WEB_ACTION_GUARD_REJECTED", { toolName: toolCall.name, decision: guard.decision, reason: guard.reason });
          return { block: true, reason: guard.reason };
        }
        const webAction = webReasoning.prepareToolCall(toolCall.name, args, toolCall.id);
        if (webAction.duplicate) {
          await audit.append("WEB_ACTION_SKIPPED_DUPLICATE", { actionId: webAction.actionId, toolName: toolCall.name });
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
        });
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
          content: sanitizeSecrets(result.content),
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
        await webReasoning.afterToolResult({ toolName: toolCall.name, toolCallId: toolCall.id, args, result: { content: result.content, details: result.details }, isError });
        if (webReasoning.enabled && this.config.webReasoning?.persistState !== false) await writeJson(join(runDirectory, "state.json"), state);
        await emit("tool.result", { toolName: toolCall.name, isError });
        return undefined;
      },
    });

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
        await audit.append("assistant.message", publicMessage(event.message));
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
      if (!this.overrides.streamFn && !apiKey) {
        throw new Error(`Missing model credential in environment variable ${this.config.model.apiKeyEnv}`);
      }
      const reasoningContext = webReasoning.enabled
        ? await webReasoning.beforeTurn(runtimeConfig.maxTurns - state.turns, runtimeConfig.maxToolCalls - state.toolCalls, toolSet.tools.map((tool) => tool.name))
        : "";
      await agent.prompt([
        renderCapabilityPlaybook(task.metadata.category ?? (webReasoning.enabled ? "Web" : undefined)),
        reasoningContext,
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
      await writeJson(join(runDirectory, "state.json"), state);
      await writeJson(join(runDirectory, "findings.json"), state.findings);
      await writeJson(join(runDirectory, "transcript.json"), transcript);
      await audit.append("run.settled", {
        status: state.status,
        stopReason: state.stopReason,
        turns: state.turns,
        toolCalls: state.toolCalls,
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

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type McpSdkServerConfigWithInstance, type Options, type Query, type SDKUserMessage, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

export const MAX_LENGTH_RECOVERY_ATTEMPTS = 2;
// Some gateways can end a reasoning turn with no visible text or tool call. Give
// the agent a small, explicit continuation window instead of losing a valid run.
export const MAX_NO_ACTION_RECOVERY_ATTEMPTS = 2;
const MAX_SETTLED_TOOL_TURNS = 2;

const LENGTH_RECOVERY_PROMPT = "The previous response exhausted its output budget before issuing a tool call. Continue from the preserved context with concise reasoning and immediately issue the next required structured tool call. Do not restart the analysis. If the evidence is insufficient, call finish_task with blocked status.";
const NO_ACTION_RECOVERY_PROMPT = "The previous turn ended without a structured tool call. Continue from the preserved evidence now: either issue the next required bounded tool call, or call finish_task. Do not return another prose-only response; if the evidence is sufficient, run the smallest independent verification script and then submit the exact result with finish_task.";

const THINKING_BUDGET_TOKENS: Record<Exclude<AgentThinkingLevel, "off">, number> = {
  minimal: 1_024,
  low: 4_096,
  medium: 10_240,
  high: 20_480,
  xhigh: 40_960,
  max: 61_440,
};

export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Session-level thinking budget for the embedded agent (per-turn downgrade is not possible under the SDK). */
export function sdkThinkingConfig(level: AgentThinkingLevel): ThinkingConfig {
  return level === "off" ? { type: "disabled" } : { type: "enabled", budgetTokens: THINKING_BUDGET_TOKENS[level] };
}

/** The thinking level a post-length turn would use; recorded in the recovery audit as the session-level value. */
export function lengthRecoveryThinkingLevel(configured: AgentThinkingLevel): AgentThinkingLevel {
  return ["medium", "high", "xhigh", "max"].includes(configured) ? "low" : configured;
}

export interface AgentSdkOverride {
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string>;
}

export interface AgentSessionOptions {
  runId: string;
  systemPrompt: string;
  modelId: string;
  /** Loopback model-gateway route URL used as ANTHROPIC_BASE_URL; the gateway injects real credentials upstream. */
  baseUrl: string;
  thinkingLevel: AgentThinkingLevel;
  mcpServer: McpSdkServerConfigWithInstance;
  sessionId?: string;
  resumeSessionId?: string;
  /** True once the run is settled (finish_task accepted); further tool turns are counted and then aborted. */
  isSettled?: () => boolean;
  /** Gate for length/no-action recovery injections (default: always recover while attempts remain). */
  shouldRecover?: () => boolean;
  sdk?: AgentSdkOverride;
  signal?: AbortSignal;
  onEvent?: (type: AgentDriverEventType, data: unknown) => void | Promise<void>;
  stderr?: (data: string) => void;
}

export type AgentDriverEventType =
  | "turn.started"
  | "assistant.message"
  | "tool.started"
  | "context.compacted"
  | "model.provider_retry"
  | "model.length_recovery"
  | "model.no_action_recovery";

export interface AgentDriverResult {
  subtype: string;
  isError: boolean;
  resultText: string;
  numTurns: number;
  aborted: boolean;
  abortReason?: string;
  stopReason?: string | null;
  errorMessage?: string;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly messages: Array<Record<string, unknown>>;
  prompt(text: string): void;
  abort(reason?: string): void;
  readonly done: Promise<AgentDriverResult>;
}

function textOfContent(content: unknown[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolUsesOfContent(content: unknown[]): Array<{ name: unknown }> {
  return content.filter((block) => Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "tool_use") as Array<{ name: unknown }>;
}

/**
 * Build the subprocess environment. options.env REPLACES the inherited
 * environment entirely, and empty strings do not neutralize inherited model
 * overrides — every ANTHROPIC_* variable must be a real value.
 */
export function buildAgentSubprocessEnv(input: { baseUrl: string; modelId: string; configDir: string; extra?: Record<string, string> | undefined }): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(input.extra ?? {}),
    ANTHROPIC_BASE_URL: input.baseUrl,
    // Placeholder credential: the loopback gateway strips client credentials
    // and injects the real upstream key, so this value never reaches a provider.
    ANTHROPIC_AUTH_TOKEN: "xuanshu-gateway-placeholder",
    ANTHROPIC_MODEL: input.modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.modelId,
    CLAUDE_CONFIG_DIR: input.configDir,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

/**
 * Create an agent session backed by the embedded Claude Code CLI. The session
 * drives the whole loop — model turns, in-process MCP tool calls, and scripted
 * recovery injections — over a streaming-input query. Translation events keep
 * the runtime's audit vocabulary (turn.started, assistant.message, tool.started,
 * model.* recovery, context.compacted).
 */
export function createAgentSession(options: AgentSessionOptions): AgentSession {
  const sessionId = options.sessionId ?? randomUUID();
  const abortController = new AbortController();
  let abortReason: string | undefined;
  let inputClosed = false;
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  const messages: Array<Record<string, unknown>> = [];
  let lengthRecoveryAttempts = 0;
  let noActionRecoveryAttempts = 0;
  let turnNumber = 0;
  let lastTurnMessageId: string | undefined;
  let turnHadToolUse = false;
  let turnRecoveryDone = false;
  let settledToolTurns = 0;
  let lastSettledToolMessageId: string | undefined;
  let lastResultFrame: Record<string, unknown> | undefined;

  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<SDKUserMessage>> {
        while (queue.length === 0 && !inputClosed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        const value = queue.shift();
        if (value !== undefined) return { value, done: false };
        return { value: undefined as never, done: true };
      },
    }),
  };
  const pushUser = (text: string): void => {
    if (inputClosed) return;
    queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    const notify = wake;
    wake = undefined;
    notify?.();
  };
  const endInput = (): void => {
    inputClosed = true;
    const notify = wake;
    wake = undefined;
    notify?.();
  };

  const done = (async (): Promise<AgentDriverResult> => {
    const configDir = await mkdtemp(join(tmpdir(), `xuanshu-agent-${sessionId.slice(0, 8)}-`));
    let active: Query | undefined;
    const finalize = async (): Promise<void> => {
      try {
        active?.close();
      } catch {
        // The generator may already be exhausted or aborted.
      }
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    };

    const onAbort = () => abortController.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const emit = async (type: AgentDriverEventType, data: unknown): Promise<void> => {
      await options.onEvent?.(type, data);
    };

    // Inject a continuation prompt for a turn that ended truncated (max_tokens)
    // or completely empty (end_turn with no text and no tool call). Returns
    // false once the per-turn/per-session attempt budget is exhausted, in which
    // case the run must fail rather than silently lose the turn.
    const recover = async (kind: "length" | "no_action", stopReason: string, hadVisibleText: boolean): Promise<boolean> => {
      if (turnRecoveryDone || turnHadToolUse) return false;
      if (!(options.shouldRecover?.() ?? true)) return false;
      if (kind === "length") {
        if (lengthRecoveryAttempts >= MAX_LENGTH_RECOVERY_ATTEMPTS || stopReason !== "max_tokens") return false;
        turnRecoveryDone = true;
        lengthRecoveryAttempts += 1;
        pushUser(LENGTH_RECOVERY_PROMPT);
        await emit("model.length_recovery", {
          attempt: lengthRecoveryAttempts,
          maximumAttempts: MAX_LENGTH_RECOVERY_ATTEMPTS,
          thinkingLevel: lengthRecoveryThinkingLevel(options.thinkingLevel),
        });
        return true;
      }
      if (noActionRecoveryAttempts >= MAX_NO_ACTION_RECOVERY_ATTEMPTS || stopReason !== "end_turn") return false;
      turnRecoveryDone = true;
      noActionRecoveryAttempts += 1;
      pushUser(NO_ACTION_RECOVERY_PROMPT);
      await emit("model.no_action_recovery", {
        attempt: noActionRecoveryAttempts,
        maximumAttempts: MAX_NO_ACTION_RECOVERY_ATTEMPTS,
        hadVisibleText,
      });
      return true;
    };

    const beginTurn = (messageId: string, content: unknown[]): boolean => {
      const isNewTurn = messageId !== lastTurnMessageId;
      if (isNewTurn) {
        lastTurnMessageId = messageId;
        turnNumber += 1;
        turnHadToolUse = false;
        turnRecoveryDone = false;
      }
      turnHadToolUse = turnHadToolUse || toolUsesOfContent(content).length > 0;
      return isNewTurn;
    };

    const handleAssistant = async (frame: { message: { id?: unknown; content?: unknown; stop_reason?: unknown } }): Promise<void> => {
      const beta = frame.message;
      const content = Array.isArray(beta.content) ? beta.content : [];
      const messageId = typeof beta.id === "string" ? beta.id : `msg_${turnNumber + 1}`;
      if (beginTurn(messageId, content)) await emit("turn.started", { turn: turnNumber });
      const transcriptEntry = messages.at(-1) as { id?: unknown; role?: unknown; content?: unknown[]; stop_reason?: unknown } | undefined;
      if (transcriptEntry && transcriptEntry.id === messageId && Array.isArray(transcriptEntry.content)) {
        transcriptEntry.content.push(...content);
        if (beta.stop_reason != null) transcriptEntry.stop_reason = beta.stop_reason;
      } else {
        messages.push({ ...beta, content: [...content] });
      }
      const toolUses = toolUsesOfContent(content);
      if (toolUses.length > 0 && (options.isSettled?.() ?? false) && messageId !== lastSettledToolMessageId) {
        lastSettledToolMessageId = messageId;
        settledToolTurns += 1;
        if (settledToolTurns >= MAX_SETTLED_TOOL_TURNS) {
          abortReason ??= "Agent kept issuing tool calls after the task was settled";
          abortController.abort(abortReason);
          return;
        }
      }
      for (const block of toolUses) await emit("tool.started", { toolName: block.name });
      if (beta.stop_reason != null) {
        const merged = messages.at(-1) as { content?: unknown[]; stop_reason?: unknown } | undefined;
        const mergedContent = Array.isArray(merged?.content) ? merged.content : content;
        await emit("assistant.message", merged ?? beta);
        if (beta.stop_reason === "max_tokens" || beta.stop_reason === "end_turn") {
          const kind = beta.stop_reason === "max_tokens" ? "length"
            : textOfContent(mergedContent).trim().length === 0 && toolUsesOfContent(mergedContent).length === 0 ? "no_action"
            : undefined;
          if (kind) await recover(kind, beta.stop_reason as string, textOfContent(mergedContent).trim().length > 0);
        }
      }
    };

    const handleResult = async (frame: Record<string, unknown>): Promise<void> => {
      lastResultFrame = frame;
      // The turn's authoritative stop_reason may only arrive on the result
      // frame (per-block assistant frames carry null) — recover from there too.
      const stopReason = typeof frame.stop_reason === "string" ? frame.stop_reason : null;
      if (stopReason && !turnRecoveryDone && !turnHadToolUse && (options.shouldRecover?.() ?? true)) {
        const merged = messages.at(-1) as { content?: unknown[] } | undefined;
        const mergedContent = Array.isArray(merged?.content) ? merged.content : [];
        const kind = stopReason === "max_tokens" ? "length"
          : stopReason === "end_turn" && textOfContent(mergedContent).trim().length === 0 && toolUsesOfContent(mergedContent).length === 0 ? "no_action"
          : undefined;
        if (kind) await recover(kind, stopReason, textOfContent(mergedContent).trim().length > 0);
      }
      // Close the input stream only when nothing more can be pushed for this
      // turn. The queue length is unreliable here: the SDK's streamInput loop
      // drains it independently, so an empty queue may just mean the recovery
      // prompt was already written to the CLI. turnRecoveryDone is the
      // authoritative "a continuation is in flight" signal.
      if (!turnRecoveryDone) endInput();
    };

    const abortedResult = (): AgentDriverResult => ({
      subtype: "aborted",
      isError: false,
      resultText: "",
      numTurns: turnNumber,
      aborted: true,
      ...(abortReason !== undefined ? { abortReason } : {}),
    });

    try {
      active = query({
        prompt: input,
        options: {
          settingSources: [],
          permissionMode: "dontAsk",
          tools: [],
          allowedTools: ["mcp__xuanshu__*"],
          mcpServers: { xuanshu: options.mcpServer },
          systemPrompt: options.systemPrompt,
          model: options.modelId,
          thinking: sdkThinkingConfig(options.thinkingLevel),
          includePartialMessages: true,
          persistSession: false,
          abortController,
          env: buildAgentSubprocessEnv({
            baseUrl: options.baseUrl,
            modelId: options.modelId,
            configDir,
            extra: options.sdk?.env,
          }),
          ...(options.sdk?.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.sdk.pathToClaudeCodeExecutable } : {}),
          ...(options.resumeSessionId ? { resume: options.resumeSessionId } : { sessionId }),
          ...(options.stderr ? { stderr: options.stderr } : {}),
        } satisfies Options,
      });
      for await (const message of active) {
        const frame = message as unknown as Record<string, unknown>;
        if (frame.type === "assistant") {
          await handleAssistant(frame as { message: { id?: unknown; content?: unknown; stop_reason?: unknown } });
          if (abortController.signal.aborted) break;
        } else if (frame.type === "user") {
          const inner = (frame as { message?: unknown }).message;
          if (inner && typeof inner === "object") messages.push(inner as Record<string, unknown>);
        } else if (frame.type === "system") {
          const subtype = frame.subtype;
          if (subtype === "compact_boundary") {
            const metadata = (frame.compact_metadata ?? {}) as Record<string, unknown>;
            await emit("context.compacted", {
              trigger: metadata.trigger,
              preTokens: metadata.pre_tokens,
              ...(metadata.post_tokens !== undefined ? { postTokens: metadata.post_tokens } : {}),
            });
          } else if (subtype === "api_retry") {
            await emit("model.provider_retry", {
              attempt: frame.attempt,
              maxRetries: frame.max_retries,
              retryDelayMs: frame.retry_delay_ms,
              errorStatus: frame.error_status,
              error: (frame.error as { message?: unknown } | undefined)?.message,
            });
          }
        } else if (frame.type === "result") {
          await handleResult(frame);
        }
      }
      if (abortController.signal.aborted) return abortedResult();
      const resultFrame = lastResultFrame;
      return {
        subtype: typeof resultFrame?.subtype === "string" ? resultFrame.subtype : "success",
        isError: Boolean(resultFrame?.is_error),
        resultText: typeof resultFrame?.result === "string" ? resultFrame.result : "",
        numTurns: turnNumber,
        aborted: false,
        ...(resultFrame?.stop_reason !== undefined ? { stopReason: resultFrame.stop_reason as string | null } : {}),
      };
    } catch (error) {
      if (abortController.signal.aborted) return abortedResult();
      return {
        subtype: "error_during_execution",
        isError: true,
        resultText: "",
        numTurns: turnNumber,
        aborted: false,
        errorMessage: String(error instanceof Error ? error.message : error).slice(0, 600),
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      endInput();
      await finalize();
    }
  })();

  return {
    sessionId,
    messages,
    prompt: pushUser,
    abort(reason?: string): void {
      if (reason !== undefined) abortReason = reason;
      abortController.abort(reason);
    },
    done,
  };
}

/**
 * Single-shot SDK query for the writeup generator: string prompt, one turn,
 * no MCP servers, no recovery machinery — just the final result text.
 */
export async function runSdkSingleShot(input: {
  prompt: string;
  systemPrompt: string;
  modelId: string;
  baseUrl: string;
  thinkingLevel: AgentThinkingLevel;
  sdk?: AgentSdkOverride;
  signal?: AbortSignal;
  maxTurns?: number;
  stderr?: (data: string) => void;
}): Promise<{ subtype: string; isError: boolean; resultText: string; errorMessage?: string }> {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const configDir = await mkdtemp(join(tmpdir(), `xuanshu-single-${randomUUID().slice(0, 8)}-`));
  try {
    const q = query({
      prompt: input.prompt,
      options: {
        settingSources: [],
        permissionMode: "dontAsk",
        tools: [],
        maxTurns: input.maxTurns ?? 1,
        systemPrompt: input.systemPrompt,
        model: input.modelId,
        thinking: sdkThinkingConfig(input.thinkingLevel),
        persistSession: false,
        abortController,
        env: buildAgentSubprocessEnv({ baseUrl: input.baseUrl, modelId: input.modelId, configDir, extra: input.sdk?.env }),
        ...(input.sdk?.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: input.sdk.pathToClaudeCodeExecutable } : {}),
        ...(input.stderr ? { stderr: input.stderr } : {}),
      } satisfies Options,
    });
    let lastResult: Record<string, unknown> | undefined;
    for await (const message of q) {
      const frame = message as unknown as Record<string, unknown>;
      if (frame.type === "result") lastResult = frame;
    }
    q.close();
    return {
      subtype: typeof lastResult?.subtype === "string" ? lastResult.subtype : "success",
      isError: Boolean(lastResult?.is_error),
      resultText: typeof lastResult?.result === "string" ? lastResult.result : "",
      ...(Array.isArray(lastResult?.errors) && lastResult.errors.length > 0
        ? { errorMessage: String((lastResult.errors as unknown[])[0]).slice(0, 600) }
        : {}),
    };
  } catch (error) {
    return {
      subtype: "error_during_execution",
      isError: true,
      resultText: "",
      errorMessage: String(error instanceof Error ? error.message : error).slice(0, 600),
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import { z } from "zod";
import type { AuditChain } from "./audit.js";
import { RunObserver } from "./observer.js";
import type { PermissionGate } from "./permissions.js";
import type { PolicyEngine } from "./policy.js";
import { sanitizeSecrets } from "./sanitize.js";
import { validateSubmission } from "./submission-policy.js";
import type { ToolDescriptor } from "./tool-catalog.js";
import type { RunState, RuntimeConfig, ToolContent, ToolResult, ToolShape } from "./types.js";
import type { WebReasoningController } from "./web-reasoning/controller.js";

export const XUANSHU_MCP_SERVER_NAME = "xuanshu";

// Control tools excluded from observation capture, failure classification, and
// strategy-revision escalation (mirrors the legacy agent-loop lists).
const OBSERVATION_EXCLUDED_TOOLS = new Set(["submit_plan", "checkpoint", "record_finding", "record_lesson", "finish_task", "read_shared_evidence", "publish_shared_evidence"]);
const FAILURE_EXCLUDED_TOOLS = new Set(["submit_plan", "checkpoint", "record_finding", "record_lesson", "finish_task"]);
const REVISION_EXCLUDED_TOOLS = new Set(["submit_plan", "checkpoint", "record_finding", "record_lesson", "finish_task"]);

interface SchemaNode {
  [key: string]: unknown;
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return Boolean(value) && typeof value === "object";
}

function numericOption(node: SchemaNode, name: string): number | undefined {
  const value = node[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function convertSchema(schema: TSchema): z.ZodType {
  const node = schema as unknown as SchemaNode;
  if (Array.isArray(node.anyOf)) {
    const variants = node.anyOf.map((variant) => convertSchema(variant as TSchema));
    if (variants.length === 0) throw new Error("Unsupported typebox schema: empty union");
    return variants.length === 1 ? variants[0]! : z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  if ("const" in node) {
    const literal = node.const;
    if (literal !== null && !["string", "number", "bigint", "boolean"].includes(typeof literal)) {
      throw new Error("Unsupported typebox schema: non-primitive literal");
    }
    return z.literal(literal as string | number | bigint | boolean | null);
  }
  if (isSchemaNode(node.patternProperties)) {
    const valueSchemas = Object.values(node.patternProperties);
    if (valueSchemas.length === 0) throw new Error("Unsupported typebox schema: record without a value schema");
    const valueSchema = valueSchemas.length === 1
      ? (valueSchemas[0] as TSchema)
      : ({ anyOf: valueSchemas } as unknown as TSchema);
    // Not z.record: the Agent SDK's zod→JSON-Schema conversion cannot walk
    // foreign ZodRecord instances (its tools/list handler crashes). A catchall
    // object validates the same arbitrary string→value map and converts cleanly.
    return z.object({}).catchall(convertSchema(valueSchema));
  }
  switch (node.type) {
    case "string": {
      let shape = z.string();
      const minLength = numericOption(node, "minLength");
      const maxLength = numericOption(node, "maxLength");
      if (minLength !== undefined) shape = shape.min(minLength);
      if (maxLength !== undefined) shape = shape.max(maxLength);
      return shape;
    }
    case "integer":
    case "number": {
      let shape = node.type === "integer" ? z.number().int() : z.number();
      const minimum = numericOption(node, "minimum");
      const maximum = numericOption(node, "maximum");
      if (minimum !== undefined) shape = shape.min(minimum);
      if (maximum !== undefined) shape = shape.max(maximum);
      return shape;
    }
    case "boolean":
      return z.boolean();
    case "array": {
      if (!isSchemaNode(node.items)) throw new Error("Unsupported typebox schema: array without items");
      let shape = z.array(convertSchema(node.items as TSchema));
      const minItems = numericOption(node, "minItems");
      const maxItems = numericOption(node, "maxItems");
      if (minItems !== undefined) shape = shape.min(minItems);
      if (maxItems !== undefined) shape = shape.max(maxItems);
      return shape;
    }
    case "object":
      return z.object(convertProperties(node));
    default:
      break;
  }
  if (Object.keys(node).length === 0) return z.unknown();
  throw new Error(`Unsupported typebox schema shape: ${JSON.stringify(node).slice(0, 120)}`);
}

function convertProperties(node: SchemaNode): z.ZodRawShape {
  const properties = isSchemaNode(node.properties) ? node.properties : {};
  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(properties)) {
    let field = convertSchema(property as TSchema);
    // No .default() wrapping: the Agent SDK bundles its own zod build whose
    // object parser only accepts absent keys for _zod.optin === "optional",
    // while our zod 4.6 reports "defaulted" for ZodDefault — absent defaulted
    // fields would be rejected with "expected nonoptional" before our own
    // validation runs. Defaults are applied post-parse instead
    // (toolParameterDefaults + wrapXuanShuTools).
    if (!required.has(name)) {
      field = field.optional();
    }
    shape[name] = field;
  }
  return shape;
}

/**
 * Convert a typebox tool-parameter schema (plain JSON Schema) into the zod raw
 * shape the Agent SDK's in-process MCP server expects. The shape sticks to
 * constructs the SDK's bundled zod build understands across copies (no
 * ZodDefault, no ZodRecord); covers the closed construction set used by
 * tools.ts and throws loudly on anything else, so a new schema construct
 * surfaces here instead of silently weakening validation.
 */
export function toolParametersToZodShape(schema: TSchema): z.ZodRawShape {
  const node = schema as unknown as SchemaNode;
  if (!isSchemaNode(node) || node.type !== "object") {
    throw new Error("Tool parameters must be a typebox Type.Object schema");
  }
  return convertProperties(node);
}

/**
 * Top-level typebox property defaults for one tool-parameter schema. The
 * SDK-facing shape cannot carry them (see convertProperties), so the tool
 * wrapper applies them after its own stricter zod parse.
 */
export function toolParameterDefaults(schema: TSchema): Record<string, unknown> {
  const node = schema as unknown as SchemaNode;
  const properties = isSchemaNode(node) && isSchemaNode(node.properties) ? node.properties : {};
  const defaults: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (isSchemaNode(property) && "default" in property) defaults[name] = property.default;
  }
  return defaults;
}

function publicToolContent(content: ToolContent[]): unknown[] {
  return content.flatMap((block): unknown[] => {
    if (block.type !== "image") return [block];
    const approximateBytes = Math.floor((block.data.length * 3) / 4);
    return [{
      type: "text",
      text: `[image omitted from persisted artifacts: ${block.mimeType}, approximately ${approximateBytes} bytes]`,
    }];
  });
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolCallBlock {
  block: true;
  reason: string;
}

export type EmitFn = (type: string, data: unknown) => void | Promise<void>;

export interface ToolCallPipelineDeps {
  state: RunState;
  runtime: RuntimeConfig;
  audit: AuditChain;
  policy: PolicyEngine;
  descriptors: Map<string, ToolDescriptor>;
  webReasoning: WebReasoningController;
  permissionGate?: PermissionGate;
  submissionPolicy: "strict" | "advisory";
  allowedToolNames: string[];
  emit: EmitFn;
  persistState: (state: RunState) => Promise<void>;
  webReasoningPersistState?: boolean;
  signal?: AbortSignal;
  /** Mid-session user-message injection for observer escalations (no-op until the agent session exists). */
  escalate?: (text: string) => void;
}

/**
 * Observer anomalies are record-only by design, but a run grinding the SAME
 * call or drifting without checkpoints (9445, 9475: 14 identical run_command
 * invocations over 24 minutes, checkpoint gaps of 12-13) never sees its own
 * loop from inside. Crossing a threshold escalates into the conversation as
 * an advisory user message — and because a single advisory failed to break
 * 9837's loop (identical run_command x1280 long after the tier-1 nudge),
 * escalation re-fires at higher occurrence tiers with progressively harder
 * directives instead of firing once per kind.
 */
export const OBSERVER_ESCALATION_THRESHOLDS: Readonly<Record<string, number>> = {
  repeated_action: 5,
  checkpoint_gap: 12,
};

export interface ObserverAnomalySummary {
  kind: string;
  detail: string;
  occurrences: number;
}

/** Tier for an anomaly kind at its current occurrence count (0 = none). */
export function observerEscalationTier(kind: string, occurrences: number): number {
  const threshold = OBSERVER_ESCALATION_THRESHOLDS[kind];
  if (threshold === undefined) return 0;
  if (occurrences >= threshold * 16) return 3;
  if (occurrences >= threshold * 4) return 2;
  if (occurrences >= threshold) return 1;
  return 0;
}

/** Anomalies that should escalate now, at a tier higher than last escalated. */
export function observerEscalations(
  anomalies: readonly ObserverAnomalySummary[],
  escalatedTiers: ReadonlyMap<string, number>,
): Array<{ kind: string; tier: number; text: string }> {
  const advisories: Array<{ kind: string; tier: number; text: string }> = [];
  for (const anomaly of anomalies) {
    const tier = observerEscalationTier(anomaly.kind, anomaly.occurrences);
    if (tier === 0 || tier <= (escalatedTiers.get(anomaly.kind) ?? 0)) continue;
    const text: string = anomaly.kind === "repeated_action"
      ? (tier === 1
        ? `Observer escalation: you have now repeated the same call pattern ${anomaly.occurrences} times (${anomaly.detail}). An identical invocation will keep returning an identical result. Stop the loop: checkpoint what these attempts have ruled out, then change the approach — a different tool, a different hypothesis, or revisit an earlier assumption you have not re-examined.`
        : tier === 2
          ? `Observer escalation (tier 2): the same call pattern has now repeated ${anomaly.occurrences} times DESPITE the earlier advisory — this approach is exhausted. Identical invocations return identical results. Stop it entirely: write the ruled-out set to a scratch file, then switch to a structurally different method (a different tool, a different technique, or step back and re-examine a core assumption).`
          : `Observer escalation (final): the degenerate loop has persisted through two advisories (${anomaly.occurrences} identical calls). Abandon this approach: record the negative result and either pivot to a genuinely different technique or end the run as blocked with the evidence — further identical calls are the worst possible use of the remaining budget.`)
      : (tier === 1
        ? `Observer escalation: ${anomaly.occurrences} actions have elapsed without a decision checkpoint. Persist a checkpoint now summarizing confirmed facts, ruled-out hypotheses, and the single next concrete step so the remaining budget stays recoverable.`
        : tier === 2
          ? `Observer escalation (tier 2): ${anomaly.occurrences} actions have now elapsed without a checkpoint despite the earlier advisory — the session is drifting. Persist a full checkpoint immediately (confirmed facts, ruled-out hypotheses, next concrete step), then execute that single next step before anything else.`
          : `Observer escalation (final): ${anomaly.occurrences} actions without a decision checkpoint. Persist a complete checkpoint NOW, then either execute its single next step or end the run as blocked — an uncheckable session cannot recover its own budget.`);
    advisories.push({ kind: anomaly.kind, tier, text });
  }
  return advisories;
}

export interface ToolCallPipeline {
  beforeToolCall(toolCall: ToolCallRecord): Promise<ToolCallBlock | undefined>;
  afterToolCall(toolCall: ToolCallRecord, result: { content: ToolContent[]; details?: unknown }, isError: boolean): Promise<void>;
  isSettled(): boolean;
  markSettled(): void;
}

/**
 * The pre/post tool-call gate pipeline, moved verbatim from the legacy agent
 * loop: audit tool.requested, the strict finish_task submission gate, web
 * action guard and dedupe, PolicyEngine pre-execution gating, risk-based
 * operator approval, then post-execution audit, observation capture, failure
 * classification, state persistence, and web-reasoning bookkeeping.
 */
export function createToolCallPipeline(deps: ToolCallPipelineDeps): ToolCallPipeline {
  const { state, audit, policy, descriptors, webReasoning, emit } = deps;
  const toolRequestSequences = new Map<string, number>();
  const observedToolOutputs: Array<{ toolCallId: string; output: string; args: string }> = [];
  // Frozen at the FIRST finish_task attempt: near-duplicate conflict scanning
  // must not see outputs produced after it, or the disambiguation experiments
  // the gate itself demands regenerate new near-miss readings and the block
  // can never be addressed (OCR-converged solves hit 7 consecutive rejections).
  let conflictScanPrefix: readonly string[] | null = null;
  const observer = new RunObserver(state, deps.runtime);
  const escalatedTiers = new Map<string, number>();
  // Categorical force gate (tier-3 checkpoint_gap): 16x advisories have proven
  // ignorable (10100: 53 minutes across two runs, zero findings persisted, the
  // final advisory read and skipped). Blocking every non-persisting call until
  // a checkpoint or finding lands converts the last advisory from advice into
  // protocol — one forced checkpoint turn is the cost, an empty handoff at
  // budget death is the alternative.
  let checkpointForceArmed = false;
  const CHECKPOINT_SATISFYING = new Set(["checkpoint", "record_finding"]);
  const FORCE_GATE_ALWAYS_ALLOWED = new Set(["finish_task", "submit_plan", "update_plan_steps", "record_lesson", "read_shared_evidence"]);
  // Zero-persistence arm: the 1x/4x/16x escalation ladder needs ~192 actions
  // to reach the tier-3 gate, and bounded 40-minute runs die long before that
  // (10515: four checkpoint_gap advisories, tier-2 ceiling, empty handoff at
  // budget death). A run deep enough to have made 60 successful tool calls
  // without persisting a single checkpoint or finding is one budget stop away
  // from a zero-value handoff, so arm the same gate on depth alone. Warm
  // continuations that inherit findings or a checkpoint count as persisted.
  let persistingActionSeen = false;
  const persistenceSeen = () => persistingActionSeen || state.findings.length > 0 || state.lastCheckpoint !== undefined;
  let successfulToolCalls = 0;
  const ZERO_PERSISTENCE_FORCE_AT = 60;
  let settled = false;

  return {
    async beforeToolCall(toolCall): Promise<ToolCallBlock | undefined> {
      const requested = await audit.append("tool.requested", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: sanitizeSecrets(toolCall.args),
        description: descriptors.get(toolCall.toolName)?.sideEffects.join("; ") || "Agent requested a bounded tool action",
      }, { source: "model", actor: "primary-agent", correlationId: toolCall.toolCallId });
      toolRequestSequences.set(toolCall.toolCallId, requested.sequence);
      if (settled) {
        return { block: true, reason: "The task has already been settled; provide the final answer without further tool calls." };
      }
      if (checkpointForceArmed && !CHECKPOINT_SATISFYING.has(toolCall.toolName) && !FORCE_GATE_ALWAYS_ALLOWED.has(toolCall.toolName)) {
        await audit.append("observer.force_gate", { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName }, { source: "orchestrator", actor: "run-observer", correlationId: toolCall.toolCallId });
        return { block: true, reason: "Checkpoint force gate: this session crossed the FINAL no-checkpoint escalation. Call checkpoint() or record_finding() NOW to persist confirmed facts, ruled-out hypotheses, and the single next concrete step. Every other tool stays blocked until something is persisted; finish_task also remains available if the right move is ending the run as blocked." };
      }
      if (CHECKPOINT_SATISFYING.has(toolCall.toolName)) {
        checkpointForceArmed = false;
        persistingActionSeen = true;
      }
      if (toolCall.toolName === "finish_task" && deps.submissionPolicy === "strict") {
        const input = toolCall.args && typeof toolCall.args === "object" ? toolCall.args as Record<string, unknown> : {};
        const verification = Array.isArray(input.verification)
          ? input.verification.filter((item): item is string => typeof item === "string")
          : [];
        const candidate = typeof input.submission === "string" ? input.submission.trim() : "";
        const candidateOutputs = candidate
          ? observedToolOutputs.filter((item) => item.output.includes(candidate)).map((item) => item.output)
          : [];
        const groundingCalls = candidate
          ? observedToolOutputs.filter((item) => item.output.includes(candidate))
          : [];
        if (conflictScanPrefix === null) conflictScanPrefix = observedToolOutputs.map((item) => item.output);
        const validation = validateSubmission({
          policy: deps.submissionPolicy,
          status: input.status === "completed" ? "completed" : "blocked",
          ...(typeof input.submission === "string" ? { candidate: input.submission } : {}),
          observedOutputs: observedToolOutputs.map((item) => item.output),
          conflictScanOutputs: conflictScanPrefix,
          independentObservedOutputs: candidateOutputs.slice(1),
          verification,
          independentlyVerified: input.independentlyVerified === true,
          groundingToolCallIds: groundingCalls.map((item) => item.toolCallId),
          groundingCallArgs: groundingCalls.map((item) => item.args),
        });
        state.submissionValidation = validation;
        await audit.append("submission.validation", validation, { source: "system", actor: "submission-gate", correlationId: toolCall.toolCallId, parentSequence: requested.sequence });
        await emit("submission.validation", { status: validation.status, reason: validation.reason });
        if (validation.status !== "accepted") return { block: true, reason: `Submission gate: ${validation.reason}` };
      }
      const guard = webReasoning.guardToolCall(toolCall.toolName, toolCall.args, deps.allowedToolNames);
      if (!guard.allowed) {
        await audit.append("WEB_ACTION_GUARD_REJECTED", { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, decision: guard.decision, reason: guard.reason }, { source: "policy", actor: "web-action-guard", correlationId: toolCall.toolCallId, parentSequence: requested.sequence });
        await emit("WEB_ACTION_GUARD_REJECTED", { toolName: toolCall.toolName, decision: guard.decision, reason: guard.reason });
        return { block: true, reason: guard.reason };
      }
      const webAction = webReasoning.prepareToolCall(toolCall.toolName, toolCall.args, toolCall.toolCallId);
      if (webAction.duplicate) {
        await audit.append("WEB_ACTION_SKIPPED_DUPLICATE", { actionId: webAction.actionId, toolName: toolCall.toolName }, { source: "policy", actor: "web-action-deduplicator", correlationId: toolCall.toolCallId, parentSequence: requested.sequence });
        return { block: true, reason: "Duplicate Web action skipped; use new evidence or change strategy." };
      }
      const decision = policy.evaluate(toolCall.toolName, toolCall.args, state);
      await audit.append("policy.decision", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: sanitizeSecrets(toolCall.args),
        allowed: decision.allowed,
        reason: decision.reason,
        signature: decision.signature,
      }, { source: "policy", actor: "policy-engine", correlationId: toolCall.toolCallId, parentSequence: requested.sequence });
      await emit("policy.decision", { toolName: toolCall.toolName, allowed: decision.allowed, reason: decision.reason });
      if (!decision.allowed) {
        webReasoning.markPolicyRejected(toolCall.toolCallId, decision.reason);
        if (state.plan && !REVISION_EXCLUDED_TOOLS.has(toolCall.toolName)) {
          state.strategyRevisionRequired = true;
          state.lastFailure = {
            classification: "policy",
            toolName: toolCall.toolName,
            reason: decision.reason,
            createdAt: new Date().toISOString(),
          };
        }
        return { block: true, reason: decision.reason };
      }
      const descriptor = descriptors.get(toolCall.toolName);
      const risk = descriptor?.riskEvaluator(toolCall.args);
      if (risk && deps.permissionGate) {
        await audit.append("permission.request", {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          risk,
          args: sanitizeSecrets(toolCall.args),
        }, { source: "policy", actor: "permission-broker", correlationId: toolCall.toolCallId, parentSequence: requested.sequence });
        const resolution = await deps.permissionGate.authorize({ sessionId: state.id, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, args: sanitizeSecrets(toolCall.args), risk }, deps.signal);
        await audit.append("permission.resolved", {
          requestId: resolution.request.id,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          decision: resolution.decision,
          source: resolution.source,
        }, { source: "operator", actor: resolution.source, correlationId: toolCall.toolCallId, parentSequence: requested.sequence });
        if (resolution.decision === "deny") return { block: true, reason: `Tool permission denied (${resolution.source})` };
      }
      policy.recordAllowed(toolCall.toolName, decision, state);
      state.updatedAt = new Date().toISOString();
      return undefined;
    },

    async afterToolCall(toolCall, result, isError): Promise<void> {
      const persistedContent = sanitizeSecrets(publicToolContent(result.content));
      const persistedDetails = sanitizeSecrets(result.details);
      await audit.append("tool.result", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: sanitizeSecrets(toolCall.args),
        isError,
        content: persistedContent,
        details: persistedDetails,
      }, {
        source: "tool",
        actor: toolCall.toolName,
        correlationId: toolCall.toolCallId,
        ...(toolRequestSequences.get(toolCall.toolCallId) !== undefined ? { parentSequence: toolRequestSequences.get(toolCall.toolCallId)! } : {}),
      });
      // Record-only bypass observation: anomalies are noted, never gated —
      // but high-occurrence anomalies escalate once per kind into the chat.
      const anomalies = observer.observe({ toolName: toolCall.toolName, args: toolCall.args, isError });
      for (const anomaly of anomalies) {
        await audit.append("observer.anomaly", anomaly, { source: "orchestrator", actor: "run-observer", correlationId: toolCall.toolCallId });
        await emit("observer.anomaly", { kind: anomaly.kind, detail: anomaly.detail, occurrences: anomaly.occurrences });
      }
      for (const escalation of observerEscalations(anomalies, escalatedTiers)) {
        escalatedTiers.set(escalation.kind, escalation.tier);
        await audit.append("observer.escalated", { kind: escalation.kind, injected: true, text: escalation.text }, { source: "orchestrator", actor: "run-observer", correlationId: toolCall.toolCallId });
        await emit("observer.escalated", { kind: escalation.kind, injected: true });
        deps.escalate?.(escalation.text);
        if (escalation.kind === "checkpoint_gap" && escalation.tier >= 3 && !checkpointForceArmed) {
          checkpointForceArmed = true;
          await audit.append("observer.force_gate.armed", { kind: escalation.kind, occurrences: anomalies.find((a) => a.kind === "checkpoint_gap")?.occurrences }, { source: "orchestrator", actor: "run-observer", correlationId: toolCall.toolCallId });
        }
      }
      if (!isError) successfulToolCalls += 1;
      if (!checkpointForceArmed && !persistenceSeen() && successfulToolCalls >= ZERO_PERSISTENCE_FORCE_AT) {
        checkpointForceArmed = true;
        const text = `Observer escalation (zero-persistence): ${successfulToolCalls} tool calls into this run and nothing is persisted — no checkpoint, no finding. If the budget ends now, everything derived so far dies with it. The next tool call stays blocked until you persist: call checkpoint() or record_finding() NOW with confirmed facts, ruled-out hypotheses, and the single next concrete step; finish_task remains available if ending the run as blocked is the right move.`;
        await audit.append("observer.escalated", { kind: "zero_persistence", injected: true, text }, { source: "orchestrator", actor: "run-observer", correlationId: toolCall.toolCallId });
        await emit("observer.escalated", { kind: "zero_persistence", injected: true });
        deps.escalate?.(text);
        await audit.append("observer.force_gate.armed", { kind: "zero_persistence", occurrences: successfulToolCalls }, { source: "orchestrator", actor: "run-observer", correlationId: toolCall.toolCallId });
      }
      if (!isError && !OBSERVATION_EXCLUDED_TOOLS.has(toolCall.toolName)) {
        const observation = JSON.stringify({ content: persistedContent, details: persistedDetails });
        if (observation) {
          observedToolOutputs.push({ toolCallId: toolCall.toolCallId, output: observation.slice(0, 12_000), args: JSON.stringify(toolCall.args ?? {}).slice(0, 12_000) });
          if (observedToolOutputs.length > 32) observedToolOutputs.shift();
        }
        // observedToolOutputs dies with the pipeline; the settle-time handoff
        // renders only persisted state. Mirror a bounded text digest onto the
        // run state so an aborted run's frontier survives without the model
        // ever calling checkpoint (9841: 52 min of work, empty handoff).
        const texts = (persistedContent as ToolContent[]).flatMap((block) => (block.type === "text" ? [block.text] : []));
        const summary = texts.join(" | ").replace(/\s+/g, " ").trim().slice(0, 400);
        if (summary) {
          state.evidenceTail = [...(state.evidenceTail ?? []), { tool: toolCall.toolName, summary }].slice(-8);
        }
      }
      if (isError && !FAILURE_EXCLUDED_TOOLS.has(toolCall.toolName)) {
        state.strategyRevisionRequired = true;
        state.lastFailure = {
          classification: "tool",
          toolName: toolCall.toolName,
          reason: "Tool execution returned an error",
          createdAt: new Date().toISOString(),
        };
      }
      await deps.persistState(state);
      await webReasoning.afterToolResult({ toolName: toolCall.toolName, toolCallId: toolCall.toolCallId, args: toolCall.args, result: { content: result.content, details: result.details }, isError });
      if (webReasoning.enabled && deps.webReasoningPersistState !== false) await deps.persistState(state);
      await emit("tool.result", { toolName: toolCall.toolName, isError });
    },

    isSettled: () => settled,
    markSettled: () => {
      settled = true;
    },
  };
}

export interface XuanShuToolAdapterOptions {
  tools: ToolShape[];
  pipeline: ToolCallPipeline;
  signal?: AbortSignal;
}

export interface XuanShuTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  invoke(args: unknown, toolUseId?: string, callSignal?: AbortSignal): Promise<CallToolResult>;
}

function toolErrorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function readToolUseId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const meta = (extra as { _meta?: Record<string, unknown> })._meta;
  const id = meta?.["claudecode/toolUseId"];
  return typeof id === "string" && id ? id : undefined;
}

function readSignal(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function combineSignals(primary: AbortSignal | undefined, secondary: AbortSignal | undefined): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return AbortSignal.any([primary, secondary]);
}

/**
 * Wrap the tool set for MCP exposure: zod validation, the gate pipeline, a
 * per-run serialization queue (the CLI may issue parallel tool_use blocks),
 * and finish_task settlement. `details` stays audit/UI-only and never reaches
 * the model — only content blocks are returned.
 */
export function wrapXuanShuTools(options: XuanShuToolAdapterOptions): XuanShuTool[] {
  const { pipeline, signal } = options;
  let queueTail: Promise<unknown> = Promise.resolve();
  let syntheticCallCounter = 0;
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queueTail.then(task, task);
    queueTail = result.then(() => undefined, () => undefined);
    return result;
  };

  return options.tools.map((source) => {
    const inputSchema = toolParametersToZodShape(source.parameters);
    const defaults = toolParameterDefaults(source.parameters);
    const validator = z.object(inputSchema);
    const processCall = async (args: unknown, toolUseId: string, callSignal?: AbortSignal): Promise<CallToolResult> => {
      const parsed = validator.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return toolErrorResult(`Invalid tool arguments: ${issue ? `${issue.path.join(".") || "arguments"} ${issue.message}` : "failed schema validation"}`);
      }
      // Typebox defaults live outside the SDK-facing shape (see
      // convertProperties); merge them here so tools and the audit trail see
      // the same resolved arguments the schema used to promise.
      const record: ToolCallRecord = { toolCallId: toolUseId, toolName: source.name, args: { ...defaults, ...parsed.data } };
      const before = await pipeline.beforeToolCall(record);
      if (before?.block) return toolErrorResult(before.reason);
      try {
        const result: ToolResult = await source.execute(toolUseId, record.args, combineSignals(signal, callSignal));
        if (result.terminate === true) pipeline.markSettled();
        await pipeline.afterToolCall(record, { content: result.content, details: result.details }, false);
        return { content: result.content as CallToolResult["content"] };
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 600);
        const failureText = `Tool execution failed: ${message}`;
        const content: ToolContent[] = [{ type: "text", text: failureText }];
        await pipeline.afterToolCall(record, { content }, true);
        return toolErrorResult(failureText);
      }
    };
    return {
      name: source.name,
      description: source.description,
      inputSchema,
      invoke: (args: unknown, toolUseId?: string, callSignal?: AbortSignal) =>
        enqueue(() => processCall(args, toolUseId ?? `xuanshu-call-${(syntheticCallCounter += 1)}`, callSignal)),
    };
  });
}

export interface XuanShuMcpServerOptions extends XuanShuToolAdapterOptions {
  /** Per-call MCP timeout; long-running sandbox commands need a generous value. */
  timeoutMs?: number;
}

/**
 * Build the in-process MCP server the Agent SDK CLI loads as "xuanshu". The
 * model sees these tools as mcp__xuanshu__<name>. alwaysLoad keeps every tool
 * in the request prompt instead of behind tool-search deferral.
 */
export function createXuanShuMcpServer(options: XuanShuMcpServerOptions): McpSdkServerConfigWithInstance {
  const tools = wrapXuanShuTools(options);
  return createSdkMcpServer({
    name: XUANSHU_MCP_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    tools: tools.map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      handler: (args: unknown, extra: unknown) => entry.invoke(args, readToolUseId(extra), readSignal(extra)),
    })),
  });
}

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import { sanitizeSecrets } from "./sanitize.js";

export type TrajectorySource = "operator" | "orchestrator" | "model" | "context" | "policy" | "tool" | "agent" | "system";

export interface AuditEventMetadata {
  source?: TrajectorySource;
  actor?: string;
  correlationId?: string;
  parentSequence?: number;
}

const MAX_STRING_CHARS = 16_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;
const MAX_CONTEXT_MESSAGES = 120;

export function inferTrajectorySource(type: string): TrajectorySource {
  if (/^(operator|review)\./i.test(type)) return "operator";
  if (/^(assistant|model)\./i.test(type)) return "model";
  if (/^(context|memory|experience)\./i.test(type)) return "context";
  if (/^(policy|permission|approval)\./i.test(type) || /GUARD_REJECTED/i.test(type)) return "policy";
  if (/^(tool|browser|image|command|artifact)\./i.test(type) || /ACTION_(COMPLETED|FAILED)/i.test(type)) return "tool";
  if (/^(agent|workflow|subagent)\./i.test(type)) return "agent";
  if (/^(run|turn|session)\./i.test(type)) return "orchestrator";
  return "system";
}

function truncateString(value: string): string {
  return value.length <= MAX_STRING_CHARS ? value : `${value.slice(0, MAX_STRING_CHARS)}\n[truncated]`;
}

function boundValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncateString(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested data omitted]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items omitted]`);
    return items;
  }
  const entries = Object.entries(value);
  const bounded = entries.slice(0, MAX_OBJECT_KEYS).map(([key, item]) => [key, boundValue(item, depth + 1)] as const);
  if (entries.length > MAX_OBJECT_KEYS) bounded.push(["_omittedKeys", entries.length - MAX_OBJECT_KEYS]);
  return Object.fromEntries(bounded);
}

export function boundedPublicValue(value: unknown): unknown {
  return boundValue(sanitizeSecrets(value), 0);
}

export function publicMessageForArtifacts(message: unknown): unknown {
  if (!message || typeof message !== "object" || !("role" in message)) return boundedPublicValue(message);
  const value = message as { role: string; content?: unknown; [key: string]: unknown };
  if (!Array.isArray(value.content)) return boundedPublicValue(value);
  let hiddenReasoningOmitted = 0;
  let imagesOmitted = 0;
  const content = value.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [block];
    const item = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (item.type === "thinking") {
      hiddenReasoningOmitted += 1;
      return [];
    }
    if (item.type !== "image") return [block];
    imagesOmitted += 1;
    const encodedLength = typeof item.data === "string" ? item.data.length : 0;
    const approximateBytes = Math.floor((encodedLength * 3) / 4);
    return [{
      type: "text",
      text: `[image omitted from persisted artifacts: ${String(item.mimeType ?? "unknown")}, approximately ${approximateBytes} bytes]`,
    }];
  });
  return boundedPublicValue({
    ...value,
    content,
    ...(hiddenReasoningOmitted ? { hiddenReasoningOmitted } : {}),
    ...(imagesOmitted ? { imagesOmitted } : {}),
  });
}

export function modelContextSnapshot(context: Context): Record<string, unknown> {
  const visibleMessages = context.messages.slice(-MAX_CONTEXT_MESSAGES).map(publicMessageForArtifacts);
  const snapshot = boundedPublicValue({
    systemPrompt: context.systemPrompt ?? "",
    messages: visibleMessages,
    tools: (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }) as Record<string, unknown>;
  const serialized = JSON.stringify(snapshot);
  return {
    ...snapshot,
    messageCount: context.messages.length,
    omittedMessageCount: Math.max(0, context.messages.length - visibleMessages.length),
    toolCount: context.tools?.length ?? 0,
    digest: createHash("sha256").update(serialized).digest("hex"),
    persistenceNotice: "Hidden reasoning, secrets, authorization material, and image pixels are intentionally omitted.",
  };
}

export function boundedContextSection(name: string, content: string): { name: string; content: string; characters: number; digest: string } {
  const sanitized = String(boundedPublicValue(content));
  return {
    name,
    content: sanitized,
    characters: content.length,
    digest: createHash("sha256").update(sanitized).digest("hex"),
  };
}

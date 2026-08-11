import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { verifyAuditChain } from "./audit.js";
import { sanitizeSecrets } from "./sanitize.js";
import type { AuditRecord, RunReview, RunState } from "./types.js";

const SAFE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TraceKind =
  | "turn"
  | "decision"
  | "plan"
  | "action"
  | "observation"
  | "checkpoint"
  | "hypothesis"
  | "revision"
  | "finding"
  | "lesson"
  | "outcome";

export interface DecisionTraceEvent {
  sequence: number;
  timestamp: string;
  kind: TraceKind;
  title: string;
  summary: string;
  data: unknown;
  status?: "allowed" | "denied" | "success" | "error";
}

function assertRunId(id: string): void {
  if (!SAFE_RUN_ID.test(id)) throw new Error("Invalid run id");
}

function truncate(value: unknown, depth = 0): unknown {
  const sanitized = depth === 0 ? sanitizeSecrets(value) : value;
  if (typeof sanitized === "string") return sanitized.length > 6000 ? `${sanitized.slice(0, 6000)}\n[truncated]` : sanitized;
  if (depth >= 5) return "[nested data omitted]";
  if (Array.isArray(sanitized)) return sanitized.slice(0, 50).map((item) => truncate(item, depth + 1));
  if (sanitized && typeof sanitized === "object") {
    return Object.fromEntries(Object.entries(sanitized).slice(0, 80).map(([key, item]) => [key, truncate(item, depth + 1)]));
  }
  return sanitized;
}

function summaryOf(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const data = value as Record<string, unknown>;
  for (const key of ["goal", "assessment", "title", "summary", "reason", "message", "nextAction"]) {
    if (typeof data[key] === "string" && data[key]) return String(data[key]).slice(0, 360);
  }
  return fallback;
}

function scrubReviewText(value: string, maxLength: number): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [redacted]")
    .replace(/\b(authorization|cookie|api[-_]?key|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, maxLength)
    .trim();
}

function publicDecisionNote(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return text ? scrubReviewText(text, 1200) : undefined;
}

function traceEvent(record: AuditRecord): DecisionTraceEvent | undefined {
  const data = truncate(record.data);
  const raw = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  if (record.type === "turn.started") {
    const turn = Number(raw.turn);
    return {
      sequence: record.sequence,
      timestamp: record.timestamp,
      kind: "turn",
      title: Number.isInteger(turn) && turn > 0 ? `第 ${turn} 轮 LLM` : "LLM 新一轮",
      summary: "开始评估现有证据并选择下一步动作",
      data: { turn: Number.isInteger(turn) && turn > 0 ? turn : undefined },
    };
  }
  if (record.type === "assistant.message") {
    const note = publicDecisionNote(record.data);
    if (!note) return undefined;
    return {
      sequence: record.sequence,
      timestamp: record.timestamp,
      kind: "decision",
      title: "本轮判断",
      summary: note.slice(0, 360),
      data: { text: note },
    };
  }
  if (record.type === "plan.submitted") {
    return { sequence: record.sequence, timestamp: record.timestamp, kind: "plan", title: "执行计划", summary: summaryOf(raw, "已提交执行计划"), data };
  }
  if (record.type === "policy.decision") {
    const allowed = raw.allowed === true;
    const toolName = String(raw.toolName ?? "unknown");
    return {
      sequence: record.sequence,
      timestamp: record.timestamp,
      kind: "action",
      title: `动作 · ${toolName}`,
      summary: String(raw.reason ?? (allowed ? "策略允许" : "策略拒绝")).slice(0, 360),
      data,
      status: allowed ? "allowed" : "denied",
    };
  }
  if (record.type === "tool.result") {
    const toolName = String(raw.toolName ?? "unknown");
    const isError = raw.isError === true;
    return {
      sequence: record.sequence,
      timestamp: record.timestamp,
      kind: "observation",
      title: `观察 · ${toolName}`,
      summary: isError ? "工具执行失败，需在检查点调整策略" : "已获得有界工具观察",
      data,
      status: isError ? "error" : "success",
    };
  }
  if (record.type === "decision.checkpoint") {
    return { sequence: record.sequence, timestamp: record.timestamp, kind: "checkpoint", title: "决策检查点", summary: summaryOf(raw, "已更新判断与下一步策略"), data };
  }
  if (record.type === "hypothesis.updated") {
    const updates = Array.isArray(raw.updates) ? raw.updates : [];
    return {
      sequence: record.sequence,
      timestamp: record.timestamp,
      kind: "hypothesis",
      title: "假设台账更新",
      summary: `更新 ${updates.length} 项假设状态与证据`,
      data,
    };
  }
  if (record.type === "strategy.revised") {
    const revision = raw.revision && typeof raw.revision === "object" ? raw.revision as Record<string, unknown> : {};
    return {
      sequence: record.sequence,
      timestamp: record.timestamp,
      kind: "revision",
      title: "失败后策略修订",
      summary: summaryOf(revision, "已分类失败并切换下一步策略"),
      data,
    };
  }
  if (record.type === "finding.recorded") {
    return { sequence: record.sequence, timestamp: record.timestamp, kind: "finding", title: "证据发现", summary: summaryOf(raw, "记录了证据发现"), data };
  }
  if (record.type === "lesson.captured") {
    return { sequence: record.sequence, timestamp: record.timestamp, kind: "lesson", title: "候选经验", summary: summaryOf(raw, "记录了待验真的通用经验"), data };
  }
  if (record.type === "run.finished_by_agent" || record.type === "run.settled" || record.type === "run.error") {
    return { sequence: record.sequence, timestamp: record.timestamp, kind: "outcome", title: "运行结果", summary: summaryOf(raw, record.type), data, status: record.type === "run.error" ? "error" : "success" };
  }
  return undefined;
}

export async function readAuditRecords(path: string): Promise<AuditRecord[]> {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditRecord);
}

export async function readRunReviews(artifactRoot: string, runId: string): Promise<RunReview[]> {
  assertRunId(runId);
  try {
    const content = await readFile(join(artifactRoot, runId, "reviews.jsonl"), "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunReview);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendRunReview(
  artifactRoot: string,
  runId: string,
  input: Pick<RunReview, "sequence" | "verdict" | "note" | "correction">,
): Promise<RunReview> {
  assertRunId(runId);
  const auditPath = join(artifactRoot, runId, "audit.jsonl");
  const records = await readAuditRecords(auditPath);
  if (!Number.isInteger(input.sequence) || !records.some((record) => record.sequence === input.sequence)) {
    throw new Error("Review sequence does not exist in this run");
  }
  if (!input.note.trim()) throw new Error("Review note must not be empty");
  const review: RunReview = {
    id: randomUUID(),
    sequence: input.sequence,
    verdict: input.verdict,
    note: scrubReviewText(input.note, 2000),
    ...(input.correction?.trim() ? { correction: scrubReviewText(input.correction, 4000) } : {}),
    createdAt: new Date().toISOString(),
  };
  const path = join(artifactRoot, runId, "reviews.jsonl");
  await mkdir(join(artifactRoot, runId), { recursive: true });
  await appendFile(path, `${JSON.stringify(review)}\n`, "utf8");
  return review;
}

export async function loadDecisionTrace(artifactRoot: string, runId: string): Promise<{
  state: RunState;
  integrity: Awaited<ReturnType<typeof verifyAuditChain>>;
  timeline: DecisionTraceEvent[];
  reviews: RunReview[];
}> {
  assertRunId(runId);
  const directory = join(artifactRoot, runId);
  const auditPath = join(directory, "audit.jsonl");
  const [loadedState, records, integrity, reviews] = await Promise.all([
    readFile(join(directory, "state.json"), "utf8").then((text) => JSON.parse(text) as RunState),
    readAuditRecords(auditPath),
    verifyAuditChain(auditPath),
    readRunReviews(artifactRoot, runId),
  ]);
  const state: RunState = {
    ...loadedState,
    lessons: loadedState.lessons ?? [],
    hypotheses: loadedState.hypotheses ?? [],
    strategyRevisions: loadedState.strategyRevisions ?? [],
    strategyRevisionRequired: loadedState.strategyRevisionRequired ?? false,
    sandboxNamespace: loadedState.sandboxNamespace ?? loadedState.id,
    scratchRoot: loadedState.scratchRoot ?? "legacy shared scratch",
    workspaceMode: loadedState.workspaceMode ?? "configured",
    appliedExperienceIds: loadedState.appliedExperienceIds ?? [],
    imageObservations: loadedState.imageObservations ?? 0,
  };
  return { state, integrity, timeline: records.map(traceEvent).filter((item): item is DecisionTraceEvent => Boolean(item)), reviews };
}

export async function listPersistedRuns(artifactRoot: string): Promise<Array<{
  id: string;
  status: RunState["status"];
  phase: RunState["phase"];
  task: string;
  category?: string;
  createdAt: string;
  finishedAt?: string;
  turns: number;
  toolCalls: number;
  lessons: number;
}>> {
  await mkdir(artifactRoot, { recursive: true });
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    try {
      const state = JSON.parse(await readFile(join(artifactRoot, entry.name, "state.json"), "utf8")) as RunState;
      summaries.push({
        id: state.id,
        status: state.status,
        phase: state.phase,
        task: state.task.task.slice(0, 240),
        ...(state.task.metadata.category ? { category: state.task.metadata.category } : {}),
        createdAt: state.createdAt,
        ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
        turns: state.turns,
        toolCalls: state.toolCalls,
        lessons: state.lessons?.length ?? 0,
      });
    } catch {
      // Ignore incomplete/corrupt directories; the trace endpoint will surface corruption for explicit IDs.
    }
  }
  return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

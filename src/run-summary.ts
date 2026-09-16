import { isTerminalReason } from "./terminal-reason.js";
import type { RunLineage, RunState, RunStatus, TerminalReason } from "./types.js";

export const RUN_SUMMARY_FILE = "summary.json";

export interface PersistedRunSummary {
  id: string;
  status: RunStatus;
  phase: RunState["phase"];
  task: string;
  category?: string;
  createdAt: string;
  finishedAt?: string;
  turns: number;
  toolCalls: number;
  lessons: number;
  terminalReason?: TerminalReason;
  lineage?: RunLineage;
}

export function projectRunSummary(state: RunState): PersistedRunSummary {
  return {
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
    ...(state.terminalReason ? { terminalReason: state.terminalReason } : {}),
    ...(state.lineage ? { lineage: state.lineage } : {}),
  };
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && ["queued", "running", "completed", "blocked", "failed", "aborted"].includes(value);
}

function isRunLineage(value: unknown): value is RunLineage {
  if (!value || typeof value !== "object") return false;
  const lineage = value as Record<string, unknown>;
  return typeof lineage.parentRunId === "string"
    && Number.isSafeInteger(lineage.boundarySequence)
    && (lineage.mode === "fork" || lineage.mode === "resume")
    && Number.isSafeInteger(lineage.inheritedEventCount);
}

export function isPersistedRunSummary(value: unknown): value is PersistedRunSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.id === "string"
    && isRunStatus(summary.status)
    && typeof summary.phase === "string"
    && typeof summary.task === "string"
    && typeof summary.createdAt === "string"
    && Number.isSafeInteger(summary.turns)
    && Number.isSafeInteger(summary.toolCalls)
    && Number.isSafeInteger(summary.lessons)
    && (summary.category === undefined || typeof summary.category === "string")
    && (summary.finishedAt === undefined || typeof summary.finishedAt === "string")
    && (summary.terminalReason === undefined || isTerminalReason(summary.terminalReason))
    && (summary.lineage === undefined || isRunLineage(summary.lineage));
}

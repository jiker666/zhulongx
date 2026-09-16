import type { ObserverAnomaly, ObserverAnomalyKind, RunState, RuntimeConfig } from "./types.js";

/**
 * Record-only run observer, from the winning ai小分队 architecture
 * (Manager + Solver + Observer): the Observer bypass-supervises — it never
 * intervenes in the solver's actions, it only records pathologies so the
 * operator, the handoff, and follow-up runs can see them. Detection is
 * deterministic (no model calls): repeated identical actions, repeated
 * failing actions, repeated reads of the same target, and checkpoints that
 * never come.
 */

const CONTROL_TOOLS = new Set([
  "submit_plan", "update_plan_steps", "checkpoint", "record_finding", "record_lesson", "finish_task", "read_shared_evidence",
]);

const READ_TOOLS = new Set([
  "list_files", "read_file", "read_scratch_file", "list_scratch_files", "inspect_artifact",
]);

const MAX_TRACKED_SIGNATURES = 256;
const MAX_ANOMALIES = 12;

interface SignatureStats {
  count: number;
  failures: number;
}

function actionSignature(toolName: string, args: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(args ?? {});
  } catch {
    rendered = "[unserializable args]";
  }
  return `${toolName}:${rendered.slice(0, 200)}`;
}

export class RunObserver {
  private readonly stats = new Map<string, SignatureStats>();
  private lastCheckpointGap = 0;

  constructor(
    private readonly state: RunState,
    private readonly runtime: Pick<RuntimeConfig, "maxRepeatedAction" | "maxActionsWithoutCheckpoint">,
  ) {}

  private repeatedActionThreshold(): number {
    return Math.max(3, this.runtime.maxRepeatedAction);
  }

  private checkpointGapThreshold(): number {
    return Math.max(8, 2 * this.runtime.maxActionsWithoutCheckpoint);
  }

  /** Emit or update one anomaly; details stay stable so entries merge across splices. */
  private emit(kind: ObserverAnomalyKind, detail: string, now: string): ObserverAnomaly {
    this.state.observerAnomalies ??= [];
    const anomalies = this.state.observerAnomalies;
    const existing = anomalies.find((item) => item.kind === kind && item.detail === detail);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenAt = now;
      return existing;
    }
    const anomaly: ObserverAnomaly = {
      kind,
      detail: detail.slice(0, 300),
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    anomalies.push(anomaly);
    if (anomalies.length > MAX_ANOMALIES) anomalies.splice(0, anomalies.length - MAX_ANOMALIES);
    return anomaly;
  }

  /** Record one settled tool call; returns newly emitted or updated anomalies (audited by the caller). */
  observe(input: { toolName: string; args: unknown; isError: boolean }): ObserverAnomaly[] {
    const emitted: ObserverAnomaly[] = [];
    const now = new Date().toISOString();
    if (input.toolName === "checkpoint") {
      this.lastCheckpointGap = 0;
      return emitted;
    }
    if (CONTROL_TOOLS.has(input.toolName)) return emitted;

    const key = actionSignature(input.toolName, input.args);
    if (!this.stats.has(key) && this.stats.size >= MAX_TRACKED_SIGNATURES) return emitted;
    const stats = this.stats.get(key) ?? { count: 0, failures: 0 };
    this.stats.set(key, stats);
    stats.count += 1;
    if (input.isError) stats.failures += 1;

    const repeatedThreshold = this.repeatedActionThreshold();
    const isRead = READ_TOOLS.has(input.toolName);
    // Reads get a higher bar: re-reading the same target is a weaker smell
    // than re-issuing the same action.
    if (isRead ? stats.count >= repeatedThreshold + 3 : stats.count >= repeatedThreshold) {
      const detail = isRead
        ? `same ${input.toolName} target re-read repeatedly`
        : `identical ${input.toolName} call repeated with unchanged arguments`;
      emitted.push(this.emit(isRead ? "repeated_read" : "repeated_action", detail, now));
    }
    if (stats.failures >= 3 && (stats.failures === 3 || stats.failures % 5 === 0)) {
      emitted.push(this.emit("repeated_failure", `${input.toolName} call keeps failing with identical arguments`, now));
    }

    const gap = this.state.actionsSinceCheckpoint;
    const gapThreshold = this.checkpointGapThreshold();
    if (gap >= gapThreshold && gap >= this.lastCheckpointGap + gapThreshold) {
      this.lastCheckpointGap = gap;
      emitted.push(this.emit("checkpoint_gap", "many actions elapsed without a decision checkpoint", now));
    }
    return emitted;
  }
}

import { WEB_PHASES, type WebAgentState, type WebPhase, type WebPhaseRecord } from "./types.js";

const NEXT_PHASES: Record<WebPhase, WebPhase[]> = {
  INIT: ["RECON", "FAILED"],
  RECON: ["ENUMERATION", "FINGERPRINT", "FAILED"],
  ENUMERATION: ["FINGERPRINT", "VULNERABILITY_ANALYSIS", "FAILED"],
  FINGERPRINT: ["VULNERABILITY_ANALYSIS", "FAILED"],
  VULNERABILITY_ANALYSIS: ["EXPLOITATION", "RECON", "FAILED"],
  EXPLOITATION: ["RESULT_DISCOVERY", "VULNERABILITY_ANALYSIS", "FAILED"],
  RESULT_DISCOVERY: ["VERIFICATION", "EXPLOITATION", "FAILED"],
  VERIFICATION: ["COMPLETE", "RESULT_DISCOVERY", "FAILED"],
  COMPLETE: [],
  FAILED: [],
};

export function createWebAgentState(now = new Date().toISOString()): WebAgentState {
  return {
    phase: "INIT",
    history: [{ phase: "INIT", enteredAt: now, reason: "Web task initialized" }],
    activeRole: "recon",
    failureCount: 0,
    repeatedActionCount: 0,
  };
}

// Stable timestamp used when a record has no usable enteredAt, so normalize is
// deterministic and never reads the clock.
const STABLE_EPOCH = "1970-01-01T00:00:00.000Z";

function normalizeHistoryRecord(record: unknown, fallbackTime: string): WebPhaseRecord | undefined {
  if (!record || typeof record !== "object") return undefined;
  const item = record as Partial<WebPhaseRecord>;
  if (typeof item.phase !== "string" || !(WEB_PHASES as readonly string[]).includes(item.phase)) return undefined;
  return {
    phase: item.phase as WebPhase,
    enteredAt: typeof item.enteredAt === "string" ? item.enteredAt : fallbackTime,
    reason: typeof item.reason === "string" ? item.reason : "",
    ...(typeof item.completedAt === "string" ? { completedAt: item.completedAt } : {}),
  };
}

export function normalizeWebAgentState(input: unknown, fallback: WebAgentState, now?: string): WebAgentState {
  if (!input || typeof input !== "object") return fallback;
  const source = input as Partial<WebAgentState>;

  // A valid persisted phase is authoritative; do not let a stale history override it.
  const phase: WebPhase = typeof source.phase === "string" && (WEB_PHASES as readonly string[]).includes(source.phase)
    ? source.phase as WebPhase
    : fallback.phase;

  // The active role is always derived from the final phase. A persisted role that
  // disagrees with the phase is not trusted.
  const activeRole = roleForPhase(phase);

  // Stable repair timestamp, in priority order:
  // 1. last valid enteredAt on a persisted record
  // 2. last enteredAt on the fallback history
  // 3. explicitly passed now
  // 4. a stable epoch constant
  const lastEnteredAt = Array.isArray(source.history)
    ? source.history
        .filter((record): record is WebPhaseRecord => Boolean(record && typeof record === "object" && typeof record.enteredAt === "string"))
        .map((record) => record.enteredAt)
        .at(-1)
    : undefined;
  const fallbackTime = lastEnteredAt ?? fallback.history[fallback.history.length - 1]?.enteredAt ?? now ?? STABLE_EPOCH;

  // Normalize each record: drop invalid phases, repair missing string fields.
  const history = Array.isArray(source.history)
    ? source.history.map((record) => normalizeHistoryRecord(record, fallbackTime)).filter((record): record is WebPhaseRecord => record !== undefined)
    : [];

  // An empty history is repaired with one record consistent with the current phase.
  if (history.length === 0) {
    history.push({ phase, enteredAt: fallbackTime, reason: "Web phase state restored" });
  }

  // If the trailing record disagrees with the authoritative phase, do not change the
  // phase; append a restore record so the trace remains honest.
  if (history[history.length - 1]!.phase !== phase) {
    history.push({ phase, enteredAt: fallbackTime, reason: `Phase restored to ${phase}` });
  }

  return {
    phase,
    history,
    activeRole,
    failureCount: typeof source.failureCount === "number" && Number.isFinite(source.failureCount) && source.failureCount >= 0 ? source.failureCount : fallback.failureCount,
    repeatedActionCount: typeof source.repeatedActionCount === "number" && Number.isFinite(source.repeatedActionCount) && source.repeatedActionCount >= 0 ? source.repeatedActionCount : fallback.repeatedActionCount,
  };
}

export function canTransition(from: WebPhase, to: WebPhase): boolean {
  return NEXT_PHASES[from].includes(to);
}

export function transitionWebPhase(
  state: WebAgentState,
  to: WebPhase,
  reason: string,
  now = new Date().toISOString(),
): WebAgentState {
  if (!canTransition(state.phase, to)) {
    throw new Error(`Invalid Web phase transition: ${state.phase} -> ${to}`);
  }
  const current: WebPhaseRecord | undefined = state.history[state.history.length - 1];
  const history = state.history.map((record, index) =>
    index === state.history.length - 1 && record.completedAt === undefined
      ? { ...record, completedAt: now }
      : record,
  );
  return {
    ...state,
    phase: to,
    history: [...history, { phase: to, enteredAt: now, reason }],
    activeRole: roleForPhase(to),
    failureCount: to === "FAILED" ? state.failureCount + 1 : state.failureCount,
    repeatedActionCount: to === current?.phase ? state.repeatedActionCount + 1 : 0,
  };
}

export function roleForPhase(phase: WebPhase): WebAgentState["activeRole"] {
  switch (phase) {
    case "RECON":
    case "ENUMERATION":
      return "recon";
    case "FINGERPRINT":
      return "fingerprint";
    case "VULNERABILITY_ANALYSIS":
      return "vulnerability";
    case "EXPLOITATION":
      return "exploit";
    case "RESULT_DISCOVERY":
      return "exploit";
    case "VERIFICATION":
      return "verification";
    case "COMPLETE":
      return "verification";
    case "FAILED":
      return "recovery";
    case "INIT":
      return "recon";
  }
}

export function isTerminalPhase(phase: WebPhase): boolean {
  return phase === "COMPLETE" || phase === "FAILED";
}

export function webPhaseNames(): readonly WebPhase[] {
  return WEB_PHASES;
}

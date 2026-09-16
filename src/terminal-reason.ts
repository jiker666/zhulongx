import type { ProviderError, TerminalReason } from "./types.js";

/**
 * Structured terminal classification for a finished run (borrowed from the
 * ARTEX terminal-reason taxonomy: a coarse status plus the machine-checkable
 * reason an operator or campaign layer needs to decide retry vs pivot).
 */
export const TERMINAL_REASONS: readonly TerminalReason[] = [
  "agent_completed",
  "agent_blocked",
  "ended_without_finish",
  "output_limit",
  "model_error",
  "operator_abort",
  "infrastructure_error",
] as const;

const REASON_HINTS: Record<TerminalReason, string> = {
  agent_completed: "Agent called finish_task with status completed; check submission validation before treating the run as a success.",
  agent_blocked: "Agent declared a blocker via finish_task; read the summary and ledger coverage to decide between a hint, a resume, or a pivot.",
  ended_without_finish: "Conversation ended without finish_task; scratch and handoff data are preserved — resume or fork the run instead of restarting from zero.",
  output_limit: "Output token limit exhausted after length recovery; narrow per-turn output (smaller sweeps or scripts per call) before resuming.",
  model_error: "Model/provider request failed; retry only when the provider error is transient (rate_limit, network, server).",
  operator_abort: "Run stopped by the operator or an abort signal; inherited scratch keeps the work — resume when ready.",
  infrastructure_error: "Non-model execution failure (sandbox, container, pipeline); inspect the run.error audit record before retrying.",
};

export function terminalReasonHint(reason: TerminalReason): string {
  return REASON_HINTS[reason];
}

export function isTerminalReason(value: unknown): value is TerminalReason {
  return typeof value === "string" && (TERMINAL_REASONS as readonly string[]).includes(value);
}

/**
 * A terminal outcome is retry-worthy only when it is a provider transport
 * failure classified as transient. Budget exhaustion and agent-declared
 * blockers are steady states, not transient faults — retrying them unchanged
 just reproduces the same outcome.
 */
export function isTransientTerminalReason(reason: TerminalReason, providerError?: ProviderError): boolean {
  if (reason !== "model_error") return false;
  if (!providerError) return false;
  return providerError.retryable || ["rate_limit", "network", "server"].includes(providerError.code);
}

/** Legacy free-text fallback for runs recorded before terminalReason existed. */
export function isTransientStopMessage(message: string | undefined): boolean {
  return /(?:\b429\b|too\s*many\s*requests|rate\s*limit|\b5\d\d\b|econnreset|etimedout|fetch failed|socket hang up|connection error)/i.test(message ?? "");
}

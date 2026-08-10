import type { WebReasoningActionProposal, WebReasoningState } from "./types.js";

export type WebActionGuardDecision = "allow" | "allow_with_warning" | "reject_duplicate" | "reject_phase_mismatch" | "reject_missing_evidence" | "reject_finalization_mode" | "reject_unknown_tool";
export interface WebActionGuardResult { decision: WebActionGuardDecision; reason: string; }
export interface WebAgentAction { toolName: string; args: unknown; }

/** Validates model-proposed tool actions without executing or authorizing them. */
export class WebActionGuard {
  validate(proposal: WebReasoningActionProposal | undefined, action: WebAgentAction, state: WebReasoningState, availableTools: readonly string[]): WebActionGuardResult {
    if (!availableTools.includes(action.toolName)) return { decision: "reject_unknown_tool", reason: `Tool is not registered: ${action.toolName}` };
    if (action.toolName === "run_command" && action.args && typeof action.args === "object" && /\b(node|deno|bun|qjs|quickjs|js)\b/i.test(String((action.args as Record<string, unknown>).program ?? ""))) return { decision: "reject_phase_mismatch", reason: "JavaScript execution is not permitted by the static analysis role" };
    if (action.toolName === "http_request" && action.args && typeof action.args === "object" && /\.map(?:[?#]|$)/i.test(String((action.args as Record<string, unknown>).url ?? ""))) return { decision: "reject_phase_mismatch", reason: "Source map metadata must come from an already authorized artifact or tool result" };
    if (action.toolName === "browser" && action.args && typeof action.args === "object" && ["evaluate", "upload", "download", "popup", "capture_screenshot"].includes(String((action.args as Record<string, unknown>).action ?? ""))) return { decision: "reject_phase_mismatch", reason: "This browser action is disabled by the controlled browser guard" };
    if (state.phase === "completing" || state.phase === "verifying") {
      const allowed = new Set(["finish_task", "checkpoint", "inspect_artifact", "read_scratch_file", "web_compare_responses"]);
      if (!allowed.has(action.toolName)) return { decision: "reject_finalization_mode", reason: "Finalization mode only permits verification, checkpoint, and completion actions" };
    }
    if (proposal?.requestedTool && proposal.requestedTool !== action.toolName) return { decision: "allow_with_warning", reason: "Agent selected a different registered tool than the recommendation; PolicyEngine remains authoritative" };
    if (proposal?.kind === "verify_candidate" && action.toolName !== "finish_task" && action.toolName !== "web_compare_responses") return { decision: "allow_with_warning", reason: "Candidate verification is preferred before additional exploration" };
    return { decision: "allow", reason: "Registered action is compatible with the current Web reasoning phase" };
  }
}

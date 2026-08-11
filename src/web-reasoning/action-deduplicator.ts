import { fingerprint } from "./state.js";
import type { WebReasoningAction, WebReasoningActionProposal, WebReasoningState } from "./types.js";

export class ActionDeduplicator {
  constructor(private readonly state: WebReasoningState) {}
  key(proposal: Pick<WebReasoningActionProposal, "kind" | "requestedTool" | "requestedArguments" | "hypothesisId">): string {
    const args = proposal.requestedArguments && typeof proposal.requestedArguments.url === "string"
      ? { ...proposal.requestedArguments, url: normalizeUrl(proposal.requestedArguments.url) } : proposal.requestedArguments;
    return fingerprint({ kind: proposal.kind, tool: proposal.requestedTool, args, hypothesis: proposal.hypothesisId });
  }
  find(proposal: Pick<WebReasoningActionProposal, "kind" | "requestedTool" | "requestedArguments" | "hypothesisId">): WebReasoningAction | undefined {
    const key = this.key(proposal);
    return this.state.actions.find((item) => item.deduplicationKey === key && ["succeeded", "failed", "policy_rejected", "skipped_duplicate"].includes(item.status));
  }
  shouldSkip(proposal: Pick<WebReasoningActionProposal, "kind" | "requestedTool" | "requestedArguments" | "hypothesisId">): boolean {
    const previous = this.find(proposal); return Boolean(previous && previous.status !== "timed_out" && previous.status !== "aborted");
  }
}

function normalizeUrl(value: string): string { try { const url = new URL(value); url.hostname = url.hostname.toLowerCase(); url.hash = ""; return url.toString(); } catch { return value.trim(); } }

import { fingerprint } from "./state.js";
import type { WebReasoningAction, WebReasoningActionProposal, WebReasoningState } from "./types.js";

export class ActionDeduplicator {
  // Re-observation window (29070 post-mortem): stateful endpoints (rotating
  // captcha/signature, poll targets, short-TTL sessions) legitimately return
  // DIFFERENT content for an identical request. A permanent key block froze
  // two challenges into 22+ worker sessions of cache-buster gymnastics. The
  // same key re-runs freely once its previous action is this old.
  private static readonly REOBSERVE_AFTER_MS = 10 * 60_000;

  constructor(private readonly state: WebReasoningState) {}
  key(proposal: Pick<WebReasoningActionProposal, "kind" | "requestedTool" | "requestedArguments" | "hypothesisId">): string {
    const args = proposal.requestedArguments && typeof proposal.requestedArguments.url === "string"
      ? { ...proposal.requestedArguments, url: normalizeUrl(proposal.requestedArguments.url) } : proposal.requestedArguments;
    return fingerprint({ kind: proposal.kind, tool: proposal.requestedTool, args, hypothesis: proposal.hypothesisId });
  }
  find(proposal: Pick<WebReasoningActionProposal, "kind" | "requestedTool" | "requestedArguments" | "hypothesisId">): WebReasoningAction | undefined {
    const key = this.key(proposal);
    const matches = this.state.actions.filter((item) => item.deduplicationKey === key && ["succeeded", "failed", "policy_rejected", "skipped_duplicate"].includes(item.status));
    const latest = matches[matches.length - 1];
    if (!latest) return undefined;
    const latestAt = Date.parse(latest.startedAt ?? "");
    if (Number.isFinite(latestAt) && Date.now() - latestAt > ActionDeduplicator.REOBSERVE_AFTER_MS) return undefined;
    return latest;
  }
  shouldSkip(proposal: Pick<WebReasoningActionProposal, "kind" | "requestedTool" | "requestedArguments" | "hypothesisId">): boolean {
    const previous = this.find(proposal); return Boolean(previous && previous.status !== "timed_out" && previous.status !== "aborted");
  }
}

function normalizeUrl(value: string): string { try { const url = new URL(value); url.hostname = url.hostname.toLowerCase(); url.hash = ""; return url.toString(); } catch { return value.trim(); } }

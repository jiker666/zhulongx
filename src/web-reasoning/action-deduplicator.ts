import { fingerprint } from "./state.js";
import type { WebReasoningAction, WebReasoningActionProposal, WebReasoningState } from "./types.js";

/**
 * Mutating call classes (R17 three-class dedup). A mutation changes
 * observable server/session state — login, submit, write, browser
 * interaction — so reads taken BEFORE the mutation may legitimately return
 * different bytes afterwards. Identical re-reads therefore never dedup
 * across a mutation epoch boundary (29070: the post-login profile GET was
 * blocked by its pre-login twin; -34/-35 dedup false-positives).
 * STATIC class (unchanged file/artifact reads) and TTL class (stateful
 * endpoints inside one epoch, 10-minute re-observe) behave as before.
 */
const MUTATING_HTTP_METHOD = /^(?:post|put|patch|delete|connect)$/i;
const READONLY_BROWSER_ACTIONS = /^(?:create_session|open_page|navigate|capture_dom|get_state|read_storage|read_cookies|screenshot|list_|wait_for_|describe_|inspect_|get_)/i;

export function isMutatingToolCall(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
  if (!toolName || !args) return false;
  const method = typeof args.method === "string" ? args.method
    : typeof args.httpMethod === "string" ? args.httpMethod
    : "";
  if (method) return MUTATING_HTTP_METHOD.test(method);
  if (/http|fetch|request|submit/i.test(toolName)) {
    // HTTP tools default to GET; an explicit body without a method field is
    // still a write-shaped request.
    return args.body !== undefined && args.body !== "" && args.body !== null;
  }
  const action = typeof args.action === "string" ? args.action : "";
  if (action && /browser|page|dom/i.test(toolName)) return !READONLY_BROWSER_ACTIONS.test(action);
  return false;
}

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
    // Stateful no-dedup across epochs: server/session state changed since
    // that observation, so identical arguments may return new evidence.
    if (latest.stateEpoch !== undefined && latest.stateEpoch !== (this.state.mutationEpoch ?? 0)) return undefined;
    return latest;
  }
  shouldSkip(proposal: Pick<WebReasoningActionProposal, "kind" | "requestedTool" | "requestedArguments" | "hypothesisId">): boolean {
    const previous = this.find(proposal); return Boolean(previous && previous.status !== "timed_out" && previous.status !== "aborted");
  }
}

function normalizeUrl(value: string): string { try { const url = new URL(value); url.hostname = url.hostname.toLowerCase(); url.hash = ""; return url.toString(); } catch { return value.trim(); } }

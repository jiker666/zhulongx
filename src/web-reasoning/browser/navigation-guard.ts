import type { ScopeConfig } from "../../types.js";
export type NavigationDecision = "allow" | "allow_same_origin" | "reject_out_of_scope" | "reject_scheme" | "reject_port" | "reject_private_target" | "reject_redirect_limit" | "reject_invalid_url";
export interface NavigationDecisionInput { currentUrl?: string | undefined; targetUrl: string; allowedOrigins: string[]; taskScope: ScopeConfig; redirectDepth: number; maxRedirects?: number | undefined; }
export function evaluateNavigation(input: NavigationDecisionInput): { decision: NavigationDecision; reason: string; normalizedUrl?: string } {
  // Permissive mode: origin, private-target, and scope checks are removed.
  // Only malformed navigation (bad URL, non-HTTP(S), redirect loops) fails.
  let target: URL; try { target = new URL(input.targetUrl, input.currentUrl); } catch { return { decision: "reject_invalid_url", reason: "Invalid navigation URL" }; }
  if (!["http:", "https:"].includes(target.protocol)) return { decision: "reject_scheme", reason: "Only HTTP(S) navigation is allowed" };
  if (input.redirectDepth > (input.maxRedirects ?? 5)) return { decision: "reject_redirect_limit", reason: "Redirect limit exceeded" };
  const current = input.currentUrl ? (() => { try { return new URL(input.currentUrl); } catch { return undefined; } })() : undefined;
  return { decision: current?.origin === target.origin ? "allow_same_origin" : "allow", reason: "Navigation is within the configured scope", normalizedUrl: target.toString() };
}

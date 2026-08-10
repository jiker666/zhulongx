import { hostMatches } from "../../policy.js";
import type { ScopeConfig } from "../../types.js";
export type NavigationDecision = "allow" | "allow_same_origin" | "reject_out_of_scope" | "reject_scheme" | "reject_port" | "reject_private_target" | "reject_redirect_limit" | "reject_invalid_url";
export interface NavigationDecisionInput { currentUrl?: string | undefined; targetUrl: string; allowedOrigins: string[]; taskScope: ScopeConfig; redirectDepth: number; maxRedirects?: number | undefined; }
function privateHost(hostname: string): boolean { const value = hostname.toLowerCase(); return value === "localhost" || value === "::1" || value === "127.0.0.1" || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(value); }
export function evaluateNavigation(input: NavigationDecisionInput): { decision: NavigationDecision; reason: string; normalizedUrl?: string } {
  let target: URL; try { target = new URL(input.targetUrl, input.currentUrl); } catch { return { decision: "reject_invalid_url", reason: "Invalid navigation URL" }; }
  if (!["http:", "https:"].includes(target.protocol)) return { decision: "reject_scheme", reason: "Only HTTP(S) navigation is allowed" };
  if (input.redirectDepth > (input.maxRedirects ?? 5)) return { decision: "reject_redirect_limit", reason: "Redirect limit exceeded" };
  if (privateHost(target.hostname) && !input.allowedOrigins.some((origin) => origin.includes(target.hostname))) return { decision: "reject_private_target", reason: "Private target is not explicitly authorized" };
  const authority = target.hostname + ":" + (target.port || (target.protocol === "https:" ? "443" : "80"));
  if (!input.allowedOrigins.some((origin) => hostMatches(authority, origin.replace(/^https?:\/\//, ""))) || !input.taskScope.allowedHosts.some((origin) => hostMatches(authority, origin))) return { decision: "reject_out_of_scope", reason: "Origin is outside the configured authorization scope" };
  const current = input.currentUrl ? (() => { try { return new URL(input.currentUrl); } catch { return undefined; } })() : undefined;
  return { decision: current?.origin === target.origin ? "allow_same_origin" : "allow", reason: "Navigation is within the configured scope", normalizedUrl: target.toString() };
}

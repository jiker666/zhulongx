/**
 * HTML entity identity helpers.
 *
 * ## Identity design
 * - findingId: sha256(prefix + normalizedSemanticKey) — entity identity, stable across responses
 * - occurrenceId: sha256(findingId + contentHash + sourceLocation) — per-observation identity
 * - findingId MUST NOT depend on contentHash
 * - Actual request URLs are preserved in provenance; semantic keys are for DEDUP ONLY
 *
 * ## URL contract
 * normalizeSemanticUrl expects an already-resolved absolute URL.
 * Relative URL resolution is the HTML parser's responsibility (using sourceUrl + <base href>).
 * If an invalid/non-absolute URL reaches here, it is preserved as-is.
 */

import { createHash } from "node:crypto";

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Normalize a URL for entity-identity purposes.
 *
 * - lowercases scheme
 * - lowercases hostname
 * - removes default ports
 * - strips fragment for entity identity
 * - preserves pathname case
 * - preserves the complete query string order and case
 * - does NOT mutate the actual request URL
 *
 * Query parameter order is preserved because it can be semantically significant
 * (duplicate parameters, custom parsers, signatures, middleware, CTF targets).
 */
export function normalizeSemanticUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (url.port && DEFAULT_PORTS[url.protocol] === url.port) {
      url.port = "";
    }
    url.hash = "";
    // query string preserved as-is — order and case are semantically significant
    return url.toString();
  } catch {
    return raw;
  }
}

export function htmlFindingId(prefix: string, normalizedKey: string): string {
  return createHash("sha256").update(`${prefix}:${normalizedKey}`).digest("hex").slice(0, 24);
}

export function htmlOccurrenceId(
  findingId: string,
  contentHash: string,
  sourceLocation: string,
): string {
  return createHash("sha256").update(`${findingId}:${contentHash}:${sourceLocation}`).digest("hex").slice(0, 24);
}

export function formSemanticKey(action: string, method: string): string {
  return `${normalizeSemanticUrl(action)}|${method.toUpperCase()}`;
}

export function linkSemanticKey(href: string): string {
  return normalizeSemanticUrl(href);
}

export function scriptSemanticKey(src: string | undefined, inlineHash: string | undefined): string {
  return src ? `src:${normalizeSemanticUrl(src)}` : `inline:${inlineHash ?? "no-hash"}`;
}

export function apiEndpointSemanticKey(url: string, method?: string): string {
  const normalized = normalizeSemanticUrl(url);
  return method ? `${method.toUpperCase()}:${normalized}` : normalized;
}

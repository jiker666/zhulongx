/**
 * OpenAPI entity identity helpers.
 *
 * Two-tier identity:
 *   findingId    = sha256(prefix + semanticKey)         — entity identity, stable across documents
 *   occurrenceId = sha256(findingId + contentHash + sourcePointer) — per-observation
 *
 * Key invariants:
 * - Path identity preserves observed case and trailing slashes.
 * - Server identity uses the URL template, never positional array indices.
 * - Parameter identity is operation-scoped.
 * - Component parameters carry their own component-pointer identity.
 */

import { createHash } from "node:crypto";

// ---- finding / occurrence ids ----

export function openApiFindingId(prefix: string, semanticKey: string): string {
  return createHash("sha256").update(`${prefix}:${semanticKey}`).digest("hex").slice(0, 24);
}

export function openApiOccurrenceId(
  findingId: string,
  contentHash: string,
  sourcePointer: string,
): string {
  return createHash("sha256")
    .update(`${findingId}:${contentHash}:${sourcePointer}`)
    .digest("hex")
    .slice(0, 24);
}

// ---- structured semantic tuple ----

/**
 * Deterministic encoding for composite semantic keys.
 * JSON.stringify on a string tuple avoids delimiter-ambiguity when
 * observed values (paths, parameter names) contain |, :, or newlines.
 */
function semanticTuple(...parts: string[]): string {
  return JSON.stringify(parts);
}

// ---- endpoint identity ----

/**
 * Preserve observed path exactly — no lowercasing, no trailing-slash stripping.
 * GET /Users and GET /users are distinct endpoints.
 * GET /users and GET /users/ are distinct endpoints.
 */
export function endpointSemanticKey(path: string, method: string): string {
  return semanticTuple(path, method.toUpperCase());
}

// ---- parameter identity ----

/**
 * Operation-scoped parameter identity.
 * `endpointKey` is the semantic key of the owning endpoint (path + method).
 * Parameter name is preserved as observed.
 */
export function parameterSemanticKey(
  endpointKey: string,
  name: string,
  location: string,
): string {
  return semanticTuple(endpointKey, name, location.toLowerCase());
}

/**
 * Component parameter identity (for #/components/parameters/…).
 * Uses the stable component pointer as the entity identity.
 */
export function componentParameterSemanticKey(componentPointer: string): string {
  return componentPointer;
}

// ---- schema identity ----

/** Schema identity via component pointer (e.g. #/components/schemas/User or #/definitions/User). */
export function schemaSemanticKey(pointer: string): string {
  return pointer;
}

// ---- security scheme identity ----

/** Security scheme identity via component pointer (e.g. #/components/securitySchemes/apiKey). */
export function securitySchemeSemanticKey(pointer: string): string {
  return pointer;
}

// ---- server identity ----

/**
 * Server identity via observed URL template.
 * Positional array indices belong in occurrenceId and provenance, never in findingId.
 */
export function serverSemanticKey(urlTemplate: string): string {
  return urlTemplate;
}

// ---- request body identity ----

/** Request body identity: operation-scoped. */
export function requestBodySemanticKey(endpointKey: string): string {
  return semanticTuple(endpointKey, "requestBody");
}

// ---- response identity ----

/** Response identity: operation-scoped + status code. */
export function responseSemanticKey(endpointKey: string, statusCode: string): string {
  return semanticTuple(endpointKey, "response", statusCode);
}

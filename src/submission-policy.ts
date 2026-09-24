import type { NormalizedTask, SubmissionValidation } from "./types.js";

export type SubmissionPolicy = "strict" | "advisory";

export interface SubmissionValidationInput {
  policy: SubmissionPolicy;
  status: "completed" | "blocked";
  candidate?: string;
  observedOutputs: readonly string[];
  independentObservedOutputs?: readonly string[];
  verification: readonly string[];
  independentlyVerified: boolean;
  checkedAt?: string;
  /** Distinct tool-call ids whose outputs contain the candidate (grounding diversity). */
  groundingToolCallIds?: readonly string[];
  /** Arguments (JSON) of the grounding tool calls, to detect echo-grounding. */
  groundingCallArgs?: readonly string[];
}

const IDENTIFIER_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECOY_PREFIX = /^(?:session|request|trace|run|job|task)[-_ ]?(?:id)?\s*[:=]/i;
const SECRET_PREFIX = /^(?:bearer|authorization|cookie|set-cookie)\b/i;
// Long runs of flag-body characters, as printed by decoders and exploit output.
const FLAG_BODY_TOKEN = /[A-Za-z0-9_@!#$%^&*+=.:?~-]{15,160}/g;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const n = b.length;
  let previous = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const current = new Int32Array(n + 1);
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    previous = current;
  }
  return previous[n]!;
}

function nearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 4) return false;
  return levenshtein(a, b) <= Math.max(3, Math.floor(Math.min(a.length, b.length) * 0.1));
}

/**
 * Distinct flag-like tokens observed in tool outputs that are near-duplicates
 * of the candidate (or its unwrapped body). A real task yields exactly one
 * flag; near-duplicates mean two decodes diverged — almost always a
 * transcription normalization ("spell-corrected" leetspeak) on one side.
 * Deliberately distinct decoys are far from the real flag and do not count.
 */
export function conflictingVariants(candidate: string, observedOutputs: readonly string[]): string[] {
  const open = candidate.indexOf("{");
  const close = candidate.lastIndexOf("}");
  const body = open !== -1 && close > open ? candidate.slice(open + 1, close) : candidate;
  const targets = new Set([candidate, body]);
  const variants = new Set<string>();
  for (const output of observedOutputs) {
    FLAG_BODY_TOKEN.lastIndex = 0;
    for (const token of output.match(FLAG_BODY_TOKEN) ?? []) {
      if (targets.has(token) || variants.has(token)) continue;
      if (nearDuplicate(token, candidate) || (body.length >= 15 && nearDuplicate(token, body))) variants.add(token);
    }
  }
  return [...variants].slice(0, 3);
}

export function submissionPolicyFor(task: Pick<NormalizedTask, "metadata">): SubmissionPolicy {
  const requested = task.metadata.submissionPolicy?.trim().toLowerCase();
  if (requested === "strict" || requested === "advisory") return requested;
  return task.metadata.source?.trim().toLowerCase() === "question-bank" ? "strict" : "advisory";
}

function result(
  input: SubmissionValidationInput,
  status: SubmissionValidation["status"],
  reason: string,
  grounded: boolean,
  verificationMentionsCandidate: boolean,
): SubmissionValidation {
  return {
    policy: input.policy,
    status,
    reason,
    grounded,
    independentlyVerified: input.independentlyVerified,
    verificationMentionsCandidate,
    observedOutputCount: input.observedOutputs.length,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

/**
 * Validate a final candidate using only deterministic runtime observations.
 * Model-provided prose is not treated as proof: the candidate must occur in a
 * successful tool result and in the explicit verification record.
 */
export function validateSubmission(input: SubmissionValidationInput): SubmissionValidation {
  const candidate = input.candidate?.trim();
  if (input.policy !== "strict") {
    return result(input, "accepted", "Advisory submission policy; runtime recorded the candidate without blocking.", Boolean(candidate), Boolean(candidate && input.verification.some((item) => item.includes(candidate))));
  }
  if (input.status === "completed" && !candidate) return result(input, "pending", "A strict task cannot complete without an explicit submission candidate.", false, false);
  if (!candidate) return result(input, "accepted", "No submission candidate was declared for a blocked task.", false, false);
  if (IDENTIFIER_ONLY.test(candidate) || DECOY_PREFIX.test(candidate) || SECRET_PREFIX.test(candidate)) {
    return result(input, "rejected", "The candidate has the shape of an identifier or credential, not a task result.", false, false);
  }
  const grounded = input.observedOutputs.some((output) => output.includes(candidate));
  if (!grounded) return result(input, "pending", "The exact candidate was not observed in a successful tool result.", false, false);
  const conflicts = conflictingVariants(candidate, input.observedOutputs);
  if (conflicts.length > 0 && !conflicts.every((variant) => input.verification.some((item) => item.includes(variant)))) {
    return result(input, "pending", `Near-duplicate flag-like variants were also observed in tool outputs (${conflicts.join(" | ")}). Two decodes diverged: re-derive the value deterministically from the original artifact bytes, identify which variant the raw evidence supports, and address every listed variant in verification before submitting.`, true, false);
  }
  // A flag-shaped answer must survive its own production: grounded only by tool
  // calls whose inputs already contained the candidate is an echo, not evidence,
  // and a single grounding call cannot distinguish a corrupted literal in a
  // hand-written script from a real derivation off the artifact bytes.
  if (/[{][^{}]{4,}[}]/.test(candidate) || candidate.length >= 15) {
    const echoGroundedOnly = (input.groundingCallArgs?.length ?? 0) > 0
      && input.groundingCallArgs!.every((args) => args.includes(candidate));
    if (echoGroundedOnly) {
      return result(input, "pending", "The candidate is grounded only by tool calls whose own inputs already contained it (an echo). Re-derive the value deterministically from the original artifact bytes in a fresh script and submit that output's exact string.", true, false);
    }
    const distinctGroundingCalls = new Set(input.groundingToolCallIds ?? []).size;
    if (input.groundingToolCallIds !== undefined && distinctGroundingCalls < 2) {
      return result(input, "pending", "The candidate was observed in only one tool call, which cannot distinguish a corrupted transcription inside a hand-written script from a real derivation. Re-run the deterministic derivation as a separate successful tool call and submit the exact string it prints.", true, false);
    }
  }
  if (!input.independentlyVerified) return result(input, "pending", "The candidate is grounded but was not independently verified.", true, false);
  const independentOutputs = input.independentObservedOutputs ?? input.observedOutputs;
  const independentlyObserved = independentOutputs.some((output) => output.includes(candidate));
  if (!independentlyObserved) return result(input, "pending", "Independent verification must come from a separate successful tool result containing the exact candidate.", true, false);
  const verificationMentionsCandidate = input.verification.some((item) => item.includes(candidate));
  if (!verificationMentionsCandidate) return result(input, "pending", "Verification must mention the exact grounded candidate.", true, false);
  return result(input, "accepted", "The candidate passed grounding, format, and independent-verification gates.", true, true);
}

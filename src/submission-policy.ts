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
}

const IDENTIFIER_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECOY_PREFIX = /^(?:session|request|trace|run|job|task)[-_ ]?(?:id)?\s*[:=]/i;
const SECRET_PREFIX = /^(?:bearer|authorization|cookie|set-cookie)\b/i;

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
  if (!input.independentlyVerified) return result(input, "pending", "The candidate is grounded but was not independently verified.", true, false);
  const independentOutputs = input.independentObservedOutputs ?? input.observedOutputs;
  const independentlyObserved = independentOutputs.some((output) => output.includes(candidate));
  if (!independentlyObserved) return result(input, "pending", "Independent verification must come from a separate successful tool result containing the exact candidate.", true, false);
  const verificationMentionsCandidate = input.verification.some((item) => item.includes(candidate));
  if (!verificationMentionsCandidate) return result(input, "pending", "Verification must mention the exact grounded candidate.", true, false);
  return result(input, "accepted", "The candidate passed grounding, format, and independent-verification gates.", true, true);
}

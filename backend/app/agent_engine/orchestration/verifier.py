from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class VerificationVerdict:
    accepted: bool
    status: str
    reason: str
    evidence_ids: tuple[str, ...]
    conflict: bool = False


class IndependentVerifier:
    def verify(
        self,
        candidate: Any,
        *,
        evidence: tuple[Mapping[str, Any], ...],
        executor_claim: bool,
        reviewer_claim: bool,
    ) -> VerificationVerdict:
        evidence_ids = tuple(str(item.get("evidence_id") or item.get("event_id") or "") for item in evidence)
        evidence_ids = tuple(item for item in evidence_ids if item)
        if not evidence_ids:
            return VerificationVerdict(False, "missing_evidence", "candidate has no independent evidence", ())
        if executor_claim != reviewer_claim:
            return VerificationVerdict(
                False,
                "conflict",
                "executor and verifier conclusions conflict",
                evidence_ids,
                True,
            )
        if not executor_claim:
            return VerificationVerdict(False, "refuted", "both checks rejected the candidate", evidence_ids)
        return VerificationVerdict(True, "verified", "independent checks agree", evidence_ids)


class Refuter:
    def refute(self, claim: Mapping[str, Any], counter_evidence: tuple[Mapping[str, Any], ...]) -> VerificationVerdict:
        claim_ids = set(str(item) for item in claim.get("evidence_ids", ()))
        counters = tuple(
            str(item.get("evidence_id") or item.get("event_id"))
            for item in counter_evidence
            if item.get("evidence_id") or item.get("event_id")
        )
        conflict = bool(counters and (not claim_ids or claim_ids.intersection(counters)))
        return VerificationVerdict(
            not conflict,
            "refuted" if conflict else "not_refuted",
            "counter-evidence contradicts the claim" if conflict else "no relevant counter-example found",
            counters,
            conflict,
        )

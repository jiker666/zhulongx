"""
Candidate evidence policy for blind CTF solve.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List


ALLOWED_SOURCE_TYPES = {
    "attachment",
    "tool_output",
    "http_response",
    "manual_result",
    "decoded_chain",
    "static_strings",
}


def infer_source_type(item: Dict[str, Any]) -> str:
    explicit = str(item.get("source_type") or "").strip()
    if explicit:
        return explicit
    source = str(item.get("source") or "").lower()
    if "misc" in source or item.get("decode_chain"):
        return "decoded_chain"
    if "static" in source:
        return "static_strings"
    if "web" in source or "http" in source:
        return "http_response"
    if "manual" in source:
        return "manual_result"
    if "artifact" in source or "attachment" in source:
        return "attachment"
    return "tool_output"


def normalize_evidence_ids(item: Dict[str, Any]) -> List[str]:
    raw = item.get("evidence_ids")
    if isinstance(raw, str):
        evidence_ids = [raw] if raw.strip() else []
    elif isinstance(raw, list):
        evidence_ids = [str(value).strip() for value in raw if str(value).strip()]
    else:
        evidence_ids = []
    evidence_id = str(item.get("evidence_id") or "").strip()
    if evidence_id and evidence_id not in evidence_ids:
        evidence_ids.append(evidence_id)
    return evidence_ids


def enforce_candidate_evidence_policy(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    hardened: List[Dict[str, Any]] = []
    for raw in candidates:
        item = dict(raw)
        source_type = infer_source_type(item)
        item["source_type"] = source_type
        evidence_ids = normalize_evidence_ids(item)
        item["evidence_ids"] = evidence_ids
        confidence = float(item.get("confidence", 0) or 0)

        if source_type == "llm_memory":
            item["validation_status"] = "rejected"
            item["confidence"] = 0.0
            item["memory_guess_detected"] = True
            item["disallowed_sources_checked"] = True
            item["confidence_cap_reason"] = "source_type=llm_memory is disallowed in blind solve"
        elif not evidence_ids:
            item["validation_status"] = "weak"
            item["confidence"] = min(confidence, 0.3)
            item["memory_guess_detected"] = False
            item["disallowed_sources_checked"] = True
            item["confidence_cap_reason"] = "candidate has no evidence_id"
        elif source_type not in ALLOWED_SOURCE_TYPES:
            item["validation_status"] = "weak"
            item["confidence"] = min(confidence, 0.3)
            item["memory_guess_detected"] = False
            item["disallowed_sources_checked"] = True
            item["confidence_cap_reason"] = f"unrecognized source_type={source_type}"
        else:
            item.setdefault("validation_status", "unverified")
            item["confidence"] = confidence
            item["memory_guess_detected"] = False
            item["disallowed_sources_checked"] = True
            item.setdefault("confidence_cap_reason", "")
        hardened.append(item)

    return sorted(
        hardened,
        key=lambda c: (
            c.get("validation_status") == "rejected",
            not bool(c.get("evidence_ids")),
            -float(c.get("confidence", 0) or 0),
        ),
    )


def best_candidate_has_evidence(candidates: Iterable[Dict[str, Any]]) -> bool:
    items = list(candidates)
    return bool(items and items[0].get("evidence_ids") and items[0].get("source_type") != "llm_memory")

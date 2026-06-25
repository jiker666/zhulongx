from app.core.candidate_policy import best_candidate_has_evidence, enforce_candidate_evidence_policy


def test_candidate_without_evidence_is_capped():
    [candidate] = enforce_candidate_evidence_policy([
        {"candidate": "flag{weak}", "source_type": "tool_output", "confidence": 0.95}
    ])
    assert candidate["validation_status"] == "weak"
    assert candidate["confidence"] == 0.3


def test_llm_memory_candidate_is_rejected():
    [candidate] = enforce_candidate_evidence_policy([
        {"candidate": "flag{remembered}", "source_type": "llm_memory", "evidence_id": "ev-1", "confidence": 0.99}
    ])
    assert candidate["validation_status"] == "rejected"
    assert candidate["confidence"] == 0.0
    assert candidate["memory_guess_detected"] is True


def test_best_candidate_must_have_evidence():
    candidates = enforce_candidate_evidence_policy([
        {"candidate": "flag{guess}", "source_type": "tool_output", "confidence": 0.99},
        {"candidate": "flag{evidence}", "source_type": "decoded_chain", "evidence_id": "ev-2", "confidence": 0.8},
    ])
    assert candidates[0]["candidate"] == "flag{evidence}"
    assert best_candidate_has_evidence(candidates)


def test_string_evidence_ids_are_not_split_into_characters():
    [candidate] = enforce_candidate_evidence_policy([
        {"candidate": "flag{ok}", "source_type": "decoded_chain", "evidence_ids": "ev-3", "confidence": 0.8},
    ])
    assert candidate["evidence_ids"] == ["ev-3"]

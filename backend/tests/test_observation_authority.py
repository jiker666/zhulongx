from app.core.observation_authority import ObservationAuthority, ObservationEnvelope

def test_model_inference_cannot_become_fact():
    auth = ObservationAuthority()
    envelope = ObservationEnvelope(task_id="t", challenge_id="c", source_type="MODEL_INFERENCE", facts=[{"claim": "command succeeded"}])
    assert not auth.accept(envelope, expected_task_id="t", expected_challenge_id="c")

def test_tool_result_requires_real_call_and_matching_task():
    auth = ObservationAuthority()
    missing = ObservationEnvelope(task_id="t", challenge_id="c", source_type="TOOL_RESULT")
    assert not auth.accept(missing, expected_task_id="t", expected_challenge_id="c")
    real = auth.from_tool_result(task_id="t", challenge_id="c", action_id="a", tool_call_id="tc", output="READY")
    assert auth.accept(real, expected_task_id="t", expected_challenge_id="c")
    assert not auth.accept(real, expected_task_id="other", expected_challenge_id="c")

from app.core.competition_runtime import (
    ActionCandidate, CandidateResult, CompetitionController, CompetitionProfile,
    Hypothesis, WebSpecialist, InteractiveSessionManager,
)
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def test_action_scorer_penalizes_repetition():
    controller = CompetitionController()
    action = ActionCandidate(tool_name="list_dir", purpose="inspect")
    first = controller.scorer.score(action, repetition_count=0)
    repeated = controller.scorer.score(action, repetition_count=2)
    assert repeated < first


def test_broker_requires_schema_and_keeps_workspace_isolated(tmp_path):
    controller = CompetitionController()
    state = controller.create_challenge("c1", "ch1", "inspect attachment")
    state.workspace = str(tmp_path)
    result = controller.broker.execute(state, ActionCandidate(tool_name="read_file", purpose="read", tool_arguments={}), CompetitionProfile())
    assert result.success is False
    assert result.error_type == "INVALID_TOOL_ARGUMENT"


def test_candidate_requires_evidence_and_reproduction():
    controller = CompetitionController()
    state = controller.create_challenge("c1", "ch1", "find flag")
    candidate = CandidateResult(task_id=state.task_id, candidate_value="flag{real_output}")
    checked = controller.verifier.verify(state, candidate, r"flag\{[^}]+\}")
    assert checked.verification_status == "rejected"


def test_hypothesis_tracks_evidence_change():
    hypothesis = Hypothesis(title="encoded payload")
    hypothesis.update_evidence("ev_1", True, .2, "decode next")
    assert hypothesis.confidence == .7
    assert hypothesis.supporting_evidence_ids == ["ev_1"]


def test_specialist_proposes_real_registered_inspection_action():
    controller = CompetitionController()
    state = controller.create_challenge("c1", "ch1", "inspect web", category="web")
    action = WebSpecialist().propose_actions(state)[0]
    assert action.tool_name == "list_dir"
    assert WebSpecialist().can_handle(state)


def test_repeated_action_is_blocked(tmp_path):
    controller = CompetitionController(); state = controller.create_challenge("c", "x", "inspect"); state.workspace = str(tmp_path)
    action = ActionCandidate(tool_name="list_dir", purpose="inventory")
    first = controller.broker.execute(state, action, CompetitionProfile())
    assert first.success
    state.decision_history.append(action)
    repeated = controller.broker.execute(state, action, CompetitionProfile())
    assert repeated.error_type == "REPEATED_ACTION"


def test_broker_creates_grounded_observation(tmp_path):
    controller = CompetitionController(); state = controller.create_challenge("c", "x", "inspect"); state.workspace = str(tmp_path)
    result = controller.broker.execute(state, ActionCandidate(tool_name="list_dir", purpose="inventory"), CompetitionProfile())
    assert result.success
    assert state.observations[-1]["source_type"] == "TOOL_RESULT"
    assert state.observations[-1]["verified_origin"] is True
    assert state.evidence[-1].trust_level == "VERIFIED_TOOL_OUTPUT"


def test_tcp_menu_session_round_trip():
    listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen(1); port = listener.getsockname()[1]
    def server():
        conn, _ = listener.accept(); conn.sendall(b"1) hello\n> "); assert conn.recv(32) == b"1\n"; conn.sendall(b"ok\n"); conn.close(); listener.close()
    thread = threading.Thread(target=server); thread.start()
    sessions = InteractiveSessionManager(); sid = sessions.tcp_connect("task", "127.0.0.1", port)
    assert b"hello" in sessions.tcp_receive("task", sid).encode(); sessions.tcp_send("task", sid, "1\n"); assert sessions.tcp_receive("task", sid) == "ok\n"; sessions.close("task", sid); thread.join(2)


def test_http_session_keeps_cookie():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/login": self.send_response(200); self.send_header("Set-Cookie", "token=accepted"); self.end_headers(); self.wfile.write(b"logged in")
            else: self.send_response(200 if "token=accepted" in self.headers.get("Cookie", "") else 403); self.end_headers()
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler); thread = threading.Thread(target=server.serve_forever); thread.start()
    sessions = InteractiveSessionManager(); sid = sessions.http_create("task"); base = f"http://127.0.0.1:{server.server_port}"
    assert sessions.http_request("task", sid, "GET", base + "/login")["status_code"] == 200
    assert sessions.http_request("task", sid, "GET", base + "/private")["status_code"] == 200
    assert sessions.http_export("task", sid)["token"] == "accepted"; sessions.close("task", sid); server.shutdown(); thread.join(2)


def test_pause_resume_cancel_cleans_sessions():
    controller = CompetitionController(); state = controller.create_challenge("c", "x", "inspect"); sid = InteractiveSessionManager()
    controller.pause(state.task_id); assert state.status == "paused"; controller.resume(state.task_id); assert state.status == "running"; controller.cancel(state.task_id); assert state.status == "cancelled"


def test_human_evidence_changes_hypothesis():
    controller = CompetitionController(); state = controller.create_challenge("c", "x", "inspect"); hypothesis = Hypothesis(title="look for encoded data"); state.hypotheses.append(hypothesis)
    controller.add_human_evidence(state.task_id, "attachment likely base64")
    assert hypothesis.confidence > .5

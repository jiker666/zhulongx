import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from app.core.ctf_web_solver import CTFWebSolver
from app.core.scope_guard import RequestBudget, scope_guard


class MockCTFHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/":
            body = b"""
            <html>
              <script src="/app.js"></script>
              <form method="POST" action="/submit">
                <input type="hidden" name="csrf_token" value="demo">
                <input name="answer">
              </form>
            </html>
            """
        elif self.path == "/app.js":
            body = b"fetch('/api/flag').then(r=>r.json())"
        elif self.path == "/api/flag":
            body = b'{"flag":"flag{web_solve_lane}"}'
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002
        return


def start_server():
    server = HTTPServer(("127.0.0.1", 0), MockCTFHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def test_web_solver_rejects_localhost_by_default(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", False)
    monkeypatch.setattr("app.core.scope_guard.settings.DEV_ALLOW_PRIVATE_TARGETS", False)
    scope_guard.budget = RequestBudget()
    result = CTFWebSolver(max_requests=2).solve("http://127.0.0.1:9/")
    assert result["success"] is False
    assert "ScopeGuard blocked" in result["summary"]


def test_web_solver_get_lane_finds_js_api_flag_when_scoped(monkeypatch):
    server = start_server()
    port = server.server_port
    try:
        monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", True)
        monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_LOCALHOST", True)
        monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_PRIVATE_IPS", True)
        monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_CIDRS", "127.0.0.1/32")
        monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_DOMAINS", "localhost")
        monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_PORTS", str(port))
        scope_guard.budget = RequestBudget()
        result = CTFWebSolver(max_requests=5).solve(f"http://127.0.0.1:{port}/")
    finally:
        server.shutdown()

    assert result["success"] is True
    assert any(path == "/api/flag" for path in result["api_paths"])
    assert any(c["candidate"] == "flag{web_solve_lane}" for c in result["answer_candidates"])
    assert result["manual_actions"][0]["requires_confirmation"] is True
    assert len(result["evidence"]) >= 3

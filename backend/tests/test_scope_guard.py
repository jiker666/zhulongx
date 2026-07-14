from app.core.scope_guard import scope_guard
from app.main import app
from fastapi.testclient import TestClient


def test_default_rejects_private_and_non_http(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", False)
    monkeypatch.setattr("app.core.scope_guard.settings.DEV_ALLOW_PRIVATE_TARGETS", False)
    # Deterministic DNS fixture: never depend on the host resolver (which may
    # map example.com to a test/reserved address in CI or enterprise networks).
    monkeypatch.setattr(
        "app.core.scope_guard._resolve_host",
        lambda host: ["93.184.216.34"] if host == "example.com" else [host],
    )
    assert not scope_guard.validate_url("http://10.0.0.1").allowed
    assert not scope_guard.validate_url("file:///etc/passwd").allowed
    assert scope_guard.validate_url("https://example.com").allowed


def test_scope_cidr_domain_and_port(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_PRIVATE_IPS", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_LOCALHOST", False)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_CIDRS", "10.8.0.0/16")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_DOMAINS", "target.test")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_PORTS", "8080")
    monkeypatch.setattr("app.core.scope_guard._resolve_host", lambda host: ["10.8.1.2"] if host == "target.test" else [host])

    assert scope_guard.validate_url("http://10.8.1.2:8080").allowed
    assert scope_guard.validate_url("http://target.test:8080").allowed
    assert not scope_guard.validate_url("http://10.8.1.2:9090").allowed
    assert not scope_guard.validate_url("http://10.9.1.2:8080").allowed


def test_localhost_requires_localhost_flag(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_PRIVATE_IPS", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_LOCALHOST", False)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_CIDRS", "127.0.0.1/32")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_DOMAINS", "localhost")
    assert not scope_guard.validate_url("http://127.0.0.1:8000").allowed
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_LOCALHOST", True)
    assert scope_guard.validate_url("http://127.0.0.1:8000").allowed


def test_scope_check_api(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", False)
    monkeypatch.setattr("app.core.scope_guard.settings.DEV_ALLOW_PRIVATE_TARGETS", False)
    with TestClient(app) as client:
        denied = client.post("/api/scope/check", json={"url": "http://127.0.0.1:8000"})
        assert denied.status_code == 200
        assert denied.json()["allowed"] is False

    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_PRIVATE_IPS", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_ALLOW_LOCALHOST", True)
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_CIDRS", "127.0.0.1/32")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_DOMAINS", "localhost")
    monkeypatch.setattr("app.core.scope_guard.settings.SCOPE_PORTS", "8000")
    with TestClient(app) as client:
        allowed = client.post("/api/scope/check", json={"url": "http://127.0.0.1:8000"})
        assert allowed.status_code == 200
        body = allowed.json()
        assert body["allowed"] is True
        assert body["matched_rule"]

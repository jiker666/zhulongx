import base64
import json
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.tools.http_replay import HttpReplayTool


def test_final_ops_challenge_triage_extracts_candidate(tmp_path: Path):
    archive = tmp_path / "artifact_triage_demo.zip"
    encoded = base64.b64encode(b"flag{final_ops_demo}").decode()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("README.md", f"encoded={encoded}\n")
        zf.writestr("../evil.txt", "flag{zip_slip_should_not_extract}")

    with TestClient(app) as client:
        created = client.post("/api/challenges", json={
            "name": "misc base64 demo",
            "challenge_type": "misc",
            "description": "decode common encodings",
            "uploaded_file": str(archive),
            "assignee": "A",
            "tags": ["final-drill"],
        })
        assert created.status_code == 200, created.text
        challenge_id = created.json()["id"]
        triage = client.post(f"/api/challenges/{challenge_id}/run-triage")
        assert triage.status_code == 200, triage.text
        data = triage.json()
        assert data["task_ids"]
        assert data["evidence"]
        assert any(c["candidate"] == "flag{final_ops_demo}" for c in data["answer_candidates"])
        assert data["status"] == "candidate_found"

        brief = client.get(f"/api/challenges/{challenge_id}/brief")
        assert brief.status_code == 200
        assert "flag{final_ops_demo}" in brief.json()["markdown"]

        debrief = client.get("/api/final-ops/debrief")
        assert debrief.status_code == 200
        assert "total_challenges" in debrief.json()


def test_http_replay_scope_and_confirmation(monkeypatch):
    monkeypatch.setattr("app.core.scope_guard.settings.COMPETITION_MODE", False)
    monkeypatch.setattr("app.core.scope_guard.settings.DEV_ALLOW_PRIVATE_TARGETS", False)
    denied = HttpReplayTool().run({"method": "GET", "url": "http://127.0.0.1:9", "reason": "test"})
    assert denied["success"] is False
    assert denied["details"]["error_type"] == "scope_blocked"

    post = HttpReplayTool().run({"method": "POST", "url": "https://example.com", "reason": "test"})
    assert post["success"] is False
    assert post["details"]["requires_confirmation"] is True


def test_challenge_import_json_and_manual_result():
    with TestClient(app) as client:
        payload = {"challenges": [{"name": "web import", "type": "web", "description": "flag{imported}", "priority": "high"}]}
        imported = client.post("/api/challenges/import", json={"format": "json", "content": json.dumps(payload)})
        assert imported.status_code == 200, imported.text
        challenge_id = imported.json()["challenge_ids"][0]
        manual = client.post(f"/api/challenges/{challenge_id}/manual-result", json={"author": "B", "result": "verified flag{imported}", "validation_status": "accepted"})
        assert manual.status_code == 200, manual.text
        data = manual.json()
        assert data["status"] == "solved"
        assert any(c["candidate"] == "flag{imported}" for c in data["answer_candidates"])

import json

from fastapi.testclient import TestClient

from app.main import app


def test_submission_status_flow_and_debrief_stats():
    with TestClient(app) as client:
        created = client.post("/api/challenges", json={"name": "submit demo", "challenge_type": "misc", "description": "flag{submit_demo}"})
        assert created.status_code == 200, created.text
        cid = created.json()["id"]
        candidate = client.post(f"/api/challenges/{cid}/answer-candidate", json={"candidate": "flag{submit_demo}", "confidence": 0.9})
        assert candidate.status_code == 200, candidate.text
        candidate_id = candidate.json()["id"]

        submitted = client.post(f"/api/challenges/{cid}/submit", json={
            "answer": "flag{submit_demo}",
            "submitter": "C",
            "submission_note": "checked evidence",
            "candidate_id": candidate_id,
        })
        assert submitted.status_code == 200, submitted.text
        body = submitted.json()
        assert body["submit_status"] == "submitted"
        assert body["submitted_answer"] == "flag{submit_demo}"
        assert body["submitter"] == "C"

        rejected = client.patch(f"/api/answer-candidates/{candidate_id}", json={"validation_status": "rejected"})
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()["confidence"] <= 0.15
        challenge = client.get(f"/api/challenges/{cid}").json()
        assert challenge["submit_status"] == "rejected"

        accepted = client.post(f"/api/challenges/{cid}/submit", json={
            "answer": "flag{submit_demo}",
            "submitter": "C",
            "submission_note": "second submit accepted",
            "candidate_id": candidate_id,
            "submit_status": "accepted",
        })
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["submit_status"] == "accepted"

        brief = client.get(f"/api/challenges/{cid}/brief")
        assert "Submission" in brief.json()["markdown"]
        debrief = client.get("/api/final-ops/debrief")
        assert debrief.status_code == 200
        stats = debrief.json()
        assert stats["submitted_count"] >= 1
        assert stats["accepted_count"] >= 1
        assert "average_time_to_submit_seconds" in stats


def test_final_ops_export_import_does_not_leak_keys():
    with TestClient(app) as client:
        created = client.post("/api/challenges", json={"name": "backup demo", "challenge_type": "log", "description": "flag{backup_demo}"})
        assert created.status_code == 200
        before = len(client.get("/api/challenges").json())
        exported = client.get("/api/final-ops/export")
        assert exported.status_code == 200, exported.text
        data = exported.json()
        raw = json.dumps(data, ensure_ascii=False)
        assert "LLM_API_KEY" not in raw
        assert "replace_me" not in raw
        assert ".env" not in raw
        assert data["challenges"]

        imported = client.post("/api/final-ops/import", json={"data": data})
        assert imported.status_code == 200, imported.text
        after = len(client.get("/api/challenges").json())
        assert after == before

from dataclasses import asdict

from app.scenarios.ctf.adapter import CTFRunRequestAdapter


def test_legacy_ctf_adapter_drops_expected_answer_and_requires_network_scope(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    attachment = workspace / "challenge.txt"
    attachment.write_text("challenge material", encoding="utf-8")
    task = {
        "task_id": "ctf_adapter_test",
        "title": "Adapter test",
        "description": "Analyze the supplied challenge.",
        "attachments": ["/legacy/uploads/challenge.txt", "/legacy/uploads/expected_flag.txt"],
        "authorized": True,
        "allow_network": True,
        "max_rounds": 8,
        "max_time_sec": 120,
        "expected_flag": "flag{must_not_cross_boundary}",
    }

    request = CTFRunRequestAdapter().adapt(task, workspace=workspace)
    serialized = str(asdict(request))

    assert request.scenario == "ctf"
    assert [item.name for item in request.inputs] == ["challenge.txt"]
    assert request.network_policy.mode == "deny"
    assert "must_not_cross_boundary" not in serialized
    assert "expected_flag" not in serialized


def test_legacy_ctf_adapter_enables_only_explicit_allowlist(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = CTFRunRequestAdapter().adapt(
        {
            "task_id": "scoped",
            "authorized": True,
            "allow_network": True,
        },
        workspace=workspace,
        allowed_hosts=("challenge.example",),
        allowed_ports=(443,),
    )

    assert request.network_policy.mode == "allowlist"
    assert request.network_policy.allowed_hosts == ("challenge.example",)
    assert request.network_policy.allowed_ports == (443,)

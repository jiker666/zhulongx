from app.agent_engine.events import EventType
from app.agent_engine.providers.base import AssistantTurn, ProviderToolCall
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.skills.index import SkillIndex
from app.agent_engine.skills.loader import SkillLoader
from app.agent_engine.state import RunRequest, RunStatus
from app.agent_engine.validation.base import PredicateValidator


def test_skill_body_is_disclosed_only_after_load_tool(tmp_path):
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "crypto"
    skill_dir.mkdir(parents=True)
    marker = "FULL_SKILL_BODY_MARKER_9f47"
    (skill_dir / "SKILL.md").write_text(
        "# Crypto Workflow\n\nUse this skill for offline cryptography analysis.\n\n## Detailed steps\n\n" + marker,
        encoding="utf-8",
    )
    index = SkillIndex.scan(skills_root)
    loader = SkillLoader(index)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    def submit_after_load(messages, tools):
        assert marker in str(messages)
        return AssistantTurn(
            text="skill loaded; submit result",
            tool_calls=(ProviderToolCall("candidate_1", "submit_candidate", {"candidate": "flag{skill_loaded}"}),),
            finish_reason="tool_calls",
        )

    provider = ScriptedProvider([
        AssistantTurn(
            text="load the relevant skill",
            tool_calls=(ProviderToolCall("skill_1", "load_skill", {"name": "crypto"}),),
            finish_reason="tool_calls",
        ),
        submit_after_load,
    ])
    request = RunRequest(
        task_id="task_skill",
        title="Progressive skill test",
        objective="Load the relevant workflow and return the result.",
        workspace=str(workspace),
        scenario="ctf",
        authorization={"authorized": True, "allow_process": False},
    )
    session = AgentSession(
        request,
        provider=provider,
        validator=PredicateValidator(lambda value: value == "flag{skill_loaded}"),
        sandbox=LocalTestSandbox(workspace),
        skill_index=index,
        skill_loader=loader,
    )

    state = session.run()

    assert state.status == RunStatus.SUCCEEDED
    assert marker not in str(provider.requests[0]["messages"])
    assert "Use this skill for offline cryptography analysis." in str(provider.requests[0]["messages"])
    assert EventType.SKILL_LOADED.value in [event.type for event in session.event_stream()]

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.database import Base
from app.models import competition_runtime  # noqa: F401
from app.core.resource_service import ResourceService
from app.core.runtime_repository import RuntimeRepository
from app.core.replay_service import ReplayService

@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try: yield session
    finally: session.close(); engine.dispose()

def test_execution_resource_persists_and_terminal_state_is_sticky(db):
    service = ResourceService()
    row = service.create(db, competition_id="c", challenge_id="ch", task_id="t", resource_type="PTY_SESSION", external_id="pty-1", status="ACTIVE")
    closed = service.transition(db, row.id, task_id="t", status="CLOSED", expected_version=1)
    assert closed.status == "CLOSED" and closed.version == 2
    with pytest.raises(RuntimeError): service.transition(db, row.id, task_id="t", status="ACTIVE")
    with pytest.raises(KeyError): service.transition(db, row.id, task_id="other", status="CLOSED")

def test_trace_sequence_and_replay_without_memory(db):
    repo = RuntimeRepository()
    repo.append_trace(db, competition_id="c", challenge_id="ch", task_id="t", event_type="task_created", state_delta={"status": "created"})
    repo.append_trace(db, competition_id="c", challenge_id="ch", task_id="t", event_type="task_cancelled", state_delta={"status": "cancelled", "resources": []})
    rows = repo.list_trace(db, "ch")
    assert [row.sequence_number for row in rows] == [1, 2]
    assert ReplayService(repo).replay_challenge(db, "ch")["status"] == "cancelled"
    assert ReplayService(repo).state_at_sequence(db, "ch", 1)["status"] == "created"

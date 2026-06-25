import os
import tempfile
from pathlib import Path

import pytest


TEST_ROOT = Path(tempfile.mkdtemp(prefix="cyberpilot-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_ROOT / 'test.db'}"
os.environ["UPLOAD_DIR"] = str(TEST_ROOT / "uploads")
os.environ["REPORT_DIR"] = str(TEST_ROOT / "reports")
os.environ["LLM_ENABLED"] = "false"
os.environ["APP_ENV"] = "dev"
os.environ["COMPETITION_MODE"] = "true"
os.environ["SCOPE_ALLOW_LOCALHOST"] = "true"
os.environ["SCOPE_ALLOW_PRIVATE_IPS"] = "true"
os.environ["SCOPE_CIDRS"] = "127.0.0.1/32"
os.environ["SCOPE_DOMAINS"] = "localhost"
os.environ["SCOPE_PORTS"] = ""
# CTF demos path
os.environ["CTF_DEMO_DIR"] = str(
    Path(__file__).resolve().parent.parent.parent / "examples" / "ctf_demo"
)
os.environ["CTF_RUN_DIR"] = str(TEST_ROOT / "ctf_runs")


@pytest.fixture(autouse=True)
def reset_db():
    from app.database import Base, engine, init_db
    from app.core.tool_registry import tool_registry

    Base.metadata.drop_all(bind=engine)
    init_db()
    tool_registry.sync_to_db()
    yield

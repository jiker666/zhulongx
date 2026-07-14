from pathlib import Path
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import settings


DATABASE_URL = settings.DATABASE_URL


def _ensure_sqlite_parent(database_url: str) -> None:
    if not database_url.startswith("sqlite:///"):
        return
    raw_path = database_url.replace("sqlite:///", "", 1)
    if raw_path in (":memory:", ""):
        return
    db_path = Path(raw_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)


_ensure_sqlite_parent(DATABASE_URL)

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate_db():
    """Add new columns to existing tables without breaking old data."""
    new_columns = {
        "tasks": [
            ("uploaded_file", "VARCHAR(512) DEFAULT ''"),
            ("challenge_id", "INTEGER DEFAULT NULL"),
            ("intent_result", "TEXT DEFAULT ''"),
            ("plan_source", "VARCHAR(32) DEFAULT 'rule'"),
            ("llm_enabled", "BOOLEAN DEFAULT 0"),
            ("llm_model", "VARCHAR(128) DEFAULT ''"),
        ],
        "steps": [
            ("plan_source", "VARCHAR(32) DEFAULT 'rule'"),
            ("risk_level", "VARCHAR(32) DEFAULT 'low'"),
            ("confidence", "FLOAT DEFAULT 1.0"),
            ("requires_confirmation", "BOOLEAN DEFAULT 0"),
            ("decision_trace", "TEXT DEFAULT ''"),
        ],
        "tools": [
            ("permissions", "TEXT DEFAULT '[]'"),
            ("risk_level", "VARCHAR(32) DEFAULT 'low'"),
            ("timeout_seconds", "INTEGER DEFAULT 30"),
            ("tags", "TEXT DEFAULT '[]'"),
        ],
        "challenges": [
            ("submit_status", "VARCHAR(32) DEFAULT 'not_submitted'"),
            ("submitted_answer", "TEXT DEFAULT ''"),
            ("submitted_at", "DATETIME DEFAULT NULL"),
            ("submission_note", "TEXT DEFAULT ''"),
        ],
        "ctf_tasks": [
            ("plan_json", "TEXT DEFAULT ''"),
            ("analysis_json", "TEXT DEFAULT ''"),
            ("current_script", "TEXT DEFAULT ''"),
            ("best_flag", "VARCHAR(256)"),
            ("writeup_path", "VARCHAR(512) DEFAULT ''"),
            ("writeup_md", "TEXT DEFAULT ''"),
            ("error", "TEXT DEFAULT ''"),
            ("is_running", "BOOLEAN DEFAULT 0"),
            ("started_at", "DATETIME"),
            ("finished_at", "DATETIME"),
            ("source", "VARCHAR(32) DEFAULT 'api'"),
            ("demo_id", "VARCHAR(64)"),
            ("expected_flag", "VARCHAR(256)"),
            ("allowed_hosts", "TEXT DEFAULT '[]'"),
            ("allowed_ports", "TEXT DEFAULT '[]'"),
            ("max_time_sec", "INTEGER DEFAULT 600"),
            ("engine", "VARCHAR(32) DEFAULT 'legacy'"),
            ("agent_run_id", "VARCHAR(96)"),
            ("agent_workspace", "VARCHAR(1024)"),
        ],
    }
    with engine.connect() as conn:
        for table, cols in new_columns.items():
            for col_name, col_def in cols:
                try:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_def}"))
                    conn.commit()
                except Exception:
                    # Column already exists - expected on re-run
                    pass


def init_db():
    from app.models import (  # noqa: F401
        task, step, report, tool, challenge, evidence, answer_candidate,
        challenge_note, ctf, blackboard,
    )
    Base.metadata.create_all(bind=engine)
    _migrate_db()

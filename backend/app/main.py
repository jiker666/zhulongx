"""
烛龙·玄枢 ZHULONG-X Backend - FastAPI Application Entry Point
面向 CTF 实战的自主决策通用安全智能体。
"""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.database import SessionLocal, init_db
from app.api.tasks import router as tasks_router
from app.api.tools import router as tools_router
from app.api.reports import router as reports_router
from app.api.upload import router as upload_router
from app.api.llm import router as llm_router
from app.api.ws import router as ws_router
from app.api.challenges import router as challenges_router
from app.api.ctf import router as ctf_router
from app.api.settings import router as settings_router
from app.api.competition import router as competition_router
from app.config import settings
from app.core.scope_guard import scope_guard


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    from app.core.tool_registry import tool_registry
    tool_registry.sync_to_db()
    from app.core.runtime_config import load_runtime_config_on_startup
    load_runtime_config_on_startup()
    _cleanup_ghost_tasks()
    yield


def _cleanup_ghost_tasks():
    import datetime
    from app.database import SessionLocal
    from app.models.ctf import CtfTask as CtfTaskModel
    try:
        db = SessionLocal()
        ghosts = db.query(CtfTaskModel).filter(CtfTaskModel.is_running == True).all()
        for g in ghosts:
            g.is_running = False
            g.state = "HUMAN_REQUIRED"
            g.error = "服务重启，任务已中断"
            g.finished_at = datetime.datetime.utcnow()
        if ghosts:
            db.commit()
        db.close()
    except Exception:
        pass


app = FastAPI(
    title="烛龙·玄枢 ZHULONG-X API",
    description="面向 CTF 实战的自主决策通用安全智能体 - 仅用于授权安全测试",
    version="5.0.0-zhulongx",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(tasks_router, prefix="/api")
app.include_router(tools_router, prefix="/api")
app.include_router(reports_router, prefix="/api")
app.include_router(upload_router, prefix="/api")
app.include_router(llm_router, prefix="/api")
app.include_router(challenges_router, prefix="/api")
app.include_router(ctf_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(competition_router, prefix="/api")
app.include_router(ws_router)   # WS route already has /ws prefix


@app.get("/api/health")
def health():
    database = "ok"
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
    except Exception as exc:
        database = f"error: {type(exc).__name__}"

    storage_status = {}
    for label, raw_path in {"uploads": settings.UPLOAD_DIR, "reports": settings.REPORT_DIR}.items():
        path = Path(raw_path)
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".healthcheck"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            storage_status[label] = "writable"
        except Exception as exc:
            storage_status[label] = f"error: {type(exc).__name__}"

    from app.core.tool_registry import tool_registry

    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "tagline": settings.APP_TAGLINE,
        "version": "5.0.0-zhulongx",
        "database": database,
        "enabled_tools_count": len(tool_registry.all_names()),
        "storage": storage_status,
        "llm_enabled": settings.LLM_ENABLED,
        "scope_config_summary": scope_guard.summary(),
        "llm": {
            "enabled": settings.LLM_ENABLED,
            "provider": settings.LLM_PROVIDER,
            "model": settings.LLM_MODEL,
            "base_url_host": settings.LLM_BASE_URL.split("//")[-1].split("/")[0] if settings.LLM_BASE_URL else "",
            "api_key_configured": bool(settings.LLM_API_KEY and settings.LLM_API_KEY != "replace_me"),
        },
    }


@app.get("/api/version")
def version():
    return {
        "app": settings.APP_NAME,
        "tagline": settings.APP_TAGLINE,
        "version": "5.0.0-zhulongx",
        "edition": "烛龙·玄枢 v5 - 自主决策通用安全智能体",
    }


@app.get("/api/docs", include_in_schema=False)
def api_docs_redirect():
    return RedirectResponse(url="/docs")

"""
Settings API — 运行时配置管理接口（v6.1）。

Endpoints:
- GET  /api/settings/llm          获取当前 LLM 配置（脱敏，key 只返回 configured 状态）
- PUT  /api/settings/llm          更新 LLM 配置（key 留空=不变）
- GET  /api/settings/audit         获取配置变更审计日志
- POST /api/settings/reset        清空 runtime_config，恢复 .env 默认

安全：
- API key 永不明文返回（前端只看到 "(configured, length=N)" 或 "(not configured)"）
- API key 字段留空提交 = 保持原值
- 危险字段（关闭 router）需要二次确认 header
- 所有变更写审计日志
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.core.runtime_config import get_runtime_config, EDITABLE_FIELDS


router = APIRouter(prefix="/settings", tags=["settings"])


# ---------- schemas ----------


class LlmSettingsUpdate(BaseModel):
    """LLM 配置更新请求。敏感字段（API key）留空=保持不变。"""
    # Router
    LLM_ROUTER_ENABLED: Optional[bool] = None
    LLM_BUDGET_PER_TASK_USD: Optional[float] = None
    LLM_BUDGET_DAILY_USD: Optional[float] = None
    LLM_COMPRESS_THRESHOLD_CHARS: Optional[int] = None
    # Global
    LLM_ENABLED: Optional[bool] = None
    LLM_TIMEOUT: Optional[int] = None
    LLM_MAX_RETRIES: Optional[int] = None
    # Cheap lane
    LLM_CHEAP_PROVIDER: Optional[str] = None
    LLM_CHEAP_BASE_URL: Optional[str] = None
    LLM_CHEAP_MODEL: Optional[str] = None
    LLM_CHEAP_API_KEY: Optional[str] = Field(None, description="留空=保持不变；填了=更新")
    LLM_CHEAP_MAX_TOKENS: Optional[int] = None
    LLM_CHEAP_TEMPERATURE: Optional[float] = None
    # Expert lane
    LLM_EXPERT_PROVIDER: Optional[str] = None
    LLM_EXPERT_BASE_URL: Optional[str] = None
    LLM_EXPERT_MODEL: Optional[str] = None
    LLM_EXPERT_API_KEY: Optional[str] = Field(None, description="留空=保持不变；填了=更新")
    LLM_EXPERT_MAX_TOKENS: Optional[int] = None
    LLM_EXPERT_TEMPERATURE: Optional[float] = None
    # Fallback lane
    LLM_FALLBACK_PROVIDER: Optional[str] = None
    LLM_FALLBACK_BASE_URL: Optional[str] = None
    LLM_FALLBACK_MODEL: Optional[str] = None
    LLM_FALLBACK_API_KEY: Optional[str] = Field(None, description="留空=保持不变；填了=更新")


# ---------- endpoints ----------


@router.get("/llm")
def get_llm_settings():
    """获取当前 LLM 配置（脱敏，API key 只返回 configured 状态）。"""
    rc = get_runtime_config()
    return rc.snapshot()


@router.put("/llm")
def update_llm_settings(
    payload: LlmSettingsUpdate,
    x_confirm_dangerous: Optional[str] = Header(None, alias="X-Confirm-Dangerous"),
):
    """更新 LLM 配置。

    安全规则：
    - API key 字段留空 = 保持原值
    - API key 字段填值 = 更新（写入 runtime_config.json）
    - 关闭 LLM_ROUTER_ENABLED 需要前端发 X-Confirm-Dangerous: yes
    - 所有变更写审计日志
    """
    updates = payload.model_dump(exclude_unset=True)  # 只取用户显式传入的字段

    # 危险操作二次确认
    if updates.get("LLM_ROUTER_ENABLED") is False and x_confirm_dangerous != "yes":
        raise HTTPException(
            400,
            "关闭 LLM_ROUTER_ENABLED 是危险操作，需在请求头加 X-Confirm-Dangerous: yes",
        )

    rc = get_runtime_config()
    result = rc.update(updates, actor="api")

    # 重建 LLM adapter 单例以应用新配置
    import app.core.llm_adapter as la_mod
    la_mod._adapter = None
    import app.core.model_router as mr_mod
    mr_mod._router = None

    return {
        "ok": True,
        "applied": result["applied"],
        "skipped": result["skipped"],
        "note": "配置已热重载，无需重启后端",
    }


@router.get("/audit")
def get_settings_audit(limit: int = 50):
    """获取配置变更审计日志。"""
    rc = get_runtime_config()
    return {"entries": rc.get_audit_log(limit=limit)}


@router.post("/reset")
def reset_runtime_config(x_confirm_dangerous: Optional[str] = Header(None, alias="X-Confirm-Dangerous")):
    """清空 runtime_config.json，恢复到 .env 默认配置。"""
    if x_confirm_dangerous != "yes":
        raise HTTPException(400, "需在请求头加 X-Confirm-Dangerous: yes")
    rc = get_runtime_config()
    rc.reset()
    rc._audit("api", "RESET", "runtime_config.json", None)
    # 重建单例
    import app.core.llm_adapter as la_mod
    la_mod._adapter = None
    import app.core.model_router as mr_mod
    mr_mod._router = None
    return {"ok": True, "note": "runtime_config 已清空，重启后端后恢复 .env 默认"}


@router.get("/fields")
def list_editable_fields():
    """列出所有可编辑字段及其元数据（供前端动态生成表单）。"""
    return {
        "fields": [
            {
                "key": k,
                "type": v["type"],
                "sensitive": v["sensitive"],
                "lane": v["lane"],
            }
            for k, v in EDITABLE_FIELDS.items()
        ]
    }

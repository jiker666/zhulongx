"""
Tools API - returns merged DB + ToolRegistry data
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.tool_registry import tool_registry
from app.database import get_db
from app.models.tool import Tool as ToolModel

router = APIRouter()


class ToolEnabledUpdate(BaseModel):
    enabled: bool


@router.get("/tools")
def list_tools(db: Session = Depends(get_db)):
    """Return DB tools merged with live registry state."""
    registry_tools = {t["name"]: t for t in tool_registry.list_tools()}

    # Get DB entries
    db_tools = db.query(ToolModel).all()
    db_map = {t.name: t for t in db_tools}

    results = []
    for name, reg_info in registry_tools.items():
        db_entry = db_map.get(name)
        results.append({
            "name": name,
            "description": reg_info["description"],
            "category": reg_info["category"],
            "enabled": db_entry.enabled if db_entry else reg_info["enabled"],
            "input_schema": reg_info.get("input_schema", ""),
            "output_schema": reg_info.get("output_schema", ""),
            "permissions": reg_info.get("permissions", "[]"),
            "risk_level": reg_info.get("risk_level", "low"),
            "timeout_seconds": reg_info.get("timeout_seconds", 30),
            "tags": reg_info.get("tags", "[]"),
        })
    return results


@router.patch("/tools/{name}/enabled")
def set_tool_enabled(name: str, payload: ToolEnabledUpdate, db: Session = Depends(get_db)):
    """Enable or disable a registered tool."""
    if name not in tool_registry._tools:
        raise HTTPException(status_code=404, detail="Tool not found")

    tool = db.query(ToolModel).filter(ToolModel.name == name).first()
    if not tool:
        reg_info = next((t for t in tool_registry.list_tools() if t["name"] == name), None)
        if not reg_info:
            raise HTTPException(status_code=404, detail="Tool not found")
        tool = ToolModel(**reg_info)
        db.add(tool)
    tool.enabled = payload.enabled
    db.commit()
    db.refresh(tool)
    return {"name": tool.name, "enabled": tool.enabled}

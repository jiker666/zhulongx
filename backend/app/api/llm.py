"""
LLM API - status check and connection test
"""
from fastapi import APIRouter
from app.core.llm_client import llm_client

router = APIRouter()


@router.get("/llm/status")
def llm_status():
    return llm_client.get_status()


@router.post("/llm/test")
def llm_test():
    if not llm_client.enabled:
        return {
            "success": False,
            "message": "LLM is disabled (LLM_ENABLED=false). Enable it in .env to test.",
            "model": llm_client.model,
        }
    result = llm_client.test_connection()
    return {
        "success": result["success"],
        "message": result["content"] if result["success"] else result["error"],
        "model": result["model"],
        "usage": result.get("usage", {}),
        "attempts": result.get("attempts", 1),
    }

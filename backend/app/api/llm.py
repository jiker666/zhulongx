"""
LLM API - status check and connection test.

统一使用 LLMAdapter（与 orchestrator 同源），支持 OpenAI 和 Anthropic Messages API
两种协议，且 runtime_config 更新后会自动重建单例，前端测试连接能立刻反映新配置。
"""
from fastapi import APIRouter

from app.core.llm_adapter import get_adapter, mask_sensitive_in_text

router = APIRouter()


@router.get("/llm/status")
def llm_status():
    """返回当前 LLM 状态（脱敏，key 只返回 configured 状态）。"""
    adapter = get_adapter()
    # 重建一个 adapter 以读取最新 settings（runtime_config 更新后 get_adapter() 已会重建）
    return adapter.get_status()


@router.post("/llm/test")
def llm_test():
    """测试 LLM 连接：发一条极短的 ping 请求，验证 base_url/key/model 可用。"""
    adapter = get_adapter()
    if not adapter.enabled:
        return {
            "success": False,
            "message": "LLM is disabled. 请在 Settings 页启用 LLM 并配置 API Key。",
            "model": adapter.model,
            "mode": adapter.mode if hasattr(adapter, "mode") else "disabled",
        }
    if adapter.mock_mode:
        return {
            "success": True,
            "message": "mock 模式：无需真实 key，本地规则生成响应（仅适合跑 demo，不能解真题）",
            "model": adapter.model,
            "mode": "mock",
        }
    # 发一条最小请求验证连接
    resp = adapter.chat(
        [{"role": "user", "content": "ping"}],
        max_tokens=16,
        temperature=0.0,
    )
    if not resp.success:
        return {
            "success": False,
            "message": f"连接失败: {resp.error or 'unknown error'}",
            "model": adapter.model,
            "mode": resp.mode,
            "attempts": resp.attempts,
            "elapsed_ms": resp.elapsed_ms,
        }
    return {
        "success": True,
        "message": f"连接成功（provider={adapter.provider}, model={adapter.model}）",
        "model": resp.model or adapter.model,
        "mode": resp.mode,
        "usage": resp.usage,
        "attempts": resp.attempts,
        "elapsed_ms": resp.elapsed_ms,
    }

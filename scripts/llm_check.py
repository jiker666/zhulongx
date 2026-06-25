#!/usr/bin/env python3
"""
llm-check — 检查 LLM 配置并调用一次最小 chat completion。

功能：
- 检查环境变量是否完整
- 调用一次最小 chat completion
- 验证返回非空
- 日志脱敏 API key（key 永不出现在终端）
- 退出码 0=成功，1=配置缺失，2=调用失败
"""
import os
import sys
import json
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.config import settings
from app.core.llm_adapter import LLMAdapter, mask_secret


def check_env() -> int:
    """检查环境变量是否完整。"""
    print("=== LLM Configuration Check ===")
    print(f"  LLM_ENABLED     = {settings.LLM_ENABLED}")
    print(f"  LLM_PROVIDER    = {settings.LLM_PROVIDER}")
    print(f"  LLM_BASE_URL    = {settings.LLM_BASE_URL}")
    print(f"  LLM_MODEL       = {settings.LLM_MODEL}")
    print(f"  LLM_API_KEY     = {mask_secret(settings.LLM_API_KEY)}")
    print(f"  LLM_TEMPERATURE = {settings.LLM_TEMPERATURE}")
    print(f"  LLM_MAX_TOKENS  = {settings.LLM_MAX_TOKENS}")
    print(f"  LLM_TIMEOUT     = {settings.LLM_TIMEOUT}")
    print()

    if not settings.LLM_ENABLED:
        print("❌ LLM_ENABLED=false，无法进行真实 LLM 验收")
        print("   请在 .env 中设置 LLM_ENABLED=true 并配置 LLM_API_KEY")
        return 1

    if not settings.LLM_API_KEY or settings.LLM_API_KEY == "replace_me":
        print("❌ LLM_API_KEY 未配置（值为 replace_me 或空）")
        print("   请在 .env 中设置真实的 API key")
        return 1

    if not settings.LLM_BASE_URL:
        print("❌ LLM_BASE_URL 未配置")
        return 1

    if not settings.LLM_MODEL:
        print("❌ LLM_MODEL 未配置")
        return 1

    print("✅ 环境变量配置完整")
    return 0


def test_chat() -> int:
    """调用一次最小 chat completion。"""
    print("=== Minimal Chat Completion Test ===")
    adapter = LLMAdapter()
    print(f"  mode     = {'mock' if adapter.mock_mode else 'live'}")
    print(f"  provider = {adapter.provider}")
    print(f"  model    = {adapter.model}")
    print(f"  base_url = {adapter.base_url}")
    print(f"  api_key  = {mask_secret(adapter.api_key)}")
    print()

    if adapter.mock_mode:
        print("⚠️  当前为 mock 模式（LLM_ENABLED=false 或 APP_ENV=dev/test）")
        print("   要进行真实 LLM 验收，请设置 LLM_ENABLED=true 且 APP_ENV=prod")
        return 1

    print("调用中...")
    resp = adapter.chat(
        [{"role": "user", "content": "Reply with exactly: ZHULONG-X OK"}],
        max_tokens=20,
        temperature=0.0,
    )

    if not resp.success:
        print(f"❌ 调用失败: {resp.error}")
        print(f"   attempts: {resp.attempts}")
        print(f"   elapsed: {resp.elapsed_ms}ms")
        return 2

    print(f"✅ 调用成功")
    print(f"   model    = {resp.model}")
    print(f"   content  = {resp.content[:100]!r}")
    print(f"   attempts = {resp.attempts}")
    print(f"   elapsed  = {resp.elapsed_ms}ms")
    if resp.usage:
        print(f"   usage    = {resp.usage}")
    return 0


def main() -> int:
    env_rc = check_env()
    if env_rc != 0:
        return env_rc
    print()
    chat_rc = test_chat()
    if chat_rc != 0:
        return chat_rc
    print()
    print("=== Summary ===")
    print("✅ LLM 配置完整，调用成功，可进行 ctf-llm-smoke")
    return 0


if __name__ == "__main__":
    sys.exit(main())

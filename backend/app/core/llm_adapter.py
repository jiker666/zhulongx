"""
LLM Adapter — 烛龙·玄枢 的统一大模型适配层。

功能：
- OpenAI-compatible chat/completions 调用（OpenAI / Codex / DeepSeek / Qwen / GLM / Moonshot / OneAPI）
- 支持流式和非流式
- 支持 system / developer / tool result 三类 prompt
- 支持 JSON 输出模式
- 支持 mock 模式（不调用任何外部 API，用于演示/CI）
- 支持失败重试 + 指数退避
- API key 脱敏日志（key 永不出现在日志/报告里）
- 支持国产模型兼容模式（自动加 system / 转换 developer 角色）

环境变量：
LLM_ENABLED=true/false
LLM_PROVIDER=openai_compatible|mock
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TEMPERATURE=0.2
LLM_MAX_TOKENS=4096
LLM_TIMEOUT=60
LLM_MAX_RETRIES=2
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


# 已知国产兼容模型映射（部分模型不认 developer 角色）
PROVIDER_COMPAT: Dict[str, Dict[str, Any]] = {
    "deepseek": {"supports_developer": True, "supports_json_mode": True, "api_style": "openai"},
    "qwen": {"supports_developer": False, "supports_json_mode": True, "api_style": "openai"},
    "glm": {"supports_developer": False, "supports_json_mode": True, "api_style": "openai"},
    "moonshot": {"supports_developer": False, "supports_json_mode": True, "api_style": "openai"},
    "kimi": {"supports_developer": False, "supports_json_mode": True, "api_style": "openai"},
    "oneapi": {"supports_developer": True, "supports_json_mode": True, "api_style": "openai"},
    "openai": {"supports_developer": True, "supports_json_mode": True, "api_style": "openai"},
    "codex": {"supports_developer": True, "supports_json_mode": True, "api_style": "openai"},
    # Anthropic Messages API（晚晴网关 / Claude 官方 / AWS Bedrock 等）
    "wanqing": {"supports_developer": False, "supports_json_mode": False, "api_style": "anthropic"},
    "anthropic": {"supports_developer": False, "supports_json_mode": False, "api_style": "anthropic"},
    "claude": {"supports_developer": False, "supports_json_mode": False, "api_style": "anthropic"},
}


def mask_secret(value: Optional[str], keep_head: int = 4, keep_tail: int = 4) -> str:
    if not value or value == "replace_me":
        return "(not configured)"
    if len(value) <= keep_head + keep_tail:
        return "****"
    return value[:keep_head] + "****" + value[-keep_tail:]


def detect_provider(model_name: str, base_url: str = "") -> str:
    """根据模型名/base_url 推断 provider，用于选择兼容模式。"""
    text = (model_name + " " + base_url).lower()
    for key in PROVIDER_COMPAT:
        if key in text:
            return key
    return "openai"


def sanitize_messages_for_provider(
    messages: List[Dict[str, str]],
    provider: str,
) -> List[Dict[str, str]]:
    """根据 provider 兼容性整理 messages：
    - 不支持 developer 的：合并 developer + system
    - 去掉空内容
    """
    compat = PROVIDER_COMPAT.get(provider, PROVIDER_COMPAT["openai"])
    out: List[Dict[str, str]] = []
    sys_buf: List[str] = []

    for m in messages:
        role = m.get("role", "user")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "developer" and not compat.get("supports_developer", True):
            sys_buf.append(content)
            continue
        if role == "system":
            sys_buf.append(content)
            continue
        out.append({"role": role, "content": content})

    if sys_buf:
        out.insert(0, {"role": "system", "content": "\n\n".join(sys_buf)})

    # 至少要有一条 user / assistant 消息
    if not out:
        out.append({"role": "user", "content": "(empty)"})
    return out


def mask_sensitive_in_text(text: str) -> str:
    """脱敏文本中可能存在的 token / key。"""
    if not text:
        return text
    # API key 风格 sk-xxx
    text = re.sub(r"sk-[A-Za-z0-9_\-]{12,}", "sk-****MASKED", text)
    # Bearer xxx
    text = re.sub(r"(?i)bearer\s+[A-Za-z0-9_\-\.]{16,}", "bearer ****MASKED", text)
    # JWT 三段式
    text = re.sub(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", "eyJ****MASKED", text)
    return text


@dataclass
class LLMResponse:
    success: bool
    content: str
    model: str
    usage: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    attempts: int = 0
    elapsed_ms: int = 0
    mode: str = "live"  # live | mock | disabled

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "content": self.content,
            "model": self.model,
            "usage": self.usage,
            "error": self.error,
            "attempts": self.attempts,
            "elapsed_ms": self.elapsed_ms,
            "mode": self.mode,
        }


class LLMAdapter:
    """OpenAI-compatible LLM Adapter with mock mode and provider compat."""

    def __init__(
        self,
        *,
        enabled: Optional[bool] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        timeout: Optional[int] = None,
        max_retries: Optional[int] = None,
        provider: Optional[str] = None,
    ) -> None:
        self.enabled = settings.LLM_ENABLED if enabled is None else enabled
        self.base_url = (base_url or settings.LLM_BASE_URL).rstrip("/")
        self.api_key = api_key or settings.LLM_API_KEY
        self.model = model or settings.LLM_MODEL
        self.temperature = settings.LLM_TEMPERATURE if temperature is None else temperature
        self.max_tokens = settings.LLM_MAX_TOKENS if max_tokens is None else max_tokens
        self.timeout = settings.LLM_TIMEOUT if timeout is None else timeout
        self.max_retries = settings.LLM_MAX_RETRIES if max_retries is None else max_retries
        # provider 自动检测
        self.provider = provider or detect_provider(self.model, self.base_url)
        # mock 模式：当 provider=mock 或未配置 key 且未启用
        self.mock_mode = (self.provider == "mock") or (
            not self.enabled and settings.APP_ENV in ("dev", "demo", "test")
        )
        self.last_success: Optional[float] = None
        self.last_error: str = ""

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _is_anthropic_style(self) -> bool:
        """是否使用 Anthropic Messages API 协议。"""
        compat = PROVIDER_COMPAT.get(self.provider, {})
        return compat.get("api_style") == "anthropic"

    def _masked_key(self) -> str:
        return mask_secret(self.api_key)

    @property
    def mode(self) -> str:
        """当前模式：live / mock / disabled。"""
        if self.mock_mode:
            return "mock"
        if not self.enabled:
            return "disabled"
        return "live"

    def get_status(self) -> Dict[str, Any]:
        """返回当前 LLM 状态（脱敏，key 只返回 configured 状态）。"""
        parsed = urlparse(self.base_url)
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "provider": self.provider,
            "base_url": self.base_url,
            "base_url_host": parsed.netloc or self.base_url,
            "api_key_configured": bool(self.api_key and self.api_key != "replace_me"),
            "model": self.model,
            "timeout": self.timeout,
            "max_retries": self.max_retries,
            "last_success": self.last_success,
            "last_error": self.last_error or "",
        }

    def _build_payload(
        self,
        messages: List[Dict[str, str]],
        *,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        json_mode: bool = False,
        stream: bool = False,
    ) -> Dict[str, Any]:
        clean = sanitize_messages_for_provider(messages, self.provider)
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": clean,
            "max_tokens": max_tokens or self.max_tokens,
            "temperature": temperature if temperature is not None else self.temperature,
            "stream": stream,
        }
        compat = PROVIDER_COMPAT.get(self.provider, PROVIDER_COMPAT["openai"])
        if json_mode and compat.get("supports_json_mode", True):
            payload["response_format"] = {"type": "json_object"}
        return payload

    def _mock_complete(
        self,
        messages: List[Dict[str, str]],
        *,
        json_mode: bool = False,
    ) -> LLMResponse:
        """本地 mock 响应：基于规则生成结构化回复，无需任何外部 API。"""
        last_user = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user = m.get("content", "")
                break
        # 启发式 mock：根据用户输入关键字返回不同内容
        lowered = last_user.lower()
        sys = next((m["content"] for m in messages if m.get("role") == "system"), "")

        # 代码生成 / 修复 优先（这类请求最具体）
        if "solve.py" in lowered or "解题脚本" in lowered or "生成一个 python" in lowered.lower() or "python 解题" in lowered or "修复" in lowered or "debug" in lowered.lower() or "fix" in lowered.lower() or "修正" in lowered:
            if "修复" in lowered or "debug" in lowered.lower() or "fix" in lowered.lower() or "修正" in lowered:
                # 反思/修复：返回一个增强版通用 flag 提取脚本
                content = (
                    "import os, re, base64, sys\n"
                    "patterns = [r'flag\\{[^}]+\\}', r'FLAG\\{[^}]+\\}', r'ctf\\{[^}]+\\}', r'sctf\\{[^}]+\\}', r'key\\{[^}]+\\}']\n"
                    "found = set()\n"
                    "for fname in os.listdir('.'):\n"
                    "    if not os.path.isfile(fname): continue\n"
                    "    try:\n"
                    "        with open(fname, 'rb') as f: raw = f.read(2*1024*1024)\n"
                    "        # try decode multiple encodings\n"
                    "        for decoder_name, decoder in [('latin-1', lambda x: x.decode('latin-1','ignore')), ('base64', lambda x: base64.b64decode(x + b'==' * 4).decode('latin-1','ignore'))]:\n"
                    "            try: text = decoder(raw)\n"
                    "            except Exception: continue\n"
                    "            # try xor with common keys\n"
                    "            for key in [0x00, 0x5A, 0x42, 0xFF]:\n"
                    "                xtext = ''.join(chr(ord(c) ^ key) for c in text)\n"
                    "                for p in patterns:\n"
                    "                    for m in re.finditer(p, xtext): found.add(m.group(0))\n"
                    "            for p in patterns:\n"
                    "                for m in re.finditer(p, text): found.add(m.group(0))\n"
                    "    except Exception: pass\n"
                    "if found:\n"
                    "    for f in sorted(found): print(f)\n"
                    "else:\n"
                    "    print('no flag found')\n"
                )
            else:
                # 代码生成请求：返回一个能直接运行的通用 CTF 解题脚本
                content = (
                    "# ZHULONG-X auto-generated solver (mock mode)\n"
                    "import os, re, base64, binascii\n"
                    "\n"
                    "PATTERNS = [\n"
                    "    r'flag\\{[^}]+\\}', r'FLAG\\{[^}]+\\}', r'ctf\\{[^}]+\\}',\n"
                    "    r'sctf\\{[^}]+\\}', r'SCTF\\{[^}]+\\}', r'key\\{[^}]+\\}',\n"
                    "]\n"
                    "B64_RE = re.compile(r'[A-Za-z0-9+/]{16,}={0,2}')\n"
                    "\n"
                    "def find_flags(text):\n"
                    "    out = set()\n"
                    "    for p in PATTERNS:\n"
                    "        for m in re.finditer(p, text):\n"
                    "            out.add(m.group(0))\n"
                    "    return out\n"
                    "\n"
                    "def try_decoders(raw):\n"
                    "    candidates = []\n"
                    "    # plain latin-1\n"
                    "    text_l = raw.decode('latin-1', 'ignore')\n"
                    "    candidates.append(('latin1', text_l))\n"
                    "    # base64 whole\n"
                    "    try:\n"
                    "        pad = raw + b'=' * (4 - len(raw) % 4) if len(raw) % 4 else raw\n"
                    "        decoded = base64.b64decode(pad, validate=False)\n"
                    "        candidates.append(('b64', decoded.decode('latin-1', 'ignore')))\n"
                    "        # single-byte xor on b64-decoded\n"
                    "        for key in [0x5A, 0x42, 0xFF, 0x37, 0x13]:\n"
                    "            xored = bytes(b ^ key for b in decoded)\n"
                    "            candidates.append((f'b64xor{hex(key)}', xored.decode('latin-1', 'ignore')))\n"
                    "        # repeating-key xor on b64-decoded (common ASCII keys)\n"
                    "        for key in [b'KEY', b'ZHUDL', b'ZHULO', b'ADMIN', b'SECRE', b'PASS', b'CTF', b'ZHULONGX']:\n"
                    "            klen = len(key)\n"
                    "            xored = bytes([b ^ key[i % klen] for i, b in enumerate(decoded)])\n"
                    "            candidates.append((f'b64xorrep{key.decode(errors=\"ignore\")}', xored.decode('latin-1', 'ignore')))\n"
                    "    except Exception: pass\n"
                    "    # extract b64-like substrings from text (reverse_py style)\n"
                    "    for m in B64_RE.finditer(text_l):\n"
                    "        s = m.group(0)\n"
                    "        try:\n"
                    "            pad = s + '=' * (4 - len(s) % 4) if len(s) % 4 else s\n"
                    "            d = base64.b64decode(pad, validate=False)\n"
                    "            candidates.append((f'b64sub', d.decode('latin-1', 'ignore')))\n"
                    "        except Exception: pass\n"
                    "    # base32\n"
                    "    try:\n"
                    "        pad = raw + b'=' * (8 - len(raw) % 8) if len(raw) % 8 else raw\n"
                    "        d = base64.b32decode(pad, casefold=True)\n"
                    "        candidates.append(('b32', d.decode('latin-1', 'ignore')))\n"
                    "    except Exception: pass\n"
                    "    # hex\n"
                    "    try:\n"
                    "        hex_text = raw.decode('ascii', 'ignore').strip()\n"
                    "        decoded = binascii.unhexlify(hex_text)\n"
                    "        candidates.append(('hex', decoded.decode('latin-1', 'ignore')))\n"
                    "    except Exception: pass\n"
                    "    # raw xor with common single-byte keys\n"
                    "    for key in [0x5A, 0x42, 0xFF, 0x37, 0x13, 0x00, 0x01]:\n"
                    "        xored = bytes(b ^ key for b in raw)\n"
                    "        candidates.append((f'xor{hex(key)}', xored.decode('latin-1', 'ignore')))\n"
                    "    # raw xor with repeating keys (common ASCII keys)\n"
                    "    for key in [b'KEY', b'ZHUDL', b'ZHULO', b'ADMIN', b'SECRE', b'PASS', b'CTF', b'ZHULONGX']:\n"
                    "        klen = len(key)\n"
                    "        xored = bytes([b ^ key[i % klen] for i, b in enumerate(raw)])\n"
                    "        txt = xored.decode('latin-1', 'ignore')\n"
                    "        candidates.append((f'xorrep{key.decode(errors=\"ignore\")}', txt))\n"
                    "    # multi-layer: base64 → base32 → hex (crypto_base_chain style, without rot13)\n"
                    "    try:\n"
                    "        d1 = base64.b64decode(raw + b'=' * (4 - len(raw) % 4) if len(raw) % 4 else raw)\n"
                    "        d2 = base64.b32decode(d1 + b'=' * (8 - len(d1) % 8) if len(d1) % 8 else d1, casefold=True)\n"
                    "        d3 = binascii.unhexlify(d2.decode('ascii', 'ignore').strip())\n"
                    "        candidates.append(('b64b32hex', d3.decode('latin-1', 'ignore')))\n"
                    "        # also try rot13 on the final result\n"
                    "        import codecs\n"
                    "        d4 = codecs.encode(d3.decode('latin-1', 'ignore'), 'rot13')\n"
                    "        candidates.append(('b64b32hex_rot13', d4))\n"
                    "    except Exception: pass\n"
                    "    # try rot13 on raw text\n"
                    "    try:\n"
                    "        import codecs\n"
                    "        r = codecs.encode(text_l, 'rot13')\n"
                    "        candidates.append(('rot13', r))\n"
                    "    except Exception: pass\n"
                    "    return candidates\n"
                    "\n"
                    "def main():\n"
                    "    found = set()\n"
                    "    files = [f for f in os.listdir('.') if os.path.isfile(f) and not f.startswith('solve')]\n"
                    "    for fname in files:\n"
                    "        try:\n"
                    "            with open(fname, 'rb') as f: raw = f.read(2*1024*1024)\n"
                    "        except Exception: continue\n"
                    "        for name, text in try_decoders(raw):\n"
                    "            flags = find_flags(text)\n"
                    "            if flags:\n"
                    "                for fl in flags:\n"
                    "                    print(f'[{name}:{fname}] {fl}')\n"
                    "                found.update(flags)\n"
                    "    if found:\n"
                    "        print('BEST:', sorted(found)[0])\n"
                    "    else:\n"
                    "        print('no flag found')\n"
                    "\n"
                    "if __name__ == '__main__':\n"
                    "    main()\n"
                )
        elif "classify" in lowered or "题型分类" in lowered:
            content = json.dumps(
                {
                    "category": "misc" if ("misc" in lowered or "杂" in lowered or "log" in lowered or "exif" in lowered) else "crypto",
                    "confidence": 0.7,
                    "reason": "mock mode: 按附件/关键词默认分类",
                    "suggested_tools": ["strings", "file", "binwalk"],
                },
                ensure_ascii=False,
            )
        elif "解题计划" in lowered or '"plan"' in lowered or "生成解题计划" in lowered:
            content = json.dumps(
                {
                    "plan": [
                        "1. 静态分析附件 (strings/binwalk)",
                        "2. 提取可读字符串与可疑编码",
                        "3. 尝试常见解码（base64/xor/caesar）",
                        "4. 生成 solve.py 验证并打印 flag",
                    ],
                    "risks": ["附件可能包含混淆", "字符集可能是非 ASCII"],
                    "fallback": "若解码失败转 forensics 思路",
                },
                ensure_ascii=False,
            )
        elif "extract" in lowered and "flag" in lowered:
            content = "flag{mock_flag_from_llm_adapter}"
        elif json_mode:
            content = json.dumps(
                {
                    "thought": "mock LLM 思考",
                    "next_action": "run_static_analysis",
                    "confidence": 0.6,
                },
                ensure_ascii=False,
            )
        else:
            content = (
                "[ZHULONG-X mock LLM] 已收到请求。"
                "请在 .env 中设置 LLM_ENABLED=true 并配置 LLM_API_KEY 以启用真实模型。"
            )
        return LLMResponse(
            success=True,
            content=content,
            model=f"{self.model} (mock)",
            usage={"prompt_tokens": len(last_user), "completion_tokens": len(content), "total_tokens": len(last_user) + len(content)},
            attempts=1,
            elapsed_ms=10,
            mode="mock",
        )

    def _chat_anthropic(
        self,
        messages: List[Dict[str, str]],
        *,
        system_prompt: Optional[str] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        """Anthropic Messages API 兼容协议（晚晴网关 / Claude 官方）。

        请求:  POST {base_url}/messages
               body: { model, max_tokens, system?, messages, temperature? }
               header: Authorization: Bearer <key>
        响应:  { content: [{type: "text"|"thinking", text|thinking: "..."}], stop_reason, usage }
        """
        # Anthropic 协议: system 是 top-level 字段，messages 只含 user/assistant
        system_text = system_prompt or ""
        clean: List[Dict[str, str]] = []
        for m in messages:
            role = m.get("role", "user")
            content = (m.get("content") or "").strip()
            if not content:
                continue
            if role == "system":
                # 合并到 top-level system
                system_text = (system_text + "\n\n" + content).strip() if system_text else content
                continue
            if role == "developer":
                system_text = (system_text + "\n\n" + content).strip() if system_text else content
                continue
            clean.append({"role": role, "content": content})
        if not clean:
            clean.append({"role": "user", "content": "(empty)"})

        # json_mode 提示注入（Anthropic 没有 response_format，靠 system 提示约束）
        if json_mode and system_text:
            system_text = system_text + "\n\n严格要求：只输出合法 JSON，不要任何额外文字、不要 markdown 代码块。"

        payload: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens or self.max_tokens,
            "messages": clean,
        }
        if system_text:
            payload["system"] = system_text
        if temperature is not None:
            payload["temperature"] = temperature
        elif self.temperature is not None:
            payload["temperature"] = self.temperature

        url = f"{self.base_url}/messages"
        last_error: Optional[str] = None
        start = time.time()
        attempts = max(int(self.max_retries or 0), 0) + 1
        for attempt in range(attempts):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(url, headers=self._headers(), json=payload)
                    resp.raise_for_status()
                    data = resp.json()
                # 解析 Anthropic 响应: content 是 block 数组，取 text block 拼接
                content_blocks = data.get("content", []) or []
                text_parts: List[str] = []
                for block in content_blocks:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type", "")
                    if btype == "text" and block.get("text"):
                        text_parts.append(block["text"])
                    # thinking 块不拼到 content（避免污染脚本）
                content = "".join(text_parts)
                usage = data.get("usage", {}) or {}
                # 归一化 usage 字段（Anthropic 用 input_tokens/output_tokens）
                if "input_tokens" in usage and "prompt_tokens" not in usage:
                    usage = {
                        "prompt_tokens": usage.get("input_tokens", 0),
                        "completion_tokens": usage.get("output_tokens", 0),
                        "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
                    }
                model_name = data.get("model", self.model)
                elapsed_ms = int((time.time() - start) * 1000)
                self.last_success = time.time()
                self.last_error = ""
                logger.info(
                    "LLM(anthropic) call ok model=%s provider=%s attempt=%d elapsed=%dms",
                    mask_sensitive_in_text(model_name),
                    self.provider,
                    attempt + 1,
                    elapsed_ms,
                )
                return LLMResponse(
                    success=True,
                    content=content,
                    model=model_name,
                    usage=usage,
                    attempts=attempt + 1,
                    elapsed_ms=elapsed_ms,
                    mode="live",
                )
            except httpx.TimeoutException:
                last_error = f"LLM request timeout after {self.timeout}s"
                logger.warning("LLM(anthropic) timeout model=%s attempt=%d", self.model, attempt + 1)
            except httpx.HTTPStatusError as e:
                body = mask_sensitive_in_text(e.response.text[:300])
                last_error = f"LLM HTTP {e.response.status_code}: {body}"
                logger.warning("LLM(anthropic) HTTP %d attempt=%d body=%s", e.response.status_code, attempt + 1, body)
            except Exception as e:  # noqa: BLE001
                last_error = f"LLM error: {type(e).__name__}: {str(e)[:200]}"
                logger.warning("LLM(anthropic) fail %s attempt=%d", type(e).__name__, attempt + 1)
            if attempt < attempts - 1:
                time.sleep(min(0.5 * (attempt + 1), 2.0))

        self.last_error = last_error or "LLM request failed"
        return LLMResponse(
            success=False,
            content="",
            model=self.model,
            error=self.last_error,
            attempts=attempts,
            elapsed_ms=int((time.time() - start) * 1000),
            mode="live",
        )

    def chat(
        self,
        messages: List[Dict[str, str]],
        *,
        system_prompt: Optional[str] = None,
        developer_prompt: Optional[str] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        """非流式 chat。"""
        full_messages: List[Dict[str, str]] = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        if developer_prompt:
            full_messages.append({"role": "developer", "content": developer_prompt})
        full_messages.extend(messages)

        # Mock / Disabled
        if self.mock_mode:
            return self._mock_complete(full_messages, json_mode=json_mode)
        if not self.enabled:
            return LLMResponse(
                success=False,
                content="",
                model=self.model,
                error="LLM disabled (LLM_ENABLED=false) and mock_mode auto-off",
                mode="disabled",
            )

        # Anthropic Messages API 协议分支（晚晴网关 / Claude 官方）
        if self._is_anthropic_style():
            return self._chat_anthropic(
                full_messages,
                system_prompt=None,  # system 已在 full_messages 里，_chat_anthropic 会提取
                max_tokens=max_tokens,
                temperature=temperature,
                json_mode=json_mode,
            )

        url = f"{self.base_url}/chat/completions"
        payload = self._build_payload(
            full_messages,
            max_tokens=max_tokens,
            temperature=temperature,
            json_mode=json_mode,
            stream=False,
        )

        last_error: Optional[str] = None
        start = time.time()
        attempts = max(int(self.max_retries or 0), 0) + 1
        for attempt in range(attempts):
            try:
                elapsed_ms = int((time.time() - start) * 1000)
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(url, headers=self._headers(), json=payload)
                    resp.raise_for_status()
                    data = resp.json()
                content = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})
                model_name = data.get("model", self.model)
                self.last_success = time.time()
                self.last_error = ""
                logger.info(
                    "LLM call ok model=%s provider=%s attempt=%d elapsed=%dms",
                    mask_sensitive_in_text(model_name),
                    self.provider,
                    attempt + 1,
                    elapsed_ms,
                )
                return LLMResponse(
                    success=True,
                    content=content,
                    model=model_name,
                    usage=usage,
                    attempts=attempt + 1,
                    elapsed_ms=elapsed_ms,
                    mode="live",
                )
            except httpx.TimeoutException:
                last_error = f"LLM request timeout after {self.timeout}s"
                logger.warning("LLM timeout model=%s attempt=%d", self.model, attempt + 1)
            except httpx.HTTPStatusError as e:
                body = mask_sensitive_in_text(e.response.text[:200])
                last_error = f"LLM HTTP {e.response.status_code}: {body}"
                logger.warning("LLM HTTP %d attempt=%d body=%s", e.response.status_code, attempt + 1, body)
            except Exception as e:  # noqa: BLE001
                last_error = f"LLM error: {type(e).__name__}: {str(e)[:200]}"
                logger.warning("LLM fail %s attempt=%d", type(e).__name__, attempt + 1)
            if attempt < attempts - 1:
                time.sleep(min(0.5 * (attempt + 1), 2.0))

        self.last_error = last_error or "LLM request failed"
        return LLMResponse(
            success=False,
            content="",
            model=self.model,
            error=self.last_error,
            attempts=attempts,
            elapsed_ms=int((time.time() - start) * 1000),
            mode="live",
        )

    def chat_json(
        self,
        messages: List[Dict[str, str]],
        *,
        system_prompt: Optional[str] = None,
        max_tokens: Optional[int] = None,
    ) -> Tuple[bool, Dict[str, Any], LLMResponse]:
        """强 JSON 模式：先尝试 json_mode，失败再二次解析。"""
        resp = self.chat(
            messages,
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            json_mode=True,
        )
        if not resp.success:
            return False, {}, resp
        try:
            data = json.loads(resp.content)
            return True, data, resp
        except json.JSONDecodeError:
            # 容错：从 ```json ... ``` 块中提取
            m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", resp.content)
            if m:
                try:
                    data = json.loads(m.group(1))
                    return True, data, resp
                except json.JSONDecodeError:
                    pass
            logger.warning("LLM JSON parse failed, content head=%s", resp.content[:200])
            return False, {}, resp

    def stream(
        self,
        messages: List[Dict[str, str]],
        *,
        system_prompt: Optional[str] = None,
    ) -> Iterable[Dict[str, Any]]:
        """流式 chat（generator）。"""
        if self.mock_mode or not self.enabled:
            # 模拟单块返回
            resp = self._mock_complete(
                [*([{"role": "system", "content": system_prompt}] if system_prompt else []), *messages],
                json_mode=False,
            )
            yield {"delta": resp.content, "done": True, "mode": resp.mode}
            return

        url = f"{self.base_url}/chat/completions"
        full_messages: List[Dict[str, str]] = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        full_messages.extend(messages)
        payload = self._build_payload(full_messages, stream=True)
        try:
            with httpx.Client(timeout=self.timeout) as client:
                with client.stream("POST", url, headers=self._headers(), json=payload) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if chunk == "[DONE]":
                            break
                        try:
                            obj = json.loads(chunk)
                            delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if delta:
                                yield {"delta": delta, "done": False, "mode": "live"}
                        except json.JSONDecodeError:
                            continue
                    yield {"delta": "", "done": True, "mode": "live"}
        except Exception as e:  # noqa: BLE001
            logger.warning("LLM stream failed: %s", type(e).__name__)
            yield {"delta": "", "done": True, "error": str(e)[:200], "mode": "live"}


_adapter: Optional[LLMAdapter] = None


def get_adapter() -> LLMAdapter:
    """单例获取（用于普通请求复用连接配置）。"""
    global _adapter
    if _adapter is None:
        _adapter = LLMAdapter()
    return _adapter

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "烛龙·玄枢 ZHULONG-X"
    APP_TAGLINE: str = "烛照隐微，枢决攻防"
    APP_EDITION: str = "ZHULONG-X v5"
    APP_ENV: str = "dev"
    BACKEND_HOST: str = "0.0.0.0"
    BACKEND_PORT: int = 8000

    DATABASE_URL: str = "sqlite:///./data/zhulongx.db"
    UPLOAD_DIR: str = "./app/storage/uploads"
    REPORT_DIR: str = "./app/storage/reports"
    CTF_DEMO_DIR: str = "./examples/ctf_demo"
    CTF_RUN_DIR: str = "./data/ctf_runs"
    CTF_MAX_ROUNDS: int = 0           # v7: 0=无限，仅受 max_time_sec 限制
    CTF_MAX_TIME_SEC: int = 600       # v7: 最大运行时间(秒)
    CTF_SANDBOX_TIMEOUT: int = 15
    CTF_SANDBOX_MAX_OUTPUT: int = 20000

    # v8: Hard Mode for difficult CTF problems
    CTF_HARD_MODE: bool = False
    CTF_VERIFY_CONTINUE_ON_NO_FLAG: bool = True  # v8: 无 flag 时继续探索

    LLM_PROVIDER: str = "openai_compatible"
    LLM_BASE_URL: str = "http://localhost:11434/v1"
    LLM_API_KEY: str = "replace_me"
    LLM_MODEL: str = "qwen2.5-coder"
    LLM_ENABLED: bool = False
    LLM_TIMEOUT: int = 60
    LLM_MAX_RETRIES: int = 2
    LLM_MAX_TOKENS: int = 4096
    LLM_TEMPERATURE: float = 0.2

    # ===== Cost-aware Model Router (v6) =====
    LLM_ROUTER_ENABLED: bool = True
    LLM_BUDGET_PER_TASK_USD: float = 0.05
    LLM_BUDGET_DAILY_USD: float = 1.00
    LLM_DEFAULT_MAX_CONTEXT_CHARS: int = 12000
    LLM_COMPRESS_THRESHOLD_CHARS: int = 8000

    # Cheap lane — daily classification / planning / simple fixes
    LLM_CHEAP_PROVIDER: str = "deepseek"
    LLM_CHEAP_BASE_URL: str = "https://api.deepseek.com/v1"
    LLM_CHEAP_MODEL: str = "deepseek-v4-flash"
    LLM_CHEAP_API_KEY: str = "replace_me"
    LLM_CHEAP_MAX_TOKENS: int = 1800
    LLM_CHEAP_TEMPERATURE: float = 0.2

    # Expert lane — complex repairs / long context / stuck loops
    LLM_EXPERT_PROVIDER: str = "glm"
    LLM_EXPERT_BASE_URL: str = "https://api.z.ai/api/coding/paas/v4"
    LLM_EXPERT_MODEL: str = "glm-5.2"
    LLM_EXPERT_API_KEY: str = "replace_me"
    LLM_EXPERT_MAX_TOKENS: int = 8192  # v8: 从 4096 增加到 8192
    LLM_EXPERT_TEMPERATURE: float = 0.15  # v8: 从 0.2 降低到 0.15，困难题更确定性

    # Fallback lane (optional)
    LLM_FALLBACK_PROVIDER: str = "qwen"
    LLM_FALLBACK_BASE_URL: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    LLM_FALLBACK_MODEL: str = "qwen-coder-plus"
    LLM_FALLBACK_API_KEY: str = "replace_me"

    # ===== Claude Code Bridge Runtime =====
    # 主编排优先交给 vendored / external Claude Code；不可用时可回退内部 AgentRuntime。
    CC_RUNTIME_ENABLED: bool = True
    CC_RUNTIME_REQUIRE_EXTERNAL: bool = False
    CC_RUNTIME_FALLBACK_INTERNAL: bool = True
    CC_RUNTIME_BIN: str = ""
    CC_RUNTIME_COMMAND_TEMPLATE: str = ""
    CC_RUNTIME_VENDOR_DIR: str = "./vendor/claude-code"
    CC_RUNTIME_TIMEOUT: int = 600
    CC_RUNTIME_MAX_OUTPUT_CHARS: int = 120000
    CC_RUNTIME_SKIP_PERMISSIONS: bool = False

    # ===== WQ (万青/晚晴) Gateway 统一 API Key =====
    # 当设置了 WQ_API_KEY 环境变量时，自动覆盖所有 lane 的 API_KEY
    WQ_API_KEY: str = ""

    MAX_UPLOAD_SIZE: int = 50 * 1024 * 1024  # 50MB

    COMPETITION_MODE: bool = False
    SCOPE_CIDRS: str = ""
    SCOPE_DOMAINS: str = ""
    SCOPE_PORTS: str = ""
    SCOPE_ALLOW_LOCALHOST: bool = False
    SCOPE_ALLOW_PRIVATE_IPS: bool = False
    MAX_REQUESTS_PER_TASK: int = 120
    MAX_REQUESTS_PER_TARGET: int = 40
    DEFAULT_HTTP_TIMEOUT: int = 10
    MAX_CONCURRENT_TASKS: int = 3
    MAX_CONCURRENT_TASKS_PER_CHALLENGE: int = 2

    # Legacy local-development switch kept only for backward compatibility.
    # Competition access should use COMPETITION_MODE + explicit scope allowlists.
    DEV_ALLOW_PRIVATE_TARGETS: bool = False

    BLIND_SOLVE_MODE: bool = True
    DISABLE_RAG_FOR_SOLVE: bool = True
    DISABLE_HISTORY_MATCHING: bool = True
    DISABLE_INTERNET_SEARCH: bool = True
    MCP_ONLY_SOLVE: bool = True
    ALLOW_LLM_REASONING: bool = True
    ALLOW_LLM_PUBLIC_MEMORY_GUESS: bool = False
    SOLVE_ALLOWED_ROOTS: str = ""
    SOLVE_DENIED_ROOTS: str = ""
    SOLVE_CASE_ID: str = ""


settings = Settings()

# ===== WQ_API_KEY 统一覆盖逻辑 =====
# 当 WQ_API_KEY 环境变量设置时，自动覆盖所有 lane 的 API_KEY
# 这避免了在 .env 文件中重复写入密钥，只需设置一个环境变量即可
_wq_key = settings.WQ_API_KEY
if _wq_key and _wq_key != "replace_me":
    if settings.LLM_API_KEY == "replace_me" or not settings.LLM_API_KEY:
        object.__setattr__(settings, "LLM_API_KEY", _wq_key)
    if settings.LLM_CHEAP_API_KEY == "replace_me" or not settings.LLM_CHEAP_API_KEY:
        object.__setattr__(settings, "LLM_CHEAP_API_KEY", _wq_key)
    if settings.LLM_EXPERT_API_KEY == "replace_me" or not settings.LLM_EXPERT_API_KEY:
        object.__setattr__(settings, "LLM_EXPERT_API_KEY", _wq_key)
    if settings.LLM_FALLBACK_API_KEY == "replace_me" or not settings.LLM_FALLBACK_API_KEY:
        object.__setattr__(settings, "LLM_FALLBACK_API_KEY", _wq_key)

# ===== WQ Gateway 统一 Base URL / Provider / Model 覆盖 =====
# 当 LLM_BASE_URL 指向 wanqing 网关时，自动将所有 lane 统一到 wanqing gateway
_wq_base = settings.LLM_BASE_URL
if _wq_key and _wq_key != "replace_me" and "wanqing" in _wq_base.lower():
    _wq_model = settings.LLM_MODEL
    _expert_defaults = ("https://api.z.ai/api/coding/paas/v4",)
    _cheap_defaults = ("https://api.deepseek.com/v1",)
    _fallback_defaults = ("https://dashscope.aliyuncs.com/compatible-mode/v1",)
    if settings.LLM_EXPERT_BASE_URL in _expert_defaults or not settings.LLM_EXPERT_BASE_URL:
        object.__setattr__(settings, "LLM_EXPERT_BASE_URL", _wq_base)
    if settings.LLM_EXPERT_PROVIDER == "glm":
        object.__setattr__(settings, "LLM_EXPERT_PROVIDER", "wanqing")
    if settings.LLM_EXPERT_MODEL in ("glm-5.2",):
        object.__setattr__(settings, "LLM_EXPERT_MODEL", _wq_model)
    if settings.LLM_CHEAP_BASE_URL in _cheap_defaults or not settings.LLM_CHEAP_BASE_URL:
        object.__setattr__(settings, "LLM_CHEAP_BASE_URL", _wq_base)
    if settings.LLM_CHEAP_PROVIDER == "deepseek":
        object.__setattr__(settings, "LLM_CHEAP_PROVIDER", "wanqing")
    if settings.LLM_CHEAP_MODEL in ("deepseek-v4-flash",):
        object.__setattr__(settings, "LLM_CHEAP_MODEL", _wq_model)
    if settings.LLM_FALLBACK_BASE_URL in _fallback_defaults or not settings.LLM_FALLBACK_BASE_URL:
        object.__setattr__(settings, "LLM_FALLBACK_BASE_URL", _wq_base)
    if settings.LLM_FALLBACK_PROVIDER == "qwen":
        object.__setattr__(settings, "LLM_FALLBACK_PROVIDER", "wanqing")
    if settings.LLM_FALLBACK_MODEL in ("qwen-coder-plus",):
        object.__setattr__(settings, "LLM_FALLBACK_MODEL", _wq_model)

# Ensure storage dirs exist
Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
Path(settings.REPORT_DIR).mkdir(parents=True, exist_ok=True)

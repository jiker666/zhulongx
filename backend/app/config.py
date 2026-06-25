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
    CTF_MAX_ROUNDS: int = 8
    CTF_SANDBOX_TIMEOUT: int = 15
    CTF_SANDBOX_MAX_OUTPUT: int = 20000

    LLM_PROVIDER: str = "openai_compatible"
    LLM_BASE_URL: str = "http://localhost:11434/v1"
    LLM_API_KEY: str = "replace_me"
    LLM_MODEL: str = "qwen2.5-coder"
    LLM_ENABLED: bool = False
    LLM_TIMEOUT: int = 60
    LLM_MAX_RETRIES: int = 2
    LLM_MAX_TOKENS: int = 4096
    LLM_TEMPERATURE: float = 0.2

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

# Ensure storage dirs exist
Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
Path(settings.REPORT_DIR).mkdir(parents=True, exist_ok=True)

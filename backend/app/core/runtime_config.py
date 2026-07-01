"""
Runtime Config — 运行时配置管理（v6.1）。

职责：
- 持久化 LLM 配置到 data/runtime_config.json（不污染 .env）
- 启动时加载并覆盖 settings 单例
- 提供 update_settings() 供 API 调用
- 审计日志：记录谁改了什么（不含 key 值）
- API key 安全：留空 = 保持不变，填了 = 更新

安全约束：
- API key 永不明文返回
- API key 永不写入日志
- runtime_config.json 权限 600
- 危险字段（如关闭 router）记录审计
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)


# 可通过 API 修改的字段白名单（敏感字段单独标记）
EDITABLE_FIELDS: Dict[str, Dict[str, Any]] = {
    # Router 开关
    "LLM_ROUTER_ENABLED": {"type": "bool", "sensitive": False, "lane": "router"},
    "LLM_BUDGET_PER_TASK_USD": {"type": "float", "sensitive": False, "lane": "router"},
    "LLM_BUDGET_DAILY_USD": {"type": "float", "sensitive": False, "lane": "router"},
    "LLM_COMPRESS_THRESHOLD_CHARS": {"type": "int", "sensitive": False, "lane": "router"},
    # Cheap lane
    "LLM_CHEAP_PROVIDER": {"type": "str", "sensitive": False, "lane": "cheap"},
    "LLM_CHEAP_BASE_URL": {"type": "str", "sensitive": False, "lane": "cheap"},
    "LLM_CHEAP_MODEL": {"type": "str", "sensitive": False, "lane": "cheap"},
    "LLM_CHEAP_API_KEY": {"type": "str", "sensitive": True, "lane": "cheap"},
    "LLM_CHEAP_MAX_TOKENS": {"type": "int", "sensitive": False, "lane": "cheap"},
    "LLM_CHEAP_TEMPERATURE": {"type": "float", "sensitive": False, "lane": "cheap"},
    # Expert lane
    "LLM_EXPERT_PROVIDER": {"type": "str", "sensitive": False, "lane": "expert"},
    "LLM_EXPERT_BASE_URL": {"type": "str", "sensitive": False, "lane": "expert"},
    "LLM_EXPERT_MODEL": {"type": "str", "sensitive": False, "lane": "expert"},
    "LLM_EXPERT_API_KEY": {"type": "str", "sensitive": True, "lane": "expert"},
    "LLM_EXPERT_MAX_TOKENS": {"type": "int", "sensitive": False, "lane": "expert"},
    "LLM_EXPERT_TEMPERATURE": {"type": "float", "sensitive": False, "lane": "expert"},
    # Fallback lane
    "LLM_FALLBACK_PROVIDER": {"type": "str", "sensitive": False, "lane": "fallback"},
    "LLM_FALLBACK_BASE_URL": {"type": "str", "sensitive": False, "lane": "fallback"},
    "LLM_FALLBACK_MODEL": {"type": "str", "sensitive": False, "lane": "fallback"},
    "LLM_FALLBACK_API_KEY": {"type": "str", "sensitive": True, "lane": "fallback"},
    # 全局 LLM 开关
    "LLM_ENABLED": {"type": "bool", "sensitive": False, "lane": "global"},
    "LLM_TIMEOUT": {"type": "int", "sensitive": False, "lane": "global"},
    "LLM_MAX_RETRIES": {"type": "int", "sensitive": False, "lane": "global"},
}

# 敏感字段（API key）— 留空表示保持不变，永不明文返回
SENSITIVE_FIELDS = {k for k, v in EDITABLE_FIELDS.items() if v["sensitive"]}

# 审计日志路径
_AUDIT_LOG = Path("data/runtime_config_audit.jsonl")


def _config_path() -> Path:
    """runtime_config.json 路径（跟 DATABASE_URL 同目录）。"""
    db = settings.DATABASE_URL
    if db.startswith("sqlite:///"):
        raw = db.replace("sqlite:///", "", 1)
        if raw not in (":memory:", ""):
            return Path(raw).parent / "runtime_config.json"
    return Path("data/runtime_config.json")


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _mask_key(key: Optional[str]) -> str:
    """脱敏 key：只返回是否配置，不返回明文。"""
    if not key or key == "replace_me":
        return "(not configured)"
    return f"(configured, length={len(key)})"


def _coerce(value: Any, type_hint: str) -> Any:
    """把字符串值转成目标类型。"""
    if value is None or value == "":
        return None
    if type_hint == "bool":
        if isinstance(value, bool):
            return value
        return str(value).lower() in ("true", "1", "yes", "on")
    if type_hint == "int":
        return int(value)
    if type_hint == "float":
        return float(value)
    return str(value)


def _field_masked_value(field: str) -> Any:
    """获取字段当前值的脱敏版本（敏感字段返回 configured 状态）。"""
    raw = getattr(settings, field, None)
    if field in SENSITIVE_FIELDS:
        return _mask_key(raw)
    return raw


class RuntimeConfig:
    """运行时配置管理（线程安全）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._config_path = _config_path()
        # 内存审计缓冲（也写文件）
        self._audit_buffer: List[Dict[str, Any]] = []

    # ---------- load / persist ----------

    def load(self) -> None:
        """启动时从 runtime_config.json 加载并覆盖 settings。"""
        try:
            if not self._config_path.is_file():
                return
            with self._config_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return
            applied = 0
            for field, value in data.items():
                if field not in EDITABLE_FIELDS:
                    continue
                meta = EDITABLE_FIELDS[field]
                try:
                    coerced = _coerce(value, meta["type"])
                    if coerced is not None:
                        setattr(settings, field, coerced)
                        applied += 1
                except (ValueError, TypeError) as e:
                    logger.warning("runtime_config: skip %s=%r (%s)", field, value, e)
            logger.info("runtime_config: loaded %d fields from %s", applied, self._config_path)
        except Exception as e:  # noqa: BLE001
            logger.warning("runtime_config load failed: %s", e)

    def save(self, updates: Dict[str, Any]) -> None:
        """把更新合并到 runtime_config.json。"""
        with self._lock:
            existing = {}
            if self._config_path.is_file():
                try:
                    existing = json.loads(self._config_path.read_text(encoding="utf-8"))
                    if not isinstance(existing, dict):
                        existing = {}
                except Exception:
                    existing = {}
            # 合并更新（None 表示删除）
            for k, v in updates.items():
                if v is None:
                    existing.pop(k, None)
                else:
                    existing[k] = v
            _ensure_parent(self._config_path)
            tmp = self._config_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._config_path)
            try:
                os.chmod(self._config_path, 0o600)
            except OSError:
                pass  # Windows / 测试环境

    # ---------- update ----------

    def update(self, updates: Dict[str, Any], *, actor: str = "api") -> Dict[str, Any]:
        """应用配置更新。返回变更摘要（脱敏）。

        - 敏感字段（API key）留空/None = 保持不变
        - 敏感字段填了新值 = 更新
        - 非敏感字段 None = 跳过
        """
        applied: Dict[str, Any] = {}
        skipped: List[str] = []
        for field, new_value in updates.items():
            if field not in EDITABLE_FIELDS:
                skipped.append(field)
                continue
            meta = EDITABLE_FIELDS[field]
            # 敏感字段留空 = 保持
            if field in SENSITIVE_FIELDS and (new_value is None or new_value == ""):
                applied[field] = _mask_key(getattr(settings, field))
                continue
            try:
                coerced = _coerce(new_value, meta["type"])
            except (ValueError, TypeError) as e:
                skipped.append(f"{field}(invalid:{e})")
                continue
            if coerced is None:
                skipped.append(field)
                continue
            old_masked = _field_masked_value(field)
            setattr(settings, field, coerced)
            # 持久化（敏感字段也存，但日志脱敏）
            self.save({field: coerced})
            # 审计
            self._audit(actor, field, old_masked, _field_masked_value(field))
            applied[field] = _field_masked_value(field)
        return {"applied": applied, "skipped": skipped}

    # ---------- query ----------

    def snapshot(self) -> Dict[str, Any]:
        """返回所有可编辑字段的当前值（脱敏）。按 lane 分组。"""
        out: Dict[str, Any] = {"router": {}, "global": {}, "cheap": {}, "expert": {}, "fallback": {}}
        for field, meta in EDITABLE_FIELDS.items():
            lane = meta["lane"]
            out.setdefault(lane, {})[field] = _field_masked_value(field)
        return out

    def get_audit_log(self, limit: int = 50) -> List[Dict[str, Any]]:
        """读取审计日志。"""
        if not _AUDIT_LOG.is_file():
            return []
        try:
            lines = _AUDIT_LOG.read_text(encoding="utf-8").splitlines()
            entries = []
            for ln in reversed(lines[-limit * 2:]):
                try:
                    entries.append(json.loads(ln))
                except json.JSONDecodeError:
                    continue
            return entries[:limit]
        except Exception:
            return []

    # ---------- audit ----------

    def _audit(self, actor: str, field: str, old_val: Any, new_val: Any) -> None:
        """写审计日志（敏感字段只记 configured 状态变化）。"""
        entry = {
            "ts": time.time(),
            "actor": actor,
            "field": field,
            "old": old_val,
            "new": new_val,
        }
        try:
            _ensure_parent(_AUDIT_LOG)
            with _AUDIT_LOG.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:  # noqa: BLE001
            logger.warning("audit log write failed: %s", e)

    # ---------- reset ----------

    def reset(self) -> None:
        """清空 runtime_config.json（恢复到 .env 默认）。"""
        with self._lock:
            try:
                self._config_path.unlink(missing_ok=True)
            except Exception:
                pass


# 全局单例
_runtime_config: Optional[RuntimeConfig] = None
_rc_lock = threading.Lock()


def get_runtime_config() -> RuntimeConfig:
    global _runtime_config
    if _runtime_config is None:
        with _rc_lock:
            if _runtime_config is None:
                _runtime_config = RuntimeConfig()
    return _runtime_config


def load_runtime_config_on_startup() -> None:
    """启动时调用：加载 runtime_config 覆盖 settings。"""
    get_runtime_config().load()
    # LLM adapter 单例需要重建以应用新配置
    import app.core.llm_adapter as la_mod
    la_mod._adapter = None
    # ModelRouter 单例也需要重建（它读 settings）
    import app.core.model_router as mr_mod
    mr_mod._router = None

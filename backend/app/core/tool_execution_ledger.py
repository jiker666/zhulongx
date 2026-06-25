"""
Solve-time execution ledger for Blind Solve Mode.
"""
from __future__ import annotations

import datetime as dt
import hashlib
from typing import Any, Dict, List, Optional


class ToolExecutionLedger:
    def __init__(self) -> None:
        self._items: List[Dict[str, Any]] = []
        self._next_id = 1

    def record(
        self,
        action_type: str,
        tool_name: str,
        input_summary: str = "",
        output_text: str = "",
        evidence_id: str = "",
        allowed_by_solve_access_guard: Optional[bool] = None,
        allowed_by_scope_guard: Optional[bool] = None,
        policy_decision: str = "allow",
    ) -> Dict[str, Any]:
        output_hash = hashlib.sha256((output_text or "").encode("utf-8", errors="ignore")).hexdigest() if output_text else ""
        item = {
            "action_id": self._next_id,
            "action_type": action_type,
            "tool_name": tool_name,
            "input_summary": (input_summary or "")[:1000],
            "output_hash": output_hash,
            "evidence_id": evidence_id or "",
            "allowed_by_solve_access_guard": allowed_by_solve_access_guard,
            "allowed_by_scope_guard": allowed_by_scope_guard,
            "policy_decision": policy_decision,
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        self._next_id += 1
        self._items.append(item)
        return item

    def to_list(self) -> List[Dict[str, Any]]:
        return list(self._items)

    def tools_used(self) -> List[str]:
        return sorted({item["tool_name"] for item in self._items if item.get("tool_name")})

    def by_type(self, action_type: str) -> List[Dict[str, Any]]:
        return [item for item in self._items if item.get("action_type") == action_type]

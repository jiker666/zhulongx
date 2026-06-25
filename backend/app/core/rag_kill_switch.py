"""
Hard stop for RAG/history/search paths during blind CTF solve.
"""
from __future__ import annotations

from typing import Any, Dict

from app.config import settings


class RAGDisabledForSolveError(RuntimeError):
    pass


RAG_ACTIONS = {"rag", "retrieval", "vector", "embedding", "knowledge_base"}
HISTORY_ACTIONS = {"history", "previous_runs", "similar_case", "case_match", "writeup", "solution"}
SEARCH_ACTIONS = {"internet_search", "search_engine", "web_search", "public_writeup_search"}


class RAGKillSwitch:
    def state(self) -> Dict[str, Any]:
        return {
            "blind_solve_mode": bool(settings.BLIND_SOLVE_MODE),
            "rag_disabled": bool(settings.DISABLE_RAG_FOR_SOLVE),
            "history_matching_disabled": bool(settings.DISABLE_HISTORY_MATCHING),
            "internet_search_disabled": bool(settings.DISABLE_INTERNET_SEARCH),
            "mcp_only_solve": bool(settings.MCP_ONLY_SOLVE),
            "allow_llm_reasoning": bool(settings.ALLOW_LLM_REASONING),
            "allow_llm_public_memory_guess": bool(settings.ALLOW_LLM_PUBLIC_MEMORY_GUESS),
        }

    def enforce(self, component: str, action_type: str, solve_mode: bool | None = None) -> None:
        active = bool(settings.BLIND_SOLVE_MODE if solve_mode is None else solve_mode)
        if not active:
            return
        action = (action_type or "").strip().lower()
        if settings.DISABLE_RAG_FOR_SOLVE and any(term in action for term in RAG_ACTIONS):
            raise RAGDisabledForSolveError(f"RAG/retrieval disabled for solve: {component}:{action_type}")
        if settings.DISABLE_HISTORY_MATCHING and any(term in action for term in HISTORY_ACTIONS):
            raise RAGDisabledForSolveError(f"history matching disabled for solve: {component}:{action_type}")
        if settings.DISABLE_INTERNET_SEARCH and any(term in action for term in SEARCH_ACTIONS):
            raise RAGDisabledForSolveError(f"internet search disabled for solve: {component}:{action_type}")

    def require_blind_solve_controls(self, component: str) -> Dict[str, Any]:
        state = self.state()
        if not state["blind_solve_mode"]:
            return state
        required = {
            "rag_disabled": True,
            "history_matching_disabled": True,
            "internet_search_disabled": True,
            "mcp_only_solve": True,
            "allow_llm_public_memory_guess": False,
        }
        missing = [key for key, expected in required.items() if state.get(key) != expected]
        if missing:
            raise RAGDisabledForSolveError(f"Blind Solve controls are not enforced for {component}: {', '.join(missing)}")
        return state

    def assert_allowed_tool_action(self, component: str, action_type: str) -> None:
        self.enforce(component, action_type)

    def rag_query(self, component: str = "unknown") -> None:
        self.enforce(component, "rag")

    def history_match(self, component: str = "unknown") -> None:
        self.enforce(component, "history")

    def internet_search(self, component: str = "unknown") -> None:
        self.enforce(component, "internet_search")


rag_kill_switch = RAGKillSwitch()


def assert_no_rag_for_solve(component: str, action_type: str) -> None:
    rag_kill_switch.enforce(component, action_type)

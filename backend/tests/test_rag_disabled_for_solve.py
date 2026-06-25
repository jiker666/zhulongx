import pytest

from app.core.rag_kill_switch import RAGDisabledForSolveError, rag_kill_switch


def test_rag_call_raises_in_solve_mode(monkeypatch):
    monkeypatch.setattr("app.core.rag_kill_switch.settings.BLIND_SOLVE_MODE", True)
    monkeypatch.setattr("app.core.rag_kill_switch.settings.DISABLE_RAG_FOR_SOLVE", True)
    with pytest.raises(RAGDisabledForSolveError):
        rag_kill_switch.rag_query("unit-test")


def test_history_matching_raises_in_solve_mode(monkeypatch):
    monkeypatch.setattr("app.core.rag_kill_switch.settings.BLIND_SOLVE_MODE", True)
    monkeypatch.setattr("app.core.rag_kill_switch.settings.DISABLE_HISTORY_MATCHING", True)
    with pytest.raises(RAGDisabledForSolveError):
        rag_kill_switch.history_match("unit-test")


def test_required_blind_solve_controls_raise_when_disabled(monkeypatch):
    monkeypatch.setattr("app.core.rag_kill_switch.settings.BLIND_SOLVE_MODE", True)
    monkeypatch.setattr("app.core.rag_kill_switch.settings.DISABLE_RAG_FOR_SOLVE", False)
    with pytest.raises(RAGDisabledForSolveError):
        rag_kill_switch.require_blind_solve_controls("unit-test")

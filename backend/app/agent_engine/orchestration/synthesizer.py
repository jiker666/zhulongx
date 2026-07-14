from __future__ import annotations

from typing import Any, Iterable

from app.agent_engine.agents.base import AgentSummary


class ResultSynthesizer:
    def synthesize(self, summaries: Iterable[AgentSummary]) -> dict[str, Any]:
        completed = [item for item in summaries if item.status == "completed"]
        facts: dict[str, dict[str, Any]] = {}
        evidence: dict[str, dict[str, Any]] = {}
        hypotheses: dict[str, dict[str, Any]] = {}
        for summary in completed:
            for item in summary.facts:
                value = dict(item)
                facts[str(value.get("fact_id") or repr(value))] = value
            for item in summary.evidence:
                value = dict(item)
                evidence[str(value.get("evidence_id") or value.get("event_id") or repr(value))] = value
            for item in summary.hypotheses:
                value = dict(item)
                hypotheses[str(value.get("hypothesis_id") or repr(value))] = value
        return {
            "summaries": [item.summary for item in completed],
            "facts": list(facts.values()),
            "hypotheses": list(hypotheses.values()),
            "evidence": list(evidence.values()),
            "recommendations": list(dict.fromkeys(value for item in completed for value in item.recommendations)),
            "blocked_agents": [item.agent_id for item in summaries if item.status != "completed"],
        }

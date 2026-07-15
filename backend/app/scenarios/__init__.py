from app.scenarios.base import Scenario, ScenarioRegistry
from app.scenarios.ctf import CTFScenario
from app.scenarios.incident_response import IncidentResponseScenario
from app.scenarios.pentest import PentestScenario
from app.scenarios.reverse_forensics import ReverseForensicsScenario
from app.scenarios.vuln_analysis import VulnerabilityAnalysisScenario


def default_scenarios() -> ScenarioRegistry:
    registry = ScenarioRegistry()
    for scenario in (
        CTFScenario(),
        VulnerabilityAnalysisScenario(),
        IncidentResponseScenario(),
        ReverseForensicsScenario(),
        PentestScenario(),
    ):
        registry.register(scenario)
    return registry


__all__ = [
    "CTFScenario",
    "IncidentResponseScenario",
    "PentestScenario",
    "ReverseForensicsScenario",
    "Scenario",
    "ScenarioRegistry",
    "VulnerabilityAnalysisScenario",
    "default_scenarios",
]

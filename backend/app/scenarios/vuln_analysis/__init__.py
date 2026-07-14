from app.agent_engine.validation.structured import StructuredOutputValidator
from app.scenarios.base import Scenario


class VulnerabilityAnalysisScenario(Scenario):
    name = "vuln_analysis"

    def recommended_skills(self):
        return ("web", "reverse")

    def validator(self):
        return StructuredOutputValidator(required_fields=("finding", "impact", "evidence", "remediation"), result_type="vulnerability finding")

    def completion_schema(self):
        return {"type": "object", "required": ["finding", "impact", "evidence", "remediation"]}

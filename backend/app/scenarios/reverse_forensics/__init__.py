from app.agent_engine.validation.structured import StructuredOutputValidator
from app.scenarios.base import Scenario


class ReverseForensicsScenario(Scenario):
    name = "reverse_forensics"

    def recommended_skills(self):
        return ("reverse", "forensics")

    def validator(self):
        return StructuredOutputValidator(required_fields=("conclusion", "evidence", "reproduction"), result_type="reverse or forensics analysis")

    def completion_schema(self):
        return {"type": "object", "required": ["conclusion", "evidence", "reproduction"]}

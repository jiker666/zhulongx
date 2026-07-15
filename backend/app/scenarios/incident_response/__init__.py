from app.agent_engine.validation.structured import StructuredOutputValidator
from app.scenarios.base import Scenario


class IncidentResponseScenario(Scenario):
    name = "incident_response"

    def recommended_skills(self):
        return ("forensics", "malware")

    def validator(self):
        return StructuredOutputValidator(required_fields=("timeline", "iocs", "root_cause", "actions"), result_type="incident response")

    def completion_schema(self):
        return {"type": "object", "required": ["timeline", "iocs", "root_cause", "actions"]}

from app.scenarios.workflow_factory import build_plan, build_workflow
from app.scenarios.reverse_forensics.manifest import manifest


def plan(objective: str):
    return build_plan(manifest, objective)


def workflow(objective: str):
    return build_workflow(manifest, plan(objective))

from __future__ import annotations

import statistics
from typing import Any


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    solved = sum(1 for item in results if item["validated"])
    false_answers = sum(1 for item in results if item.get("false_answer"))
    interventions = sum(1 for item in results if item["status"] == "human_required")
    invalid_calls = sum(int(item.get("invalid_tool_calls", 0)) for item in results)
    timeouts = sum(1 for item in results if item["status"] == "timed_out")
    durations = sorted(float(item["elapsed_seconds"]) for item in results)
    case_groups: dict[str, list[bool]] = {}
    scenario_groups: dict[str, list[dict[str, Any]]] = {}
    category_groups: dict[str, list[dict[str, Any]]] = {}
    for item in results:
        case_groups.setdefault(item["case_id"], []).append(bool(item["validated"]))
        scenario_groups.setdefault(str(item.get("scenario", "unknown")), []).append(item)
        category_groups.setdefault(str(item.get("category", "unknown")), []).append(item)
    reproducible = sum(1 for outcomes in case_groups.values() if len(set(outcomes)) == 1)
    variances = [statistics.pvariance(int(value) for value in outcomes) for outcomes in case_groups.values()]
    p95_index = max(0, min(len(durations) - 1, int(round(0.95 * len(durations) + 0.5)) - 1)) if durations else 0
    return {
        "runs": total,
        "solved_or_validated_rate": solved / total if total else 0.0,
        "false_answer_rate": false_answers / total if total else 0.0,
        "human_intervention_rate": interventions / total if total else 0.0,
        "invalid_tool_call_rate": invalid_calls / total if total else 0.0,
        "timeout_rate": timeouts / total if total else 0.0,
        "median_time": statistics.median(durations) if durations else 0.0,
        "p95_time": durations[p95_index] if durations else 0.0,
        "mean_tokens": statistics.mean(item.get("tokens", 0) for item in results) if results else 0.0,
        "mean_cost": statistics.mean(item.get("cost_usd", 0.0) for item in results) if results else 0.0,
        "reproducibility_rate": reproducible / len(case_groups) if case_groups else 0.0,
        "mean_case_outcome_variance": statistics.mean(variances) if variances else 0.0,
        "scenario_breakdown": {
            name: {
                "runs": len(items),
                "validated_rate": sum(1 for item in items if item["validated"]) / len(items),
            }
            for name, items in sorted(scenario_groups.items())
        },
        "category_breakdown": {
            name: {
                "runs": len(items),
                "validated_rate": sum(1 for item in items if item["validated"]) / len(items),
            }
            for name, items in sorted(category_groups.items())
        },
    }

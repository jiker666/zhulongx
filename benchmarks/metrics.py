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
    repetition_groups: dict[str, list[tuple[int, bool]]] = {}
    scenario_groups: dict[str, list[dict[str, Any]]] = {}
    category_groups: dict[str, list[dict[str, Any]]] = {}
    for item in results:
        case_groups.setdefault(item["case_id"], []).append(bool(item["validated"]))
        repetition_groups.setdefault(item["case_id"], []).append(
            (int(item.get("repetition", 1)), bool(item["validated"]))
        )
        scenario_groups.setdefault(str(item.get("scenario", "unknown")), []).append(item)
        category_groups.setdefault(str(item.get("category", "unknown")), []).append(item)
    reproducible = sum(1 for outcomes in case_groups.values() if len(set(outcomes)) == 1)
    variances = [statistics.pvariance(int(value) for value in outcomes) for outcomes in case_groups.values()]
    p95_index = max(0, min(len(durations) - 1, int(round(0.95 * len(durations) + 0.5)) - 1)) if durations else 0
    first_attempts = [
        next((validated for repetition, validated in sorted(outcomes) if repetition == 1), False)
        for outcomes in repetition_groups.values()
    ]
    first_three = [
        any(validated for repetition, validated in outcomes if repetition <= 3)
        for outcomes in repetition_groups.values()
    ]
    total_tool_calls = sum(int(item.get("tool_call_count", 0)) for item in results)
    duplicate_tool_calls = sum(int(item.get("duplicate_tool_calls", 0)) for item in results)
    useful_evidence = sum(int(item.get("useful_evidence_count", 0)) for item in results)
    validation_attempts = sum(int(item.get("validation_attempts", 0)) for item in results)
    validator_rejections = sum(int(item.get("validator_rejections", 0)) for item in results)
    return {
        "runs": total,
        "solved_or_validated_rate": solved / total if total else 0.0,
        "pass_at_1": sum(first_attempts) / len(first_attempts) if first_attempts else 0.0,
        "pass_at_3": sum(first_three) / len(first_three) if first_three else 0.0,
        "false_answer_rate": false_answers / total if total else 0.0,
        "human_intervention_rate": interventions / total if total else 0.0,
        "invalid_tool_call_rate": invalid_calls / total if total else 0.0,
        "timeout_rate": timeouts / total if total else 0.0,
        "median_time": statistics.median(durations) if durations else 0.0,
        "p95_time": durations[p95_index] if durations else 0.0,
        "mean_tokens": statistics.mean(item.get("tokens", 0) for item in results) if results else 0.0,
        "mean_cost": statistics.mean(item.get("cost_usd", 0.0) for item in results) if results else 0.0,
        "mean_plan_revisions": statistics.mean(item.get("plan_revisions", 0) for item in results) if results else 0.0,
        "useful_evidence_per_tool_call": useful_evidence / total_tool_calls if total_tool_calls else 0.0,
        "duplicate_tool_call_rate": duplicate_tool_calls / total_tool_calls if total_tool_calls else 0.0,
        "validator_rejection_rate": validator_rejections / validation_attempts if validation_attempts else 0.0,
        "independent_verifier_rejection_rate": None,
        "mean_agents": statistics.mean(item.get("agent_count", 0) for item in results) if results else 0.0,
        "mean_peak_tool_concurrency": statistics.mean(item.get("peak_tool_concurrency", 0) for item in results) if results else 0.0,
        "timeout_cancel_cleanup": {
            "status": "not_exercised",
            "reason": "the offline fixture set contains no cancellation case; release lifecycle tests cover cleanup",
        },
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

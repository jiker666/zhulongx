#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from app.agent_engine.budget import BudgetLimits  # noqa: E402
from app.agent_engine.events import EventType  # noqa: E402
from app.agent_engine.service import agent_run_service  # noqa: E402
from app.agent_engine.state import InputReference, ModelConfig, NetworkPolicy, RunRequest  # noqa: E402
from app.agent_engine.validation.ctf import CTFValidator  # noqa: E402
from app.config import settings  # noqa: E402
from benchmarks.metrics import summarize  # noqa: E402
from benchmarks.runner import _matches_expected, _structured_validator, git_commit, load_cases, local_target  # noqa: E402


def _configured() -> bool:
    return bool(
        settings.LLM_ENABLED
        and settings.GLM_API_KEY
        and settings.GLM_API_KEY not in {"replace_me", "your-api-key", "your_api_key_here"}
    )


def _event_metrics(events) -> dict[str, object]:
    tool_requests = [event for event in events if event.type == EventType.TOOL_REQUESTED.value]
    fingerprints = [
        json.dumps(
            [event.payload.get("name"), event.payload.get("arguments", {})],
            ensure_ascii=False,
            sort_keys=True,
        )
        for event in tool_requests
    ]
    evidence_ids = {
        str(evidence_id)
        for event in events
        if event.type == EventType.CANDIDATE_DETECTED.value
        for evidence_id in event.payload.get("evidence_event_ids", ())
        if evidence_id
    }
    active_agents: set[str] = set()
    active_tools: set[str] = set()
    peak_agents = 0
    peak_tools = 0
    for event in events:
        agent_id = event.agent_id or str(event.payload.get("agent_id", ""))
        tool_call_id = str(event.payload.get("tool_call_id", ""))
        if event.type == EventType.AGENT_SPAWNED.value and agent_id:
            active_agents.add(agent_id)
            peak_agents = max(peak_agents, len(active_agents))
        elif event.type in {EventType.AGENT_COMPLETED.value, EventType.AGENT_CANCELLED.value}:
            active_agents.discard(agent_id)
        if event.type == EventType.TOOL_STARTED.value and tool_call_id:
            active_tools.add(tool_call_id)
            peak_tools = max(peak_tools, len(active_tools))
        elif event.type in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
            active_tools.discard(tool_call_id)
    agent_ids = {
        event.agent_id
        for event in events
        if event.agent_id and event.agent_id != "agent_root"
    }
    tool_call_count = sum(1 for event in events if event.type == EventType.TOOL_STARTED.value)
    usage = [
        dict(event.payload.get("usage") or {})
        for event in events
        if event.type == EventType.MODEL_RESPONDED.value
    ]
    downgraded = sorted({
        str(field)
        for event in events
        if event.type == EventType.PROVIDER_CAPABILITY_NEGOTIATED.value
        for field in event.payload.get("downgraded_fields", ())
    })
    return {
        "tokens": sum(int(item.get("total_tokens", 0) or 0) for item in usage),
        "cost_usd": sum(float(item.get("cost_usd", 0.0) or 0.0) for item in usage),
        "tool_call_count": tool_call_count,
        "duplicate_tool_calls": len(fingerprints) - len(set(fingerprints)),
        "useful_evidence_count": len(evidence_ids),
        "useful_evidence_per_tool_call": len(evidence_ids) / tool_call_count if tool_call_count else 0.0,
        "plan_revisions": sum(1 for event in events if event.type == EventType.PLAN_REVISED.value),
        "validation_attempts": sum(1 for event in events if event.type == EventType.VALIDATION_REQUESTED.value),
        "validator_rejections": sum(1 for event in events if event.type == EventType.CANDIDATE_REJECTED.value),
        "agent_count": len(agent_ids),
        "peak_agent_concurrency": peak_agents,
        "peak_tool_concurrency": peak_tools,
        "capability_downgraded_fields": downgraded,
    }


def run_case(case: dict, repetition: int, args: argparse.Namespace) -> dict[str, object]:
    public_dir = ROOT / "benchmarks" / "public" / case["id"]
    challenge = json.loads((public_dir / "challenge.json").read_text(encoding="utf-8"))
    workspace = Path(tempfile.mkdtemp(prefix=f"zhulongx_live_{case['id']}_"))
    copied: list[Path] = []
    for source in public_dir.iterdir():
        if source.is_file() and source.name != "challenge.json":
            target = workspace / source.name
            shutil.copy2(source, target)
            copied.append(target)
    target_context = local_target(challenge) if case["scenario"] == "pentest" else _null_target()
    session = None
    try:
        with target_context as target_url:
            objective = challenge["objective"]
            authorization: dict[str, object] = {
                "authorized": True,
                "allow_process": case["scenario"] != "pentest",
            }
            network_policy = NetworkPolicy()
            if case["scenario"] == "pentest":
                target_port = int(target_url.rsplit(":", 1)[1].split("/", 1)[0])
                objective = f"{objective}\nScoped fixture target: {target_url}"
                authorization["allow_private_network"] = True
                network_policy = NetworkPolicy(
                    mode="allowlist",
                    allowed_hosts=("127.0.0.1/32",),
                    allowed_ports=(target_port,),
                )
            request = RunRequest(
                task_id=f"live_{case['id']}_{repetition}",
                title=challenge["title"],
                objective=objective,
                workspace=str(workspace),
                inputs=tuple(InputReference(path.name, str(path), readonly=True) for path in copied),
                scenario=case["scenario"],
                authorization=authorization,
                network_policy=network_policy,
                budgets=BudgetLimits(
                    max_seconds=args.max_seconds,
                    max_model_requests=args.max_model_requests,
                    max_tool_calls=args.max_tool_calls,
                    max_tokens=args.max_tokens,
                    max_cost_usd=args.max_cost_usd,
                ),
                model_config=ModelConfig(
                    provider="glm",
                    model=settings.GLM_MODEL,
                    temperature=args.temperature,
                    max_tokens=args.max_output_tokens,
                    thinking_enabled=True,
                    clear_thinking=False,
                    reasoning_effort=args.reasoning_effort,
                    stream=True,
                    tool_stream=True,
                    context_budget_tokens=args.context_budget_tokens,
                ),
                execution_mode="auto",
                max_parallel_agents=args.max_parallel_agents,
            )
            expected = case["expected"]
            validator = (
                CTFValidator(flag_pattern=r"flag\{[^}]+\}", evaluator=lambda value: value == expected)
                if case["scenario"] == "ctf"
                else _structured_validator(case["scenario"], dict(expected))
            )
            session = agent_run_service.create_session(request, validator, register=False)
            if not session.sandbox.release_capable:
                raise RuntimeError("preloaded release container sandbox is unavailable")
            started = time.monotonic()
            state = session.run()
            elapsed = time.monotonic() - started
            events = session.event_stream()
            candidate = (state.final_output or {}).get("candidate", "")
            matches = _matches_expected(candidate, expected)
            metrics = _event_metrics(events)
            return {
                "case_id": case["id"],
                "category": case["category"],
                "scenario": case["scenario"],
                "repetition": repetition,
                "status": state.status.value,
                "validated": state.status.value == "succeeded" and matches,
                "false_answer": state.status.value == "succeeded" and not matches,
                "elapsed_seconds": round(elapsed, 4),
                "human_required": state.status.value == "human_required",
                "event_count": len(events),
                "invalid_tool_calls": sum(
                    1 for event in events
                    if event.type == EventType.TOOL_FAILED.value
                    and event.payload.get("metadata", {}).get("code") in {"unknown_tool", "invalid_arguments"}
                ),
                "timeout_cancel_cleanup": "not_exercised",
                **metrics,
            }
    finally:
        manager = getattr(session, "manager", None)
        if manager is not None:
            manager.shutdown(cancel=True)
        if session is not None:
            session.sandbox.abort_all()
        shutil.rmtree(workspace, ignore_errors=True)


class _null_target:
    def __enter__(self):
        return ""

    def __exit__(self, *_args):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Run hidden-evaluator fixtures through the live GLM-5.2 Coordinator.")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--filter", default="")
    parser.add_argument("--max-cases", type=int, default=0)
    parser.add_argument("--output", default="benchmarks/results/live_latest.json")
    parser.add_argument("--max-seconds", type=float, default=600)
    parser.add_argument("--max-model-requests", type=int, default=100)
    parser.add_argument("--max-tool-calls", type=int, default=200)
    parser.add_argument("--max-tokens", type=int, default=250_000)
    parser.add_argument("--max-cost-usd", type=float, default=10.0)
    parser.add_argument("--max-output-tokens", type=int, default=8192)
    parser.add_argument("--context-budget-tokens", type=int, default=128_000)
    parser.add_argument("--max-parallel-agents", type=int, default=4)
    parser.add_argument("--temperature", type=float, default=0.1)
    parser.add_argument("--reasoning-effort", default="max")
    args = parser.parse_args()
    if not _configured():
        print("live GLM-5.2 evaluation prerequisites are not configured")
        return 2
    cases = [case for case in load_cases() if not args.filter or args.filter in case["id"]]
    if args.max_cases > 0:
        cases = cases[:args.max_cases]
    results = [
        run_case(case, repetition, args)
        for case in cases
        for repetition in range(1, args.repeat + 1)
    ]
    metrics = summarize(results)
    metrics["mean_peak_agent_concurrency"] = (
        sum(int(item.get("peak_agent_concurrency", 0)) for item in results) / len(results)
        if results else 0.0
    )
    report = {
        "mode": "live_glm52_hidden_coordinator",
        "claim": "Live GLM-5.2 result using hidden evaluators and the canonical auto Coordinator path.",
        "provider": "GLM52Provider",
        "model": settings.GLM_MODEL,
        "endpoint_type": "configured native GLM-5.2 OpenAI-compatible endpoint",
        "commit": git_commit(),
        "case_count": len(cases),
        "repetitions": args.repeat,
        "results": results,
        "metrics": metrics,
        "capability_downgraded_fields": sorted({
            field
            for item in results
            for field in item.get("capability_downgraded_fields", ())
        }),
    }
    output = (ROOT / args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"output": str(output.relative_to(ROOT)), "metrics": metrics}, indent=2))
    return 0 if results and all(item["validated"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

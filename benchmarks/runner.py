#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import http.server
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from app.agent_engine.budget import BudgetLimits  # noqa: E402
from app.agent_engine.events import AppendOnlyEventStore, EventType  # noqa: E402
from app.agent_engine.sandbox.container import ContainerSandbox  # noqa: E402
from app.agent_engine.sandbox.local_test import LocalTestSandbox  # noqa: E402
from app.agent_engine.session import AgentSession  # noqa: E402
from app.agent_engine.state import InputReference, NetworkPolicy, RunRequest  # noqa: E402
from app.agent_engine.validation.ctf import CTFValidator  # noqa: E402
from app.agent_engine.validation.structured import StructuredOutputValidator  # noqa: E402
from benchmarks.metrics import summarize  # noqa: E402
from benchmarks.mock_provider import BenchmarkMockProvider  # noqa: E402


PUBLIC_MANIFEST = ROOT / "benchmarks" / "manifest.json"
EVALUATOR_MANIFEST = ROOT / "benchmarks" / "hidden" / "manifest.json"


def load_cases() -> list[dict]:
    public = json.loads(PUBLIC_MANIFEST.read_text(encoding="utf-8"))
    evaluators = json.loads(EVALUATOR_MANIFEST.read_text(encoding="utf-8"))["evaluators"]
    return [{**case, "expected": evaluators[case["id"]]} for case in public["cases"]]


def git_commit() -> str:
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else "unknown"


@contextlib.contextmanager
def local_target(challenge: dict):
    response_body = str(challenge.get("target_response", "VULN:unknown")).encode("utf-8")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(response_body)

        def log_message(self, _format, *_args):
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}{challenge.get('target_path', '/')}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _structured_validator(scenario: str, expected: dict[str, object]) -> StructuredOutputValidator:
    contracts = {
        "vuln_analysis": (("finding", "impact", "evidence", "remediation"), "vulnerability finding"),
        "pentest": (("finding", "scope", "evidence", "remediation"), "scoped pentest finding"),
        "reverse_forensics": (("conclusion", "evidence", "reproduction"), "reverse or forensics analysis"),
        "incident_response": (("timeline", "iocs", "root_cause", "actions"), "incident response"),
    }
    required, result_type = contracts[scenario]
    return StructuredOutputValidator(
        required_fields=required,
        result_type=result_type,
        evaluator=lambda document: all(document.get(key) == value for key, value in expected.items()),
    )


def _matches_expected(candidate: object, expected: object) -> bool:
    if isinstance(expected, str):
        return candidate == expected
    try:
        document = json.loads(str(candidate))
    except (TypeError, json.JSONDecodeError):
        return False
    return isinstance(document, dict) and all(document.get(key) == value for key, value in dict(expected).items())


def run_case(case: dict, repetition: int, *, sandbox_mode: str = "local") -> dict:
    public_dir = ROOT / "benchmarks" / "public" / case["id"]
    challenge = json.loads((public_dir / "challenge.json").read_text(encoding="utf-8"))
    expected = case.get("expected")
    if expected is None:
        expected = json.loads(EVALUATOR_MANIFEST.read_text(encoding="utf-8"))["evaluators"][case["id"]]
    workspace = Path(tempfile.mkdtemp(prefix=f"zhulongx_bench_{case['id']}_"))
    copied: list[Path] = []
    for source in public_dir.iterdir():
        if source.is_file() and source.name != "challenge.json":
            target = workspace / source.name
            shutil.copy2(source, target)
            copied.append(target)
    target_context = local_target(challenge) if case["scenario"] == "pentest" else contextlib.nullcontext("")
    try:
        with target_context as target_url:
            events = AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl")
            network_policy = NetworkPolicy()
            authorization = {"authorized": True, "allow_process": case["scenario"] != "pentest"}
            if case["scenario"] == "pentest":
                target_port = int(target_url.rsplit(":", 1)[1].split("/", 1)[0])
                authorization["allow_private_network"] = True
                network_policy = NetworkPolicy(
                    mode="allowlist",
                    allowed_hosts=("127.0.0.1/32",),
                    allowed_ports=(target_port,),
                )
            request = RunRequest(
                task_id=f"bench_{case['id']}_{repetition}",
                title=challenge["title"],
                objective=challenge["objective"],
                workspace=str(workspace),
                inputs=tuple(InputReference(path.name, str(path), readonly=True) for path in copied),
                scenario=case["scenario"],
                authorization=authorization,
                network_policy=network_policy,
                budgets=BudgetLimits(
                    max_seconds=20,
                    max_model_requests=5,
                    max_tool_calls=5,
                    max_tokens=1000,
                    max_cost_usd=0.01,
                ),
            )
            if case["scenario"] == "ctf":
                validator = CTFValidator(flag_pattern=r"flag\{[^}]+\}", evaluator=lambda value: value == expected)
            else:
                validator = _structured_validator(case["scenario"], dict(expected))
            if sandbox_mode == "container":
                sandbox = ContainerSandbox(workspace, readonly_paths=copied)
                if not sandbox.release_capable:
                    raise RuntimeError("container runtime or preloaded benchmark image unavailable")
            elif sandbox_mode == "local":
                sandbox = LocalTestSandbox(workspace)
            else:
                raise ValueError(f"unsupported sandbox mode: {sandbox_mode}")
            session = AgentSession(
                request,
                provider=BenchmarkMockProvider(case["scenario"], target_url=target_url),
                validator=validator,
                events=events,
                sandbox=sandbox,
            )
            started = time.monotonic()
            state = session.run()
            elapsed = time.monotonic() - started
            invalid = sum(
                1 for event in session.event_stream()
                if event.type == EventType.TOOL_FAILED.value
                and event.payload.get("metadata", {}).get("code") in {"unknown_tool", "invalid_arguments"}
            )
            tool_failures = [
                {
                    "name": event.payload.get("name"),
                    "error": event.payload.get("error"),
                    "output": str(event.payload.get("output", ""))[:500],
                }
                for event in session.event_stream()
                if event.type == EventType.TOOL_FAILED.value
            ]
            candidate = (state.final_output or {}).get("candidate", "")
            matches = _matches_expected(candidate, expected)
            return {
                "case_id": case["id"],
                "category": case["category"],
                "scenario": case["scenario"],
                "repetition": repetition,
                "status": state.status.value,
                "error": state.error,
                "validated": state.status.value == "succeeded" and matches,
                "false_answer": state.status.value == "succeeded" and not matches,
                "candidate": candidate,
                "elapsed_seconds": round(elapsed, 4),
                "tokens": state.budget_usage.get("tokens", 0),
                "cost_usd": state.budget_usage.get("cost_usd", 0.0),
                "invalid_tool_calls": invalid,
                "tool_failures": tool_failures,
                "event_count": len(session.event_stream()),
            }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--sandbox", choices=("container", "local"), default="container")
    parser.add_argument("--output", default="benchmarks/results/latest.json")
    args = parser.parse_args()
    cases = load_cases()
    results = [
        run_case(case, repetition, sandbox_mode=args.sandbox)
        for case in cases
        for repetition in range(1, args.repeat + 1)
    ]
    report = {
        "mode": "agent_session_mock_hidden_25",
        "claim": "Hidden-evaluator harness and deterministic AgentSession integration only; not a live-model solve rate.",
        "provider": "BenchmarkMockProvider",
        "sandbox": "ContainerSandbox" if args.sandbox == "container" else "LocalTestSandbox (test-only)",
        "commit": git_commit(),
        "case_count": len(cases),
        "scenario_count": len({case["scenario"] for case in cases}),
        "repetitions": args.repeat,
        "budgets": {"seconds": 20, "model_requests": 5, "tool_calls": 5, "tokens": 1000, "cost_usd": 0.01},
        "results": results,
        "metrics": summarize(results),
    }
    output = (ROOT / args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        display_output = str(output.relative_to(ROOT))
    except ValueError:
        display_output = str(output)
    print(json.dumps({"output": display_output, "metrics": report["metrics"]}, indent=2))
    return 0 if all(item["validated"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

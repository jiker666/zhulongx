from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Sequence

from app.agent_engine.budget import BudgetLimits
from app.agent_engine.state import InputReference, ModelConfig, NetworkPolicy, RunRequest


class CTFRunRequestAdapter:
    """Translate a legacy CTF task snapshot without evaluator-only fields."""

    def adapt(
        self,
        task: Mapping[str, Any],
        *,
        workspace: str | Path,
        allowed_hosts: Sequence[str] = (),
        allowed_ports: Sequence[int] = (),
        provider: str = "mock",
        model: str = "scripted",
    ) -> RunRequest:
        root = Path(workspace).expanduser().resolve()
        inputs: list[InputReference] = []
        for raw_path in task.get("attachments", []) or []:
            candidate = (root / Path(str(raw_path)).name).resolve(strict=False)
            try:
                candidate.relative_to(root)
            except ValueError:
                continue
            if candidate.is_file() and candidate.name != "expected_flag.txt":
                inputs.append(InputReference(name=candidate.name, path=str(candidate), readonly=True))
        authorized = bool(task.get("authorized", False))
        requested_network = bool(task.get("allow_network", False))
        network_enabled = authorized and requested_network and bool(allowed_hosts)
        max_seconds = float(task.get("max_time_sec", 600) or 600)
        max_rounds = int(task.get("max_rounds", 0) or 0)
        return RunRequest(
            task_id=str(task.get("task_id") or "legacy_ctf_task"),
            title=str(task.get("title") or "CTF task"),
            objective=str(task.get("description") or "Solve the authorized CTF task using workspace evidence."),
            workspace=str(root),
            inputs=tuple(inputs),
            scenario="ctf",
            authorization={
                "authorized": authorized,
                "allow_process": authorized,
                "allow_private_network": bool(task.get("allow_private_network", False)),
            },
            network_policy=NetworkPolicy(
                mode="allowlist" if network_enabled else "deny",
                allowed_hosts=tuple(allowed_hosts) if network_enabled else (),
                allowed_ports=tuple(int(port) for port in allowed_ports) if network_enabled else (),
            ),
            budgets=BudgetLimits(
                max_seconds=max_seconds,
                max_model_requests=max_rounds if max_rounds > 0 else 50,
                max_tool_calls=max((max_rounds if max_rounds > 0 else 50) * 3, 10),
            ),
            model_config=ModelConfig(provider=provider, model=model),
        )

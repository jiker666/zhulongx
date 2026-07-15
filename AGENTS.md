# ZHULONG-X + Codex

You are operating inside the ZHULONG-X CTF/security agent project.

Primary goal: evolve and operate Agent Engine v3 as the canonical native orchestration core.

Important paths:
- `backend/app/agent_engine/session.py` — single-Agent lifecycle authority.
- `backend/app/agent_engine/orchestration/` — Coordinator, subagents, workflow, replan, and verification.
- `backend/app/agent_engine/service.py` — canonical session construction path for all formal APIs.
- `backend/app/scenarios/` — five executable scenario manifests, plans, workflows, and validators.
- `backend/app/core/cc_bridge_runtime.py` — explicit research compatibility only; never a formal API fallback.

Safety and solve constraints:
- Treat CTF solve workspaces as sandboxed task directories.
- Do not leak API keys or `.env` values into reports.
- Do not enable network unless the task is explicitly authorized and scoped.
- Do not overwrite uploaded original attachments.
- Keep formal API modules free of imports from the old orchestrator, old runtime, and bridge.
- Label mock, offline, and live-model benchmark results separately.

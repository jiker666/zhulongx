# ZHULONG-X + Codex

You are operating inside the ZHULONG-X CTF/security agent project.

Primary goal: use Codex as the orchestration core instead of the older Python-only agent loop.

Important paths:
- `backend/app/core/cc_bridge_runtime.py` — bridge runtime that invokes Codex CLI.
- `backend/app/core/ctf_agent_orchestrator.py` — now prefers `CcBridgeRuntime` when `CC_RUNTIME_ENABLED=true`.
- `backend/vendor/Codex/` — vendored user-provided unofficial Codex source tree.
- `backend/scripts/cc-bridge-runner.sh` — helper wrapper after `vendor/Codex` is built.

Safety and solve constraints:
- Treat CTF solve workspaces as sandboxed task directories.
- Do not leak API keys or `.env` values into reports.
- Do not enable network unless the task is explicitly authorized and scoped.
- Do not overwrite uploaded original attachments.

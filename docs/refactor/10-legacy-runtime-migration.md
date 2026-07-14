# Legacy Runtime Migration and Removal List

## Formal path after v3

`/api/agent/runs` and `/api/ctf` both construct sessions through `AgentRunService`. Formal API modules do not
import `CTFAgentOrchestrator`, old `AgentRuntime`, or `CcBridgeRuntime`; an automated test enforces this.

## Preserved compatibility

- `core/ctf_agent_orchestrator.py`: retained for historical tests and old direct callers only.
- `core/agent_runtime.py`: retained for historical protocol tests only.
- `core/cc_bridge_runtime.py`: explicit research compatibility; disabled by default, absent from `.env.example`,
  and fallback requires a dedicated opt-in setting.
- `LegacyTaskProjection`: retained so existing CTF pages can consume canonical events while migration completes.

## Retired behavior

- no formal route selects runtime by a process-global CC switch;
- no formal route silently falls back after provider/runtime failure;
- no candidate is accepted by regex or stdout confidence alone;
- no API-created CTF candidate is rejected merely because an external evaluator is absent;
- no provider is chosen without respecting the run's model configuration.

## Final deletion prerequisites

Delete the three compatibility modules and `CC_RUNTIME_*` settings after all downstream direct imports are removed,
legacy-only tests are archived, one release cycle has used the canonical API, and rollback artifacts are retained.
The release packager already excludes vendor trees and dependency caches.

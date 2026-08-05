# Project Engineering Rules

- Keep the core task loop domain-neutral. Do not add challenge IDs, site-specific selectors, fixed flags, or answer templates.
- Every active network capability must pass through `PolicyEngine` and an operator-owned scope configuration.
- Per-run scope overrides may only narrow the configured scope.
- Tools must return bounded output and accept an `AbortSignal` where blocking work is possible.
- Never persist model keys, authorization headers, cookies, or hidden reasoning in run artifacts.
- New tools require policy tests, budget behavior, an audit event, and documentation of side effects.
- Use deterministic faux-model tests for orchestration behavior; live-model tests belong in opt-in evaluation suites.
- `npm run check` is the merge gate.

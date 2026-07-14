# Agent Engine v3 Operator Guide

## Before a run

1. Confirm task scope, network allowlist, ports, process permission, time/tool/token/cost budgets, and sandbox image.
2. Upload originals through the task API. Originals remain immutable; derived files use the run workspace.
3. Select scenario and per-run model/profile. Keep credentials in environment/deployment secrets.

## During a run

- Plan view shows nodes, dependencies, status, revision version, and reason.
- Agent view shows role, task, parent, and lifecycle state.
- Evidence view separates confirmed facts, open/refuted hypotheses, artifacts, and verifier outcomes.
- Tool events show schema request, policy decision, execution result, evidence/artifact references, and duration.
- Budget view reports elapsed time, model/tool calls, tokens, and cost.

Use stop to propagate abort to the active session and sandbox. Do not remove run files while a worker is active.

## Human handoff

Read completed work, facts/evidence, failed paths, blocker, question, recommendation, risk, and checkpoint sequence.
Submit only the requested public answer. Put credentials into the deployment secret mechanism and pass a reference,
not the secret value. The answer event restores the same session and resumes it.

## External CTF judgment

For `pending_external`, submit the candidate to the competition judge. Record accepted to finish the run, or rejected
to append the verdict and resume exploration. The original candidate and evidence remain in the audit chain.

## Export and recovery

Download `/api/agent/runs/{run_id}/audit` for the canonical JSON report. After service restart, run metadata,
EventStore, and checkpoint reconstruct the session. Completed tool call IDs replay their stored result.

## Incident handling

- container unavailable: preload the configured image and restore the same run;
- provider error: inspect normalized code, gateway profile, budget, and redacted request metadata;
- repeated failure: inspect replanner decisions and verifier conflict before answering the handoff;
- suspected scope breach: stop immediately, preserve audit/events, and review policy decisions;
- corrupt metadata: isolate the one run directory; startup restoration continues for other runs.

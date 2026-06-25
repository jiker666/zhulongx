# CyberPilot v3 Architecture

CyberPilot v3 keeps the v2 FastAPI + React + Agent Core architecture and adds intent analysis, dynamic decision traces, tool metadata, policy checks, and report export.

## Core Flow

1. Task input is created with `target` and optional `uploaded_file`.
2. `TaskIntentAnalyzer` reads description, URL, file suffix, and ZIP key files.
3. `Planner` generates structured `PlanStep` records with reason, expected input/output, risk, confirmation flag, and fallback strategy.
4. `Executor` runs only enabled tools, checks `PolicyEngine`, records `DecisionTrace`, and broadcasts WebSocket events.
5. `Judge` returns structured observations, evidence, risk, continuation and replan hints.
6. `Reporter` saves Markdown and print-friendly HTML after all tool steps finish.

## Safety Boundary

All default tools are read-only. Network tools use SSRF protection and timeouts. Destructive actions, exploit steps, shell access, persistence, data theft, brute force, and lateral movement are denied by policy and prompt safety filters.

## Tool Metadata

`BaseTool` exposes:

- `input_schema`
- `output_schema`
- `permissions`
- `risk_level`
- `timeout_seconds`
- `tags`

`/api/tools` returns these fields and `PATCH /api/tools/{name}/enabled` controls availability.

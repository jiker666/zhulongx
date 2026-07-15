# Live GLM-5.2 Evaluation

Evaluation date: 2026-07-15

## Status

`NOT RUN`

No live GLM, generic LLM, or gateway API key was configured. No model success rate, token count, cost, latency or capability negotiation observation is inferred from mock/provider unit tests or the offline hidden-fixture result.

## Provider profile

- endpoint type: configured native GLM-5.2 OpenAI-compatible Chat Completions endpoint
- endpoint host: intentionally omitted from the release report
- model ID: `glm-5.2`
- provider implementation: `GLM52Provider`
- execution path: `AgentRunService -> RunSessionFactory -> CoordinatorSession -> LLMSubagentWorker -> AgentSession`
- sandbox: preloaded `python:3.11-slim` through `ContainerSandbox`

No credential value, authorization header, internal gateway hostname, raw response or private reasoning transcript is present in this document.

## Requested capabilities

The live runner requests:

- thinking enabled
- `clear_thinking=false`
- configurable reasoning effort, default `max`
- SSE streaming and streaming tool arguments
- preserved/interleaved thinking continuity
- maximum 128 exposed function schemas after capability selection
- 128,000-token context budget by default
- public decision summaries with private reasoning retained only in the restricted transcript store

Observed live capability negotiation: `NOT RUN`. Unit and integration fixtures cover native fields, explicit optional-field downgrade events, 429 retry, malformed/incomplete streams, timeout, cancellation, split tool arguments, preserved-thinking order and public reasoning privacy. These tests prove protocol behavior only.

## Dataset and answer isolation

`benchmarks/live_runner.py` loads 25 public fixtures spanning CTF, scoped pentest, vulnerability analysis, incident response and reverse/forensics. Public challenge descriptions and artifacts contain no expected field. The hidden evaluator manifest is loaded only by the runner to construct the Validator; it is not included in model messages, child context packs, workspaces, tool results, release ZIPs or result records.

Each live case uses `execution_mode=auto`, so the formal factory selects the Coordinator and production LLM child worker. Pentest cases receive only an ephemeral loopback fixture target and an explicit allowlist. Other task/container network access remains disabled.

## Exact commands

One-case smoke:

```bash
export LLM_ENABLED=true
export LLM_PROVIDER=glm
export GLM_API_KEY=YOUR_RUNTIME_SECRET
export AGENT_SANDBOX_RUNTIME=docker
export AGENT_SANDBOX_IMAGE=python:3.11-slim
docker pull python:3.11-slim
python benchmarks/live_runner.py \
  --max-cases 1 \
  --repeat 1 \
  --output benchmarks/results/live_smoke.json
```

Full pass@1/pass@3 evaluation:

```bash
export LLM_ENABLED=true
export LLM_PROVIDER=glm
export GLM_API_KEY=YOUR_RUNTIME_SECRET
export AGENT_SANDBOX_RUNTIME=docker
export AGENT_SANDBOX_IMAGE=python:3.11-slim
python benchmarks/live_runner.py \
  --repeat 3 \
  --max-seconds 600 \
  --max-model-requests 100 \
  --max-tool-calls 200 \
  --max-tokens 250000 \
  --max-cost-usd 10 \
  --reasoning-effort max \
  --output benchmarks/results/live_latest.json
```

`GLM_BASE_URL` and `GLM_MODEL` may be set through the environment for the approved gateway profile. The runner never accepts a key as a command-line argument, so it is not exposed in process listings or reports.

## Metrics

| Metric | Result |
| --- | --- |
| cases / repetitions | NOT RUN |
| validated success rate | NOT RUN |
| pass@1 / pass@3 | NOT RUN |
| reproducibility | NOT RUN |
| human intervention rate | NOT RUN |
| plan revisions | NOT RUN |
| useful evidence per tool call | NOT RUN |
| duplicate tool rate | NOT RUN |
| validator/verifier rejection rate | NOT RUN |
| average Agents / peak concurrency | NOT RUN |
| tokens / wall time / cost | NOT RUN |
| timeout/cancel cleanup | NOT RUN |
| scenario breakdown | NOT RUN |

The result schema also records per-case terminal status, false-answer status, event count, invalid tool calls and capability fields removed by gateway negotiation. It does not store candidates or expected answers.

## Trajectories

Typical live success trajectory: `NOT RUN`.

Typical live failure trajectory: `NOT RUN`.

The deterministic protocol trajectory in `04-verification-report.md` is a separate mock result. The 75-run offline report uses `BenchmarkMockProvider` with real container tools and hidden validators; its 100% validation rate is not a model-quality claim.

## Preconditions for a claim

A live-model claim requires the generated `live_latest.json`, retained failures, scenario breakdown, capability events, token/cost accounting, human intervention data and independent evidence/verifier outcomes. Partial smoke success is reported as smoke only, never as the full solve rate.

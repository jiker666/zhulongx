# GLM-5.2 Harness Migration Plan

## Compatibility rules

- keep existing request fields optional and preserve response/event compatibility where practical
- add `execution_mode=auto` as the default
- keep `AgentSession` behavior available under explicit `single`
- route every formal run constructor through `AgentRunService` and `RunSessionFactory`
- do not import or invoke legacy orchestrators as an error fallback
- preserve original uploaded attachments and mount/copy them read-only
- keep checkpoint formats readable through versioned adapters

## Staged migration

### 1. Canonical run entry

Introduce `ManagedRun`, execution configuration, and `RunSessionFactory`. Generalize `RunManager`. Construct coordinator roots for auto/coordinator requests and preserve explicit single mode. Add API integration tests before changing scenario adapters.

Rollback: select `single` explicitly. No fallback code path is introduced.

### 2. Native GLM-5.2 protocol

Add capability models, a dedicated provider, a streaming accumulator, private reasoning references, parameter validation, and capability events. Retain `OpenAICompatibleProvider` for other providers.

Rollback: select a non-GLM provider explicitly. GLM requests never silently downgrade to the generic parser.

### 3. Production child workers

Implement role execution profiles and `LLMSubagentWorker` over leaf `AgentSession`. Link child events/checkpoints/aborts to the root and return structured handoffs. Enforce concurrency, depth, workspace, and capability limits.

Rollback: explicit `single` mode; coordinator construction fails visibly if the required worker cannot be built.

### 4. Dynamic plan graph

Add deterministic intake, planner schemas, `TaskGraphStore`, patch operations, a dependency scheduler, stuck actions, verifier/refuter workers, and completion policy. Scenario workflows remain planner priors.

Rollback: use the previous accepted graph version from checkpoint; never substitute an unvalidated model response.

### 5. Context and tool harness

Add model-aware token budgets, stable context packs, artifact retrieval, protected native transcript preservation, per-turn tool selection, and lifecycle hooks. Keep `StateReducer` as the only state projection authority.

Rollback: use a smaller validated context pack, not event-count truncation or raw transcript copying.

### 6. Scenarios and UI

Connect all five scenario APIs to the factory and define completion contracts. Extend the event projection and frontend for DAG revisions, agent lanes, knowledge, verdicts, and branch controls. Split large frontend chunks and run the viewport matrix.

Rollback: UI ignores unknown additive event fields; API event schema remains versioned.

### 7. Release hardening

Run compile, full backend, focused Agent Engine, real container release tests, frontend checks, protocol/offline/live benchmarks, secret/answer/reasoning scans, release packaging, and SHA256 generation. Label unavailable live evaluation `NOT RUN` with its command.

## Commit boundaries

1. `chore: capture glm52 orchestration baseline`
2. `refactor: make coordinator the canonical autonomous run`
3. `feat: add native glm52 streaming and thinking protocol`
4. `feat: run llm subagents through the canonical harness`
5. `feat: execute dynamic plan dag with evidence driven replanning`
6. `feat: add token aware context and capability scoped tools`
7. `feat: expose live multi agent operations across security workflows`
8. `chore: harden glm52 agent harness for release`

Each boundary requires focused tests and a clean diff review. User changes discovered during the migration are preserved and incorporated.

## Release gates

The verification report records every gate as passed, failed, skipped, or not run. Local macOS results do not imply Ubuntu results. Mock protocol success does not imply live GLM task success. Any unmet required gate leaves the implementation status as incomplete.


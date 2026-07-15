# Agent Engine v3 Threat Model

## Protected assets

- provider/API credentials and deployment environment;
- uploaded originals and evaluator answers;
- run scope, evidence integrity, event ordering, and checkpoints;
- backend host, local network, container runtime, and other tenants;
- competition decisions and final reports.

## Trust boundaries

Task text, model output, tool arguments, archives, extracted documents, network responses, and executable samples
are untrusted. Provider gateways, container runtime, external judges, and human answers cross explicit boundaries.

## Primary threats and controls

| Threat | Control |
| --- | --- |
| prompt/tool injection | immutable scope, registry allowlist, schema validation, PolicyEngine before every call |
| secret persistence or forwarding | credential-free RunRequest, recursive redaction, profile-bound base URLs, sanitized metadata, minimal child environment |
| path/symlink/archive escape | resolved workspace containment, immutable inputs, ZIP/TAR traversal and link checks |
| host execution | production ContainerSandbox, no image pull, read-only root, dropped capabilities, resource limits |
| network pivot / SSRF | default deny, authorization plus host/port allowlist, DNS/private/metadata checks, no redirects |
| duplicate side effects | stable tool call IDs, checkpoint replay, idempotency metadata, serialized mutating calls |
| false success | evidence binding, independent verifier/reviewer, scenario completion policy, external pending state |
| event tampering or ambiguity | append-only contiguous sequences, schema version, parent/agent/task IDs, reducer replay |
| runaway cost/time/processes | run/subagent budgets, bounded concurrency, watchdogs, abort propagation, process groups |
| cross-agent data leak | role tool scopes, ContextPolicy, artifact visibility, isolated workspace policy |
| malicious archive/document | inventory before extraction, bounded reads/chunks, risk tags, isolated execution |

## Residual risks

- HTTP DNS checks still rely on the client connection resolution unless network enforcement pins the resolved IP.
- Container protection depends on correctly configured Podman/Docker and a trusted preloaded image.
- Basic PDF/Office/image/PCAP extractors provide bounded metadata and indexing, not complete specialist parsing.
- A cooperative subagent worker must observe its cancellation token; process tools additionally rely on sandbox abort.
- Live-model behavior requires opt-in benchmark evidence and cannot be inferred from deterministic fixtures.

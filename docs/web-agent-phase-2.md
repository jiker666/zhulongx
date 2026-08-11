# Web Agent Phase 2

This phase adds bounded Web-specific orchestration tools and a reviewed knowledge base.

## Tools

- `web_collect_baseline`: one bounded `GET` request to an authorized host; returns status, redacted headers, body size, hash, and bounded body evidence. Authorization and cookie header values never enter the tool result.
- `web_knowledge_lookup`: searches generic evidence signals, test plans, verification requirements, and pitfalls.
- `web_compare_responses`: compares two bounded response bodies without declaring a vulnerability.

All three tools remain behind the existing plan, action budget, checkpoint cadence, repeated-action limit, audit chain, and `PolicyEngine`. `web_collect_baseline` also consumes the existing HTTP request budget and is restricted to `scope.allowedHosts` in controlled mode.

The knowledge base intentionally contains methodology and verification criteria, not challenge-specific flags, credentials, fixed targets, or unrestricted exploit payloads.

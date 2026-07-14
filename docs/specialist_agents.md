# Specialist agents

Specialist roles use Agent Engine v3 `SubagentManager`, bounded coordinator
lanes, mailbox messages, and the shared tool registry. Worker capabilities are
ordinary registry definitions and can be granted to a plan node without
creating category-specific runtimes.

The teammate `agent_patterns.py` prototype was removed because it introduced a
second coordinator and broker loop. Useful role concepts map to existing v3
executor, explorer, verifier, and refuter roles.

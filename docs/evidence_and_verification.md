# Evidence and verification

Evidence is projected from canonical Agent Engine events. Tool output becomes
eligible evidence only after a `tool.finished` event linked to its
`tool_call_id`; policy denials and failures remain visible but do not establish
facts. Human evidence is recorded as `evidence.recorded` on the same run.

Candidate validation uses the scenario validator and exact source event IDs.
External acceptance or rejection is appended to the same stream, after which
`StateReducer` determines the terminal state. No competition-specific verifier
or candidate state machine runs beside the v3 validator.

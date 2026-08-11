# Web Agent Phase 3

Phase 3 adds a deterministic contract benchmark rather than live exploitation tests.

## Dataset

`buildWebBenchmarkCases()` produces 50 cases: 10 Web categories crossed with 5 runtime families. The cases cover SQL injection, file upload, SSTI, SSRF, JWT, LFI/path traversal, RCE, Node prototype pollution, PHP logic, and Java deserialization.

## Metrics

`summarizeWebBenchmark()` reports:

- success rate
- average state-machine steps
- average tool calls
- grouped failure reasons

The benchmark uses no live target, credentials, real payloads, or live model requests. It validates orchestration contracts, phase transitions, knowledge lookup, response comparison, policy gating, and deterministic failure accounting. Live-model evaluation remains opt-in and belongs outside the default test suite.

Run it with:

```text
npm run test:benchmark
```


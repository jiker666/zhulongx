# Evaluation Plan

## Required Checks

- `python3 -m compileall app`
- `python3 -m pytest -q`
- `npm run build`
- `podman compose config`

## Demo Scenarios

- Java ZIP upload: `FileParserTool` and `JavaCodeAuditTool` must use `uploaded_file`.
- Log upload: `FileParserTool` and `LogAnalyzerTool` must use `uploaded_file`.
- Web URL: `HttpFingerprintTool`, `DirectoryProbeTool`, and `JSInterfaceExtractorTool` must run in sequence with SSRF protection.

## Review Criteria

- Plan steps include reason, expected input/output, preconditions, risk, confirmation, and fallback.
- Step records include `decision_trace`.
- Reports include task understanding, dynamic decision chain, evidence, risks, suggestions, security boundary, and reproducibility.

# Safety Audit Report

- Failures: 0
- Warnings: 63

## Failures
- None

## Warnings
- Makefile: constrained cleanup/build command `rm -rf`
- backend/Dockerfile: constrained cleanup/build command `rm -rf`
- backend/app/core/code_execution_sandbox.py: sandbox deny/allow-list term `sqlmap`
- backend/app/core/code_execution_sandbox.py: sandbox deny/allow-list term `rm -rf`
- backend/app/core/policy_engine.py: deny-list term `reverse shell`
- backend/app/core/safety.py: deny-list term `reverse shell`
- backend/app/skills/malware/SKILL.md: documented/fixture dangerous term `msfvenom`
- backend/app/skills/misc/SKILL.md: documented/fixture dangerous term `nc -e`
- backend/app/skills/misc/SKILL.md: documented/fixture dangerous term `crontab`
- backend/app/skills/web/SKILL.md: documented/fixture network client usage
- backend/app/tools/log_analyzer.py: suspicious UA detection term `sqlmap`
- backend/app/tools/log_analyzer.py: suspicious UA detection term `masscan`
- backend/tests/test_agent_engine_glm52_provider.py: documented/fixture network client usage
- backend/tests/test_agent_engine_provider.py: documented/fixture network client usage
- backend/tests/test_agent_engine_restore.py: documented/fixture secret pattern
- backend/tests/test_agent_engine_tools.py: documented/fixture network client usage
- backend/tests/test_code_sandbox.py: documented/fixture dangerous term `rm -rf`
- backend/tests/test_context_compressor.py: documented/fixture secret pattern
- backend/tests/test_ctf_misc_solver.py: documented/fixture secret pattern
- backend/tests/test_hard_mode_v8.py: documented/fixture secret pattern
- backend/tests/test_hard_mode_v8.py: documented/fixture secret pattern
- backend/tests/test_hard_mode_v8.py: documented/fixture secret pattern
- backend/tests/test_hard_mode_v8.py: documented/fixture secret pattern
- backend/tests/test_runtime_config.py: documented/fixture secret pattern
- backend/tests/test_shell_tool_policy.py: documented/fixture dangerous term `rm -rf`
- backend/tests/test_tools.py: documented/fixture dangerous term `sqlmap`
- docs/architecture.md: documented/fixture dangerous term `rm -rf`
- docs/benchmark_report.md: documented/fixture dangerous term `rm -rf`
- docs/refactor_glm52/00-baseline.md: documented/fixture dangerous term `rm -rf`
- docs/refactor_glm52/04-verification-report.md: documented/fixture dangerous term `rm -rf`
- docs/risk_control.md: documented/fixture dangerous term `rm -rf`
- docs/round2_summary.md: documented/fixture dangerous term `reverse shell`
- docs/security_boundary.md: documented/fixture dangerous term `reverse shell`
- docs/team_sop.md: documented/fixture dangerous term `rm -rf`
- safety_audit_report.md: documented/fixture dangerous term `reverse shell`
- safety_audit_report.md: documented/fixture dangerous term `/bin/sh -i`
- safety_audit_report.md: documented/fixture dangerous term `nc -e`
- safety_audit_report.md: documented/fixture dangerous term `meterpreter`
- safety_audit_report.md: documented/fixture dangerous term `msfvenom`
- safety_audit_report.md: documented/fixture dangerous term `mimikatz`
- safety_audit_report.md: documented/fixture dangerous term `hydra`
- safety_audit_report.md: documented/fixture dangerous term `sqlmap`
- safety_audit_report.md: documented/fixture dangerous term `masscan`
- safety_audit_report.md: documented/fixture dangerous term `nmap -A`
- safety_audit_report.md: documented/fixture dangerous term `rm -rf`
- safety_audit_report.md: documented/fixture dangerous term `chmod +s`
- safety_audit_report.md: documented/fixture dangerous term `crontab`
- samples/access.log: documented/fixture dangerous term `sqlmap`
- samples/demo_outputs/log_analysis_report.md: documented/fixture dangerous term `sqlmap`
- samples/nginx_access.log: documented/fixture dangerous term `sqlmap`
- scripts/safety_audit.py: documented/fixture dangerous term `reverse shell`
- scripts/safety_audit.py: documented/fixture dangerous term `/bin/sh -i`
- scripts/safety_audit.py: documented/fixture dangerous term `nc -e`
- scripts/safety_audit.py: documented/fixture dangerous term `meterpreter`
- scripts/safety_audit.py: documented/fixture dangerous term `msfvenom`
- scripts/safety_audit.py: documented/fixture dangerous term `mimikatz`
- scripts/safety_audit.py: documented/fixture dangerous term `hydra`
- scripts/safety_audit.py: documented/fixture dangerous term `sqlmap`
- scripts/safety_audit.py: documented/fixture dangerous term `masscan`
- scripts/safety_audit.py: documented/fixture dangerous term `nmap -A`
- scripts/safety_audit.py: documented/fixture dangerous term `rm -rf`
- scripts/safety_audit.py: documented/fixture dangerous term `chmod +s`
- scripts/safety_audit.py: documented/fixture dangerous term `crontab`

## Policy
Documentation and fixtures may mention prohibited techniques only as denied behavior or sample log indicators. Implementation code must not add offensive capabilities or bypass ScopeGuard.

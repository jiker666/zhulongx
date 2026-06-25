# Safety Audit Report

- Failures: 0
- Warnings: 39

## Failures
- None

## Warnings
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
- Makefile: constrained cleanup/build command `rm -rf`
- backend/Dockerfile: constrained cleanup/build command `rm -rf`
- backend/app/tools/log_analyzer.py: suspicious UA detection term `sqlmap`
- backend/app/tools/log_analyzer.py: suspicious UA detection term `masscan`
- backend/app/core/policy_engine.py: deny-list term `reverse shell`
- backend/app/core/safety.py: deny-list term `reverse shell`
- backend/tests/test_ctf_misc_solver.py: documented placeholder key `sk-example-placeholder`
- backend/tests/test_tools.py: documented/fixture dangerous term `sqlmap`
- docs/security_boundary.md: documented/fixture dangerous term `reverse shell`
- docs/round2_summary.md: documented/fixture dangerous term `reverse shell`
- samples/nginx_access.log: documented/fixture dangerous term `sqlmap`
- samples/access.log: documented/fixture dangerous term `sqlmap`
- samples/demo_outputs/log_analysis_report.md: documented/fixture dangerous term `sqlmap`
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

# Security Boundary

CyberPilot is only for authorized defensive security testing.

## Allowed

- Read-only file parsing
- Read-only HTTP fingerprinting
- Limited fixed-path probing
- JS API extraction without executing JavaScript
- Java source audit
- Log analysis
- Artifact triage for uploaded attachments
- Controlled GET/HEAD/OPTIONS HTTP replay inside explicit competition scope

## Requires Confirmation

- Any medium/high risk tool or plan step
- Any step explicitly marked `requires_confirmation=true`
- POST/PUT/PATCH/DELETE HTTP replay
- Any action that may alter target state, even when the target is in scope

The current demo tools are low risk and do not block by default.

## Denied

- Brute force
- Real vulnerability exploitation
- Getshell or reverse shell
- Persistence
- Credential theft or data exfiltration
- Destructive write/delete actions
- Lateral movement
- Payload injection

## Network Safety

Network tools default to blocking localhost, loopback, RFC1918 private ranges, link-local addresses, and non HTTP(S) schemes.

Final competition access must use ScopeGuard:

- `COMPETITION_MODE=true`
- `SCOPE_CIDRS` and/or `SCOPE_DOMAINS`
- optional `SCOPE_PORTS`
- `SCOPE_ALLOW_PRIVATE_IPS=true` only for authorized internal ranges
- `SCOPE_ALLOW_LOCALHOST=true` only for local mock drills

Do not globally disable SSRF protection. A coarse private-target allow flag can silently expand access from one intended target to unrelated local or internal services. ScopeGuard keeps the permission bounded to the configured CIDR/domain/port and records the decision in tool output.

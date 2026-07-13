# Deployment guide

Use existing Docker Compose for the legacy core. Set `COMPETITION_WORKFLOW_ENABLED=true` to expose the opt-in APIs; use an explicit ScopeGuard configuration before enabling network access. Do not mount an untrusted challenge workspace into the backend host process in production.

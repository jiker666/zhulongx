# Secret Rotation Notice

Date: 2026-07-13

The repository root `.env` and `backend/.env` contained the same set, non-placeholder `WQ_API_KEY`. Both local files were removed without copying the value into source, logs, events, or this notice.

Required operator action:

1. Revoke or rotate that gateway credential at its issuer.
2. Check repository history, shared archives, CI artifacts, and submission packages for earlier copies.
3. Inject the replacement only through the deployment secret mechanism or process environment.
4. Keep `.env.example` placeholder-only.

Deletion from this working tree does not invalidate an already exposed credential.

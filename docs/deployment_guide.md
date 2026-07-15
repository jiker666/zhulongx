# Worker deployment guide

Build and start the canonical backend plus isolated Worker:

```bash
docker-compose build worker-base backend
docker-compose up -d worker-base backend
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS http://127.0.0.1:8090/health
```

The backend and Worker share `/workspace/tasks`. Worker access must be enabled
per run with `allow_worker`; process tools also require `allow_process`. The
Worker runs as UID 10001, has a read-only root filesystem, drops all
capabilities, uses `no-new-privileges`, has no Docker socket, and binds its
optional host port only to `127.0.0.1`.

Worker children are confined to their run workspace with Linux Landlock. The
Worker is attached only to an internal control network and accepts process
creation only for `network_mode=deny`. A run requesting an allowlist receives
a visible tool failure instead of a host-execution fallback.

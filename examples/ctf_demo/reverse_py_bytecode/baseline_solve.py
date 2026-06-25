#!/usr/bin/env python3
# baseline solve for reverse_py_bytecode
# Strategy: strings extract + base64 decode candidate
import re, base64

with open('attachment/verify.pyc','rb') as f:
    raw = f.read()

text = raw.decode('latin-1', errors='ignore')

# find base64-like substrings
candidates = []
for m in re.finditer(r'[A-Za-z0-9+/]{16,}={0,2}', text):
    s = m.group(0)
    try:
        pad = s + '=' * (4 - len(s) % 4) if len(s) % 4 else s
        d = base64.b64decode(pad, validate=False)
        decoded = d.decode('latin-1', errors='ignore')
        if 'flag' in decoded.lower():
            print(decoded)
            break
    except Exception:
        continue

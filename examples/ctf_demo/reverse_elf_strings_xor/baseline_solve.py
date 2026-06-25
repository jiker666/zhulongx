#!/usr/bin/env python3
# baseline solve for reverse_elf_strings_xor
# Strategy: read encrypted blob, try common XOR keys, look for flag pattern
import re

with open('attachment/encrypted_blob.bin','rb') as f:
    raw = f.read()

# Try common XOR keys
for key in [0x42, 0x5A, 0xFF, 0x37, 0x13, 0x00, 0x01]:
    decoded = bytes([b ^ key for b in raw]).decode('latin-1', errors='ignore')
    m = re.search(r'flag\{[^}]+\}', decoded)
    if m:
        print(m.group(0))
        break

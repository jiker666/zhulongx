#!/usr/bin/env python3
# baseline solve for crypto_xor_repeating
import base64

with open('attachment/cipher.b64','rb') as f:
    cipher = base64.b64decode(f.read())

# key is 5 bytes repeating; we know it's "ZHUDL"
key = b'ZHUDL'
plain = bytes([b ^ key[i % len(key)] for i, b in enumerate(cipher)])
print(plain.decode())

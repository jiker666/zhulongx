#!/usr/bin/env python3
# baseline solve for crypto_base_chain
import base64, codecs

with open('attachment/encoded.txt','rb') as f:
    s4 = f.read().strip()

# reverse order: base64 → base32 → hex → rot13
d1 = base64.b64decode(s4)
d2 = base64.b32decode(d1)
d3 = bytes.fromhex(d2.decode())
d4 = codecs.encode(d3.decode(), 'rot13').encode()
print(d4.decode())

#!/usr/bin/env python3
# baseline solve for misc_png_chunks
import struct

with open('attachment/flag.png','rb') as f:
    data = f.read()

# skip 8-byte signature
pos = 8
while pos < len(data):
    length = struct.unpack('>I', data[pos:pos+4])[0]
    ctype = data[pos+4:pos+8].decode('latin-1', errors='replace')
    cdata = data[pos+8:pos+8+length]
    if ctype not in ('IHDR', 'IDAT', 'IEND', 'PLTE'):
        # custom chunk - check for flag
        import re
        m = re.search(r'flag\{[^}]+\}', cdata.decode('latin-1', errors='ignore'))
        if m:
            print(m.group(0))
            break
    pos += 12 + length

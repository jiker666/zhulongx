#!/usr/bin/env python3
"""Baseline solve for misc_png_chunks_hard"""

import struct

XOR_KEY = 0xAA

def solve():
    with open("attachment/stego.png", "rb") as f:
        data = f.read()

    # Skip PNG signature (8 bytes)
    pos = 8
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos+4])[0]
        chunk_type = data[pos+4:pos+8].decode('ascii', errors='replace')
        chunk_data = data[pos+8:pos+8+length]
        # CRC at pos+8+length (4 bytes)

        if chunk_type == 'cTfI':
            # Extract hidden data
            flag_len = struct.unpack('>H', chunk_data[:2])[0]
            encrypted = chunk_data[2:2+flag_len]
            flag = ''.join(chr(b ^ XOR_KEY) for b in encrypted)
            return flag

        pos += 4 + 4 + length + 4  # length field + type + data + CRC

    return "NO FLAG FOUND"

if __name__ == "__main__":
    print(solve())

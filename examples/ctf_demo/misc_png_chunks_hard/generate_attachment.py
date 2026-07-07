#!/usr/bin/env python3
"""Generate misc_png_chunks_hard challenge — PNG with hidden custom chunk"""

import struct
import zlib

FLAG = "flag{png_chUnk_h1dd3n_x0r}"
XOR_KEY = 0xAA

def make_chunk(chunk_type, data):
    """Create a PNG chunk: [4B length][4B type][data][4B CRC]"""
    length = len(data)
    raw = chunk_type + data
    crc = zlib.crc32(raw) & 0xFFFFFFFF
    return struct.pack('>I', length) + raw + struct.pack('>I', crc)

def generate():
    # Minimal valid 1x1 PNG
    ihdr_data = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)  # 1x1 8-bit RGB
    ihdr = make_chunk(b'IHDR', ihdr_data)

    # IDAT — a single white pixel (RGB 255,255,255) deflate-compressed
    raw_data = b'\x00\xff\xff\xff'  # filter=0, R=255, G=255, B=255
    compressed = zlib.compress(raw_data)
    idat = make_chunk(b'IDAT', compressed)

    # Hidden custom chunk: 'cTfI' — XOR encrypted flag
    encrypted = bytes([b ^ XOR_KEY for b in FLAG.encode()])
    # Prepend length prefix (2 bytes) for extra misdirection
    payload = struct.pack('>H', len(FLAG)) + encrypted
    hidden = make_chunk(b'cTfI', payload)

    # IEND
    iend = make_chunk(b'IEND', b'')

    # Assemble: IHDR → hidden chunk (before IDAT) → IDAT → IEND
    png = b'\x89PNG\r\n\x1a\n' + ihdr + hidden + idat + iend

    with open("attachment/stego.png", "wb") as f:
        f.write(png)

    print(f"Generated stego.png ({len(png)} bytes)")
    print(f"Hidden chunk: type=cTfI, data={payload.hex()}")
    print(f"Flag: {FLAG}")

if __name__ == "__main__":
    generate()

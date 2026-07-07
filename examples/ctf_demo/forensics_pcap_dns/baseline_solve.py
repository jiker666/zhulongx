#!/usr/bin/env python3
"""Baseline solve for forensics_pcap_dns — DNS label extraction from PCAP"""

import struct

def decode_dns_labels(data, offset):
    """Decode DNS name from label-format bytes, return list of labels."""
    labels = []
    i = offset
    while i < len(data):
        llen = data[i]
        if llen == 0:
            break
        if llen >= 0xC0:  # DNS pointer (compression)
            ptr = ((llen & 0x3F) << 8) | data[i + 1]
            # Follow pointer (simplified — just return what we have)
            return labels
        label = data[i + 1:i + 1 + llen].decode('ascii', errors='replace')
        labels.append(label)
        i += 1 + llen
    return labels

def solve():
    with open("attachment/capture.pcap", "rb") as f:
        data = f.read()

    # Skip global header (24 bytes)
    pos = 24
    chunks = {}

    while pos < len(data):
        if pos + 16 > len(data):
            break
        incl_len = struct.unpack('<I', data[pos+8:pos+12])[0]
        pkt = data[pos+16:pos+16+incl_len]

        # Skip Ethernet(14) + IP(20) + UDP(8) = 42 bytes → DNS payload
        if len(pkt) <= 42:
            pos += 16 + incl_len
            continue

        dns = pkt[42:]
        # DNS header is 12 bytes, question section starts after
        qsection_offset = 12
        labels = decode_dns_labels(dns, qsection_offset)

        # Pattern: [seq, hex_data, "exfil", "example", "com"]
        if len(labels) >= 3 and "exfil" in labels:
            try:
                seq = int(labels[0])
                hex_data = labels[1]
                chunks[seq] = hex_data
            except (ValueError, IndexError):
                pass

        pos += 16 + incl_len

    # Sort by sequence number and concatenate
    sorted_chunks = [chunks[k] for k in sorted(chunks.keys())]
    combined_hex = ''.join(sorted_chunks)
    flag = bytes.fromhex(combined_hex).decode()
    return flag

if __name__ == "__main__":
    print(solve())

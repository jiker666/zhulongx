#!/usr/bin/env python3
"""Generate forensics_pcap_dns challenge — DNS exfiltration PCAP

Since we can't easily generate a real PCAP without scapy, we create
a simplified binary PCAP file with DNS query packets.
"""

import struct
import time

FLAG = "flag{dns_tunn3l_3xf1l_r3c0v3ry}"

def hex_encode_chunks(data, chunk_size=8):
    """Split data into hex chunks with sequence numbers"""
    raw = data.encode()
    hex_str = raw.hex()
    chunks = []
    for i in range(0, len(hex_str), chunk_size):
        seq = i // chunk_size
        chunk = hex_str[i:i+chunk_size]
        chunks.append((seq, chunk))
    return chunks

def build_pcap(chunks):
    """Build a minimal PCAP with DNS-like packets"""
    # PCAP Global Header
    pcap_header = struct.pack('<IHHIIII',
        0xa1b2c3d4,  # magic
        2, 4,         # version
        0,            # thiszone
        0,            # sigfigs
        65535,        # snaplen
        1             # link type: ETHERNET
    )

    records = b""
    ts = int(time.time())
    for seq, hex_data in chunks:
        # DNS query domain: <seq>.<hex_data>.exfil.example.com
        domain = f"{seq}.{hex_data}.exfil.example.com"
        # Simulate a DNS query packet payload (simplified)
        # Transaction ID + Flags + QDCOUNT + ANCOUNT + NSCOUNT + ARCOUNT
        dns_header = struct.pack('>HHHHHH',
            0x1234 + seq,  # Transaction ID
            0x0100,        # Flags: standard query
            1, 0, 0, 0     # Counts
        )
        # Question section: encode domain as DNS name
        qname = b""
        for label in domain.split('.'):
            qname += bytes([len(label)]) + label.encode()
        qname += b'\x00'
        qtype_qclass = struct.pack('>HH', 1, 1)  # A, IN

        dns_payload = dns_header + qname + qtype_qclass

        # Minimal Ethernet + IP + UDP headers
        eth = b'\x00' * 6 + b'\x00' * 6 + b'\x08\x00'  # Ethernet
        ip_hdr = struct.pack('>BBHHHBBH4s4s',
            0x45, 0, 20 + 8 + len(dns_payload), 0, 0, 64, 17, 0,
            b'\x7f\x00\x00\x01',  # src
            b'\x7f\x00\x00\x01'   # dst
        )
        udp_hdr = struct.pack('>HHHH', 12345, 53, 8 + len(dns_payload), 0)

        packet = eth + ip_hdr + udp_hdr + dns_payload

        # PCAP record header
        record_hdr = struct.pack('<IIII',
            ts, 0,            # timestamp
            len(packet),      # incl_len
            len(packet)       # orig_len
        )
        records += record_hdr + packet

    return pcap_header + records

if __name__ == "__main__":
    chunks = hex_encode_chunks(FLAG, chunk_size=8)
    pcap_data = build_pcap(chunks)

    with open("attachment/capture.pcap", "wb") as f:
        f.write(pcap_data)

    print(f"Generated capture.pcap ({len(pcap_data)} bytes)")
    print(f"DNS chunks: {len(chunks)}")
    for seq, hex_data in chunks:
        print(f"  {seq}.{hex_data}.exfil.example.com")
    print(f"Flag: {FLAG}")

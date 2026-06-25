#!/usr/bin/env python3
# baseline solve for forensics_pcap_http
# Reads pcap, extracts ASCII strings, finds flag pattern
import re

with open('attachment/capture.pcap','rb') as f:
    data = f.read()

# Decode as latin-1 to preserve bytes
text = data.decode('latin-1', errors='ignore')

# Find flag patterns
m = re.search(r'flag\{[^}]+\}', text)
if m:
    print(m.group(0))
else:
    print('no flag found')

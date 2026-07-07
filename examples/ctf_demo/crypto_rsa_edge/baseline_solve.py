#!/usr/bin/env python3
"""Baseline solve for crypto_rsa_edge"""

from math import gcd

def extended_gcd(a, b):
    if a == 0:
        return b, 0, 1
    g, x, y = extended_gcd(b % a, a)
    return g, y - (b // a) * x, x

def solve():
    # Read parameters
    with open("attachment/cipher1.txt") as f:
        lines = f.readlines()
        n = int([l for l in lines if l.startswith('n =')][0].split('=')[1].strip())
        e1 = int([l for l in lines if l.startswith('e =')][0].split('=')[1].strip())
        c1 = int([l for l in lines if l.startswith('c =')][0].split('=')[1].strip())

    with open("attachment/cipher2.txt") as f:
        lines = f.readlines()
        e2 = int([l for l in lines if l.startswith('e =')][0].split('=')[1].strip())
        c2 = int([l for l in lines if l.startswith('c =')][0].split('=')[1].strip())

    # Common modulus attack
    g, s, t = extended_gcd(e1, e2)
    assert g == 1, f"gcd({e1},{e2}) != 1"

    # m^1 = c1^s * c2^t mod n
    # Handle negative exponents by using modular inverse
    if s < 0:
        c1_inv = pow(c1, -1, n)
        m = (pow(c1_inv, -s, n) * pow(c2, t, n)) % n
    elif t < 0:
        c2_inv = pow(c2, -1, n)
        m = (pow(c1, s, n) * pow(c2_inv, -t, n)) % n
    else:
        m = (pow(c1, s, n) * pow(c2, t, n)) % n

    # Convert to bytes
    mlen = (m.bit_length() + 7) // 8
    plain = m.to_bytes(mlen, 'big')

    return plain.decode()

if __name__ == "__main__":
    print(solve())

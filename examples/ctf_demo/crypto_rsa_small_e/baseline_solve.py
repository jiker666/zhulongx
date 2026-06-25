#!/usr/bin/env python3
# baseline solve for crypto_rsa_small_e (no gmpy2 dependency)
# uses Newton's method for integer cube root

def iroot(c, e):
    """integer e-th root of c"""
    if c < 0: return 0, False
    if c == 0: return 0, True
    # initial guess: 2^(bitlen/e)
    x = 1 << ((c.bit_length() + e - 1) // e)
    while True:
        y = ((e-1) * x + c // (x ** (e-1))) // e
        if y >= x:
            # x is the floor root
            return x, (x ** e == c)
        x = y

with open('attachment/cipher.txt') as f:
    lines = f.readlines()
ns = [l for l in lines if l.startswith('n =')][0].split('=')[1].strip()
es = [l for l in lines if l.startswith('e =')][0].split('=')[1].strip()
cs = [l for l in lines if l.startswith('c =')][0].split('=')[1].strip()
n = int(ns); e = int(es); c = int(cs)

m, exact = iroot(c, e)
assert exact, "not a perfect root"
mlen = (int(m).bit_length() + 7) // 8
plain = int(m).to_bytes(mlen, 'big')
print(plain.decode())

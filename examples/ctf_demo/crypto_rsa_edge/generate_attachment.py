#!/usr/bin/env python3
"""Generate crypto_rsa_edge challenge attachment"""

from math import gcd
import random

FLAG = "flag{c0mm0n_m0du1us_dp_l3ak_crt}"

def is_prime_miller_rabin(n, k=40):
    """Miller-Rabin primality test"""
    if n < 2: return False
    if n == 2 or n == 3: return True
    if n % 2 == 0: return False
    d = n - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1
    rng = random.Random(12345)
    for _ in range(k):
        a = rng.randrange(2, n - 1)
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True

def next_prime(start):
    """Find next prime >= start"""
    if start % 2 == 0:
        start += 1
    while not is_prime_miller_rabin(start):
        start += 2
    return start

def extended_gcd(a, b):
    if a == 0:
        return b, 0, 1
    g, x, y = extended_gcd(b % a, a)
    return g, y - (b // a) * x, x

if __name__ == "__main__":
    # Generate 128-bit primes deterministically
    rng = random.Random(42)
    p = next_prime(rng.getrandbits(128) | (1 << 127))
    q = next_prime(rng.getrandbits(128) | (1 << 127))
    while q == p:
        q = next_prime(rng.getrandbits(128) | (1 << 127))

    n = p * q
    phi = (p - 1) * (q - 1)

    # Choose e1, e2 coprime to phi
    for e1_cand in [5, 7, 11, 13, 17, 19, 23, 29, 31]:
        if gcd(e1_cand, phi) == 1:
            e1 = e1_cand
            break
    for e2_cand in [5, 7, 11, 13, 17, 19, 23, 29, 31]:
        if e2_cand > e1 and gcd(e2_cand, phi) == 1:
            e2 = e2_cand
            break

    print(f"p = {p} (prime={is_prime_miller_rabin(p)})")
    print(f"q = {q} (prime={is_prime_miller_rabin(q)})")
    print(f"e1 = {e1}, e2 = {e2}")

    d = pow(e2, -1, phi)
    dp = d % (p - 1)

    m = int.from_bytes(FLAG.encode(), 'big')
    assert m < n, f"m ({m.bit_length()} bits) >= n ({n.bit_length()} bits)"

    c1 = pow(m, e1, n)
    c2 = pow(m, e2, n)

    # Verify gcd(c, n) == 1
    assert gcd(c1, n) == 1, f"c1 not coprime to n: gcd={gcd(c1,n)}"
    assert gcd(c2, n) == 1, f"c2 not coprime to n: gcd={gcd(c2,n)}"

    # Common modulus: find s,t such that e1*s + e2*t = 1
    g, s, t = extended_gcd(e1, e2)
    assert g == 1

    # Verify recovery
    if s < 0:
        m_check = (pow(pow(c1, -1, n), -s, n) * pow(c2, t, n)) % n
    elif t < 0:
        m_check = (pow(c1, s, n) * pow(pow(c2, -1, n), -t, n)) % n
    else:
        m_check = (pow(c1, s, n) * pow(c2, t, n)) % n
    assert m_check == m, f"Common modulus attack verification failed! m={m}, m_check={m_check}"

    with open("attachment/cipher1.txt", "w") as f:
        f.write(f"n = {n}\ne = {e1}\nc = {c1}\n")
    with open("attachment/cipher2.txt", "w") as f:
        f.write(f"n = {n}\ne = {e2}\nc = {c2}\n")
    with open("attachment/hint_dp.txt", "w") as f:
        f.write(f"dp = {dp}\ne2 = {e2}\n")
    with open("attachment/params.txt", "w") as f:
        f.write(f"# Common modulus attack: e1={e1}, e2={e2}\n")
        f.write(f"# extended_gcd({e1},{e2}) → s={s}, t={t}\n")
        f.write(f"# Verify: {e1}*{s} + {e2}*{t} = {e1*s + e2*t}\n")

    print(f"n = {n} ({n.bit_length()} bits)")
    print(f"dp = {dp}")
    print(f"c1 = {c1}")
    print(f"c2 = {c2}")
    print(f"s={s}, t={t}")
    print(f"Flag: {FLAG}")

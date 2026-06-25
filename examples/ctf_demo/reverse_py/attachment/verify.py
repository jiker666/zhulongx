#!/usr/bin/env python3
# obfuscated flag verifier
import base64 as _b
import sys as _s

_OBF = b"ZmxhZ3tyZXZlcnNlX3B5dGhvbl9vYmZ1c2NhdGlvbn0="


def _xor(a, b):
    return bytes([x ^ y for x, y in zip(a, b)])


def check(inp: str) -> bool:
    expected = _b.b64decode(_OBF)
    if inp.encode() == expected:
        return True
    return False


if __name__ == "__main__":
    s = _s.stdin.read().strip()
    if check(s):
        print("correct!")
    else:
        print("wrong.")

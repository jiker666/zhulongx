#!/usr/bin/env python3
"""Baseline solve for reverse_pyinstaller_vm"""

MASK = 0xFFFFFFFF

def solve():
    # 逆向 VM 变换: v' = ((v ^ 0x42) + 7) ^ 0x13
    # 已知预期输出，反推输入
    with open("attachment/expected_output.bin", "rb") as f:
        data = f.read()
    expected = []
    for i in range(0, len(data), 4):
        expected.append(int.from_bytes(data[i:i+4], 'little'))

    flag = ""
    for val in expected:
        # 反向: v = (((v' ^ 0x13) - 7) ^ 0x42) & MASK
        v = (((val ^ 0x13) - 7) ^ 0x42) & MASK
        # 确保是 ASCII 范围
        if v > 0x7F:
            v = v & 0xFF
        flag += chr(v)
    return flag

if __name__ == "__main__":
    print(solve())

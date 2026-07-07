#!/usr/bin/env python3
"""Generate reverse_custom_vm challenge — custom VM bytecode"""

import struct

FLAG = "flag{cust0m_vm_b4by_r3v3rs3d}"
XOR_KEY = 0x37
ADD_SHIFT = 13

# VM Instruction Opcodes
OP_MOV   = 0x01  # MOV reg, imm32
OP_XOR   = 0x02  # XOR reg, reg
OP_ADD   = 0x03  # ADD reg, reg
OP_SHL   = 0x04  # SHL reg, imm8
OP_AND   = 0x05  # AND reg, imm32
OP_CMP   = 0x06  # CMP reg, reg (sets zero flag)
OP_JZ    = 0x07  # JZ addr (jump if zero flag)
OP_HALT  = 0xFF

def encode_instruction(opcode, *args):
    """Encode a VM instruction"""
    result = bytes([opcode])
    for arg in args:
        if isinstance(arg, int):
            result += struct.pack('<I', arg & 0xFFFFFFFF)
        elif isinstance(arg, bytes):
            result += arg
    return result

def generate_vm_bytecode():
    """Generate VM bytecode that validates the flag"""
    bytecode = bytearray()

    # For each character of the flag:
    # 1. Load char into r0
    # 2. XOR r0 with KEY → r0
    # 3. ADD r0 with SHIFT → r0
    # 4. AND r0 with 0xFF → r0
    # 5. CMP r0 with expected[i]
    # 6. JZ to next check; if not zero → HALT (fail)

    for i, ch in enumerate(FLAG):
        expected = ((ord(ch) ^ XOR_KEY) + ADD_SHIFT) & 0xFF

        # MOV r0, ord(ch) — this is the input
        bytecode += encode_instruction(OP_MOV, 0, ord(ch))
        # MOV r1, XOR_KEY
        bytecode += encode_instruction(OP_MOV, 1, XOR_KEY)
        # XOR r0, r1
        bytecode += encode_instruction(OP_XOR, 0, 1)
        # MOV r1, ADD_SHIFT
        bytecode += encode_instruction(OP_MOV, 1, ADD_SHIFT)
        # ADD r0, r1
        bytecode += encode_instruction(OP_ADD, 0, 1)
        # AND r0, 0xFF
        bytecode += encode_instruction(OP_AND, 0, 0xFF)
        # MOV r1, expected
        bytecode += encode_instruction(OP_MOV, 1, expected)
        # CMP r0, r1
        bytecode += encode_instruction(OP_CMP, 0, 1)
        # JZ to next iteration (addr = current_pos + 7)
        bytecode += encode_instruction(OP_JZ, 0)  # placeholder, will be fixed

    # If all checks passed:
    bytecode += encode_instruction(OP_HALT)

    # Fix up JZ addresses
    return bytes(bytecode)

def generate_expected_table():
    """Generate the expected output table"""
    table = []
    for ch in FLAG:
        expected = ((ord(ch) ^ XOR_KEY) + ADD_SHIFT) & 0xFF
        table.append(expected)
    return table

if __name__ == "__main__":
    bytecode = generate_vm_bytecode()
    expected = generate_expected_table()

    # Write the VM binary
    with open("attachment/crackme.bin", "wb") as f:
        # Header: magic + num_instructions + flag_len
        f.write(b"ZHVM")  # magic
        f.write(struct.pack('<I', len(FLAG)))  # flag length
        f.write(struct.pack('<I', len(bytecode)))  # bytecode size
        f.write(bytecode)

    # Write expected table separately (as a "leaked" data file)
    with open("attachment/vm_spec.txt", "w") as f:
        f.write("# Custom VM Specification\n")
        f.write("# Registers: r0, r1, r2, r3 (32-bit)\n")
        f.write("# Flags: ZF (zero flag)\n\n")
        f.write("# Opcodes:\n")
        f.write("# 0x01 MOV reg,imm32  — r[reg] = imm32\n")
        f.write("# 0x02 XOR reg,reg    — r[dst] ^= r[src]\n")
        f.write("# 0x03 ADD reg,reg    — r[dst] += r[src]\n")
        f.write("# 0x04 SHL reg,imm8   — r[reg] <<= imm8\n")
        f.write("# 0x05 AND reg,imm32  — r[reg] &= imm32\n")
        f.write("# 0x06 CMP reg,reg    — ZF = (r[a] == r[b])\n")
        f.write("# 0x07 JZ addr        — if ZF: PC = addr\n")
        f.write("# 0xFF HALT           — stop\n\n")
        f.write("# Expected output table (hex):\n")
        f.write("expected = [")
        f.write(', '.join(f'0x{v:02x}' for v in expected))
        f.write(']\n')

    print(f"Generated crackme.bin ({len(bytecode)} bytes bytecode)")
    print(f"Generated vm_spec.txt")
    print(f"XOR_KEY=0x{XOR_KEY:02x}, ADD_SHIFT={ADD_SHIFT}")
    print(f"Expected: {expected}")
    print(f"Flag: {FLAG}")

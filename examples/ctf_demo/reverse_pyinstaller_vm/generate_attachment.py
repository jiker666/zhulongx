#!/usr/bin/env python3
"""
vm_engine.pyc — 自定义栈式虚拟机，16 条 opcode
解包自 PyInstaller 可执行文件

opcode 语义:
  0x01 PUSH <val>   — 压入立即数
  0x02 ADD           — 弹出 a,b; 压入 b+a
  0x03 SUB           — 弹出 a,b; 压入 b-a
  0x04 XOR           — 弹出 a,b; 压入 b^a
  0x05 MUL           — 弹出 a,b; 压入 b*a
  0x06 CMP_EQ        — 弹出 a,b; 若 b==a 则压入1 else压入0
  0x07 JMP <addr>    — 跳转
  0x08 JZ <addr>     — 弹出 val; 若0则跳转
  0x09 LOAD <idx>    — 从 input[idx] 加载
  0x0A STORE <idx>   — 弹出值存到 output[idx]
  0x0B HALT          — 停机
  0x0C PRINT         — 弹出栈顶输出
  0x0D NOT           — 弹出 a; 压入 ~a (32-bit)
  0x0E SHL <n>       — 弹出 a; 压入 a<<n (截断32bit)
  0x0F SHR <n>       — 弹出 a; 压入 a>>n
  0x10 DUP           — 复制栈顶
"""

MASK = 0xFFFFFFFF
FLAG = "flag{vm_0pcode_r3vers3d_2024}"

def encode_flag_vm(text):
    """用 VM 的正向逻辑编码 flag，生成 bytecode"""
    ops = []
    for i, ch in enumerate(text):
        v = ord(ch)
        # 变换: v' = ((v ^ 0x42) + 7) ^ 0x13
        ops.append((0x09, i))       # LOAD input[i]
        ops.append((0x01, 0x42))    # PUSH 0x42
        ops.append((0x04,))         # XOR
        ops.append((0x01, 7))       # PUSH 7
        ops.append((0x02,))         # ADD
        ops.append((0x01, 0x13))    # PUSH 0x13
        ops.append((0x04,))         # XOR
        ops.append((0x0A, i))       # STORE output[i]
    ops.append((0x0B,))             # HALT
    return ops

def serialize(ops):
    """序列化 bytecode"""
    bs = bytearray()
    for op in ops:
        bs.append(op[0])
        if len(op) > 1:
            bs.extend(op[1].to_bytes(4, 'little') if isinstance(op[1], int) and op[1] >= 0 else op[1].to_bytes(4, 'little', signed=True))
    return bytes(bs)

if __name__ == "__main__":
    ops = encode_flag_vm(FLAG)
    bytecode = serialize(ops)
    with open("attachment/vm_engine.pyc", "wb") as f:
        # PyInstaller pyc header (magic + flags + timestamp + size)
        f.write(b"\x55\x0d\x0d\x0a")  # magic
        f.write(b"\x00\x00\x00\x00")  # flags
        f.write(b"\x00\x00\x00\x00")  # timestamp
        f.write(b"\x00\x00\x00\x00")  # size
        # Our custom "co_code" — the VM bytecode
        f.write(bytecode)

    # 预期的验证结果（每个字符变换后）
    expected = []
    for ch in FLAG:
        v = ord(ch)
        transformed = (((v ^ 0x42) + 7) ^ 0x13) & MASK
        expected.append(transformed)
    with open("attachment/expected_output.bin", "wb") as f:
        for val in expected:
            f.write(val.to_bytes(4, 'little'))

    print(f"Generated vm_engine.pyc ({len(bytecode)} bytes bytecode)")
    print(f"Generated expected_output.bin ({len(expected)*4} bytes)")

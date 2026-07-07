# Reverse PyInstaller VM Opcode

**Category**: reverse | **Difficulty**: hard

## Challenge

PyInstaller 打包的可执行文件，解包后核心逻辑在 vm_engine.pyc — 一个自定义栈式 VM，16 条 opcode。

解题路径：
1. `pyinstxtractor` 解包 PyInstaller
2. `uncompyle6` / `decompyle3` 反编译 `.pyc`
3. 逐条 opcode 推导栈状态
4. 逆向约束求 flag

## VM Opcode Table

| Opcode | Name | Semantics |
|--------|------|-----------|
| 0x01 | PUSH val | push imm |
| 0x02 | ADD | pop a,b; push b+a |
| 0x03 | SUB | pop a,b; push b-a |
| 0x04 | XOR | pop a,b; push b^a |
| 0x05 | MUL | pop a,b; push b*a |
| 0x06 | CMP_EQ | pop a,b; push (b==a) |
| 0x07 | JMP addr | jump |
| 0x08 | JZ addr | pop; jump if 0 |
| 0x09 | LOAD idx | load input[idx] |
| 0x0A | STORE idx | pop → output[idx] |
| 0x0B | HALT | stop |
| 0x0C | PRINT | pop & print |
| 0x0D | NOT | pop a; push ~a |
| 0x0E | SHL n | pop a; push a<<n |
| 0x0F | SHR n | pop a; push a>>n |
| 0x10 | DUP | dup top |

## Transform Per Char

`v' = ((v ^ 0x42) + 7) ^ 0x13`

**Inverse**: `v = (((v' ^ 0x13) - 7) ^ 0x42) & 0xFFFFFFFF`

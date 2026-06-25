# Reverse ELF Strings + XOR

模拟 ELF 逆向题：二进制中包含 XOR 加密的 flag 数据，附带 pseudo.c 描述解密逻辑。

## 解题

```bash
python3 baseline_solve.py
# → flag{elf_strings_xor_logic}
```

## 思路

1. 读取 `encrypted_blob.bin`（模拟从 .rodata 提取的数据）
2. 参考 `pseudo.c` 中的 KEY=0x42
3. XOR 解密
4. 正则匹配 flag

真实场景：用 `strings` + `objdump -d` 找到加密数据和 key。

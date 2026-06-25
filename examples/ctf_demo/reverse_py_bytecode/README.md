# Reverse Python Bytecode

Python 编译后的 `.pyc` 文件，包含一个 base64 编码的常量。需要反编译或用 strings 提取常量。

## 解题

```bash
python3 baseline_solve.py
# → flag{pyc_bytecode_reverse}
```

## 思路

1. `.pyc` 是 marshalled 字节码，前 16 字节是 magic header
2. 用 `strings` 或正则提取 base64 候选
3. base64 解码后匹配 flag

进阶方法：用 `uncompyle6` / `decompyle3` 反编译回源码。

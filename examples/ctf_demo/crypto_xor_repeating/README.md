# Crypto XOR Repeating Key

重复密钥 XOR + base64 编码（经典 Vigenere-like）。

## 解题

```bash
python3 baseline_solve.py
# → flag{xor_repeating_key_is_classic}
```

## 思路

1. base64 解码
2. 用 5 字节 key 逐字节 XOR
3. 输出明文中的 flag

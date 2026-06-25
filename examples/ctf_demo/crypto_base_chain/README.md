# Crypto Base Chain Multi-Encoding

四层编码链：rot13 → hex → base32 → base64。

## 解题

```bash
python3 baseline_solve.py
# → flag{multi_layer_encoding_chain}
```

## 思路

1. 读取 encoded.txt
2. 反向解码：base64 → base32 → hex → rot13
3. 输出 flag

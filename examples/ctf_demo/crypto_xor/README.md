# Crypto XOR Demo

最经典的 CTF crypto 题：**XOR + Base64**。

## 解题思路

1. 读取 `attachment/secret.b64`
2. base64 解码
3. 用 key=0x5A 做 XOR
4. 得到 flag

## Reference solve

```python
import base64
data = open('attachment/secret.b64','rb').read()
cipher = base64.b64decode(data)
plain = bytes([b ^ 0x5A for b in cipher])
print(plain.decode())
```

预期输出：`flag{xor_crypto_is_simple_but_classic}`

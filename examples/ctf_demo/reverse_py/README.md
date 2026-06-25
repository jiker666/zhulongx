# Reverse Python Obfuscated

Python 反向题：分析一段混淆的验证脚本，找出能让校验通过的输入。

## 解题思路

1. 阅读 `verify.py`，看到 `_OBF` 是一段 base64 字符串
2. `check()` 函数把输入与 `_b.b64decode(_OBF)` 做比较
3. 直接 `echo $B64 | base64 -d` 即可得到 flag

## Reference solve

```bash
echo "ZmxhZ3tyZXZlcnNlX3B5dGhvbl9vYmZ1c2NhdGlvbn0=" | base64 -d
```

预期输出：`flag{reverse_python_obfuscation}`

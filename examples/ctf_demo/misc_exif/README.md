# Misc Hidden Flag in Text

经典的 misc 题：在日志/文本文件中藏着 flag。

## 解题思路

1. `strings server.log | grep -i flag`
2. 或直接读取并用正则提取 `flag\{[^}]+\}`

## Reference solve

```bash
grep -o 'flag{[^}]*}' attachment/server.log
```

预期输出：`flag{h1dd3n_1n_th3_l0gs}`

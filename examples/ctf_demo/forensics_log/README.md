# Forensics Access Log Flag

经典的取证题：在 nginx access log 中找到藏在 URL query 里的 flag。

## 解题思路

1. `grep -o 'flag{[^}]*}' attachment/access.log`

## Reference solve

```bash
grep -oE 'flag\{[^}]+\}' attachment/access.log
```

预期输出：`flag{f0rens1cs_url_l3ak_1n_log}`

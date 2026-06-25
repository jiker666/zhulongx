# Crypto RSA Small Exponent Attack

经典 RSA 小指数攻击：e=3 时若明文 m < n^(1/3)，则 c = m^3（无取模），可直接开立方还原。

## 解题

```bash
python3 baseline_solve.py
# → flag{rsa_small_e_attack_works}
```

## 思路

1. 解析 cipher.txt 中的 n, e, c
2. 因为 e=3 且 m^3 < n，c = m^3
3. 用 Newton 法求整数立方根
4. 转回字节得到明文

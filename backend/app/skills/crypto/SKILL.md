# Crypto CTF Skill (v9 增强版)

## 解题顺序

1. 识别密文特征（编码 / 长度 / 字符集 / 数学结构）
2. 尝试常见算法（XOR / Caesar / Base64 / RSA / AES）
3. 收集密钥参数（n/e/p/q/d/iv/key）
4. 编写解题脚本
5. 验证结果

## 链式解码

### Base/Hex/Morse 链
```
base64 → base32 → hex → rot13 → ascii
```
关键：观察密文字符集判断编码类型

### 判断方法
- 纯 A-Za-z0-9+/= → Base64
- A-Z2-7= → Base32
- 纯 0-9a-f → Hex
- 只有点和线 → Morse
- 纯数字 + 偶尔等号 → Base10/Base36
- 仅 `[].()!+` → JSFuck

## XOR

### 单字节 XOR
```python
for key in range(256):
    result = bytes(b ^ key for b in data)
    if b'flag' in result or b'CTF' in result:
        print(f"Key: {key:#x}, Result: {result}")
```

### 多字节 / Repeating Key XOR
```python
def xor_with_key(data, key):
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))

# Kasiski / Friedman 分析密钥长度:
# 然后每第 i 字节做单字节 XOR 爆破
```

### Known Plaintext (Crib)
```python
for key in [b'KEY', b'CTF', b'ZHULONG']:
    result = xor_with_key(data, key)
    if b'flag' in result: print(result)
```

## RSA 攻击

### 小公钥指数 (e=3) — 立方根
```python
from gmpy2 import iroot
# c = m^3 mod n → 若 c < n 则 m = c^(1/3)
m, exact = iroot(c, 3)
if exact:
    flag = bytes.fromhex(hex(m)[2:])
```

### 共模攻击
```python
from gmpy2 import gcdext
# 相同 n, 不同 e1/e2, 相同消息
g, s1, s2 = gcdext(e1, e2)
m = pow(c1, s1, n) * pow(c2, s2, n) % n
```

### Wiener Attack (小 d)
```python
# d < n^(1/4) / 3
# 用连分数展开 e/n 恢复 d
# 或: pip install owiener; d = owiener.attack(e, n)
```

### 相邻素数 (Fermat 分解)
```python
from gmpy2 import isqrt, is_square
# n = p * q, |p - q| 很小
a = isqrt(n)
if is_square(a*a - n):
    b = isqrt(a*a - n)
    p, q = a + b, a - b
```

### Hastad 广播攻击
```python
# 相同消息 m，e 个不同 n，公钥指数 e
# CRT 恢复 m^e → 取 e 次根
from functools import reduce
def crt(remainders, moduli):
    N = reduce(lambda a,b: a*b, moduli)
    result = sum(r * pow(N//m, -1, m) * (N//m) for r,m in zip(remainders, moduli))
    return result % N
me = crt(ciphertexts[:e], moduli[:e])
m, exact = iroot(me, e)
```

### Franklin-Reiter 相关消息攻击 (e=3)
```python
# 两个已知仿射变换 m+pad1, m+pad2
# SageMath: polynomial GCD
R.<X> = PolynomialRing(Zmod(n))
f1 = (X + pad1)^3 - c1
f2 = (X + pad2)^3 - c2
m = -gcd(f1, f2).coefficients()[0]
```

### Coppersmith 攻击 (线性相关素数)
```python
# q ~ 4p: qbar = isqrt(4*n); 用 small_roots 找误差项
R.<x> = PolynomialRing(Zmod(n))
f = x + qbar
roots = f.small_roots(X=2^200, beta=0.5)
q = qbar + int(roots[0])
```

### Pollard's p-1 分解
```python
from math import gcd
def pollard_p1(n, B=100000):
    a = 2
    for j in range(2, B+1):
        a = pow(a, j, n)
        d = gcd(a-1, n)
        if 1 < d < n: return d, n//d
```

### Batch GCD (共享素因子)
```python
# 多个 RSA 模数共享素因子
from math import gcd
for i in range(len(moduli)):
    for j in range(i+1, len(moduli)):
        if gcd(moduli[i], moduli[j]) != 1:
            p = gcd(moduli[i], moduli[j])
            # 分解 moduli[i] 和 moduli[j]
```

### 泄露 dp/dq
```python
# dp = d mod (p-1)
# m = pow(c, dp, p)  [CRT]
```

### RSA p=q (非互异素数)
```python
# n = p^2 → phi(n) = p*(p-1) → d = inverse(e, p*(p-1))
```

### RSA 同态解密预言机
```text
# 服务端解密 c → 返回 m 的某些信息
# 乘以 r^e: decrypt(c * r^e mod n) = m*r mod n → m = result * r^(-1) mod n
```

### RSA-CRT 故障攻击
```text
# 正确签名 s_p, s_q; 故障签名 s_p'
# gcd(s^e - m mod n, s'^e - m mod n) → p
```

### 限制数字素数 (LACTF 2026)
```text
# p, q 只包含特定数字 → 搜索空间极小 → 暴力分解
```

### Manger's RSA-OAEP 填充预言机
```text
# 通过时间差或错误响应逐字节恢复明文
# 比 Bleichenbacher 更高效
```

## AES

### 模式识别
- **ECB**: 相同明文块 → 相同密文块（无 IV）
- **CBC**: 需要 IV，字节翻转攻击
- **CTR**: 流式，重用 key/nonce → XOR 攻击
- **GCM**: 认证标签

### Padding Oracle
```python
# 逐字节恢复明文
# 修改 IV/ciphertext 观察 padding 错误
def padding_oracle_decrypt(ciphertext, iv, oracle):
    plaintext = b''
    for block_idx in range(len(ciphertext)//16 - 1, -1, -1):
        block = ciphertext[block_idx*16:(block_idx+1)*16]
        prev = iv if block_idx == 0 else ciphertext[(block_idx-1)*16:block_idx*16]
        decrypted = b''
        for byte_pos in range(15, -1, -1):
            for guess in range(256):
                test = bytearray(prev)
                test[byte_pos] ^= guess ^ (16 - byte_pos)
                if oracle(bytes(test) + block):
                    decrypted = bytes([guess]) + decrypted
                    break
        plaintext = decrypted + plaintext
    return plaintext
```

### CBC 字节翻转
```python
# 翻转 IV 的第 i 字节来翻转明文的第 i 字节
new_iv = bytearray(iv)
new_iv[target_pos] ^= original_byte ^ desired_byte
```

### ECB 块重排
```text
# 识别: 加密两段相同内容 → 密文出现相同块
# 利用: 逐字节枚举找到目标块对齐位置
```

## ECC 攻击

### 基本参数
```python
# P = n*G (椭圆曲线上的点)
# 私钥 n, 公钥 P, 基点 G, 阶 q
# E: y^2 = x^3 + ax + b (mod p)
```

### Pohlig-Hellman (阶光滑)
```python
# 当 q = prod(small_primes) → DLP 可在子群中分别求解
# SageMath:
# E.discrete_log(P, algorithm='lambda')  # 或 'rho'
```

### 异常曲线 (Smart's Attack)
```python
# 当曲线阶 q = p (trace = 1)
# 提升到 p-adic 数域求解 ECDLP
# SageMath: E.order() == p → Smart's attack
```

### 扭曲曲线攻击
```python
# 服务端在正确曲线上验证 → 但接受扭曲曲线上的点
# 在扭曲曲线上阶很小 → Pohlig-Hellman 求解
```

### 无效曲线攻击
```python
# 发送不在曲线上的点 → 参数 a 未被验证 → 可能落入弱阶子群
# 枚举 a' 值找到阶为光滑数的曲线
```

## 格密码 & LWE

### LWE 基本攻击
```python
# (A, b) where b = A*s + e (mod q)
# 构造格矩阵 → LLL/BKZ 约化 → 恢复 s
# SageMath:
M = matrix(ZZ, [[q, 0, A[0]], [0, q, A[1]], ...])
M = M.LLL()
# 短向量包含秘密 s
```

### CVP/SVP 问题
```python
# SageMath LLL:
L = IntegralLattice(M)
SV = L.shortest_vector()  # SVP
# Babai 最近平面算法 → CVP
```

### NTRU
```python
# 公钥 h = p*g*f^(-1) mod q
# 格攻击: 构造格 (1, h; 0, q) → LLL 找 f, g
```

### GGH
```text
# 私钥基 (好基) vs 公钥基 (坏基)
# 用 Babai 算法 + 好基解 CVP
```

## PRNG 攻击

### 线性同余生成器 (LCG)
```python
# s_{n+1} = a*s_n + c mod m
# 已知 6+ 输出 → 恢复 a, c, m
# 两个差分: t1 = s2-s1, t2 = s3-s2, t3 = s4-s3
# t1*t3 - t2^2 ≡ 0 mod m → gcd 求出 m
# 然后 a = (s3-s2) * inverse(s2-s1, m) mod m
# c = s2 - a*s1 mod m
```

### Mersenne Twister (MT19937)
```python
# 624 个连续输出 → 完全克隆状态
# pip install randcrack
rc = randcrack()
for _ in range(624): rc.submit(random.getrandbits(32))
predicted = rc.predict_getrandbits(32)
```

### 滚动哈希 PRNG
```text
# 观察输出 → 逆向哈希函数 → 恢复种子
# 常见: SHA-256(seed || counter) → 每次截取部分
```

### Python random 模块
```python
# random.seed(known_value) → 可预测
# 若种子是时间戳 → 暴力搜索时间窗口
```

## 流密码

### RC4
```python
# 密钥调度算法 (KSA) 弱点
# Fluhrer-Mantin-Shamir (FMS) 攻击: WEP
# 相关密钥攻击: 多个 IV → 恢复密钥
```

### LFSR (线性反馈移位寄存器)
```python
# 已知输出序列 → Berlekamp-Massey 算法求反馈多项式
# SageMath: berlekamp_massey(sequence)
```

### 重用密钥/nonce
```python
# 两个消息用相同密钥加密:
# c1 = m1 XOR key, c2 = m2 XOR key
# c1 XOR c2 = m1 XOR m2 → crib dragging
```

## 经典密码

### 仿射密码
```python
# E(x) = (ax + b) mod 26, gcd(a, 26) = 1
# D(y) = a^(-1) * (y - b) mod 26
```

### Vigenere
```python
# 密钥长度: Kasiski 测试 / Friedman 测试 / 重合指数
# 每列作为单表替换 → 频率分析
```

### Hill 密码
```python
# 矩阵加密: C = K * P mod 26
# 已知明文: K = C * P^(-1) mod 26
```

### Playfair
```text
# 5x5 矩阵，字母对替换
# 密钥: 去重字母 + 剩余字母
```

## 哈希攻击

### Hash Length Extension
```python
# MD5/SHA1/SHA256: Merkle-Damgård → 长度扩展
# 给定 H(m) 和 len(m) → 计算 H(m || padding || suffix) 无需知道 m
# pip install hashpumpy
```

### 碰撞
```python
# MD5: 相同前缀碰撞 (fastcoll)
# SHA-1: SHAttered 攻击
# 自定义简化哈希 → 找数学弱点
```

### HMAC 绕过
```text
# 时序攻击: 逐字节比较 → 测量响应时间
# 密钥泄露 → 伪造任意 HMAC
```

## Z3 约束求解

```python
from z3 import *
s = Solver()
x = BitVec('x', 32)
s.add(result == target)
if s.check() == sat:
    m = s.model()
    print(m[x])
```

## 零知识证明 (ZKP)

### Fiat-Shamir 启发式
```text
# 交互式 → 非交互式: challenge = H(commitment)
# 若 challenge 可预测 → 伪造证明
```

### Schnorr 协议
```text
# 若验证者不检查 challenge = H(g, A, r)
# → 攻击者可选择 challenge → 伪造证明
```

## 自定义 Hash / Fault Hash

- 观察哈希函数结构
- 找碰撞（可能简化版本有弱点）
- 尝试逆推
- 整数溢出（chr(256) = \x00）

## 脚本生成原则

- 自包含，不依赖外部网络
- print 关键中间结果（调试友好）
- 如果找到 flag，print 单独一行
- 信息不足时输出诊断脚本，不编造算法
- 优先使用 Python 标准库 + z3/gmpy2/Crypto/sage
- RSA 优先尝试: 小e立方根 → 共模 → Wiener → Fermat → Pollard p-1 → Batch GCD

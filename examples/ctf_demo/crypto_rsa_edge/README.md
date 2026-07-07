# Crypto RSA Edge Cases

**Category**: crypto | **Difficulty**: hard

## Attack Vectors

1. **Common Modulus Attack**: Same n, different exponents (e1=3, e2=5)
   - `extended_gcd(3, 5)` → s=-1, t=1 (verify: 3×(-1)+5×1=2... not 1!)
   - Actually: `extended_gcd(3,5)` → s=2, t=-1 (3×2+5×(-1)=1)
   - `m = c1^2 × c2^(-1) mod n`

2. **dp Leak**: dp = d mod (p-1) leaked
   - `p = gcd(n, 2^(dp×e2 - 1) mod n - 1)` — iteratively find p

## Key Parameters

| Param | Value |
|-------|-------|
| e1 | 3 |
| e2 | 5 |
| bits | 512 |

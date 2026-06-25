# Web Local Flask Parameter

本地 Flask 靶场 + 源码泄漏，仅监听 127.0.0.1。

## 启动靶场

```bash
pip install flask
python3 attachment/app.py
```

## 解题思路

1. 访问 `/`，发现提示源码泄漏端点
2. 访问 `/source`，阅读源码 → 看到 USERS 字典里 admin 的 secret 即 flag
3. 注意：`/api/profile` 在没有 `X-Admin-Token: zhulongx-admin-token` 时会隐藏 secret 字段，所以直接打 API 拿不到；必须通过源码分析。

## Reference solve

```bash
curl -s http://127.0.0.1:5000/source | grep -oE 'flag\{[^}]+\}'
```

预期输出：`flag{w3b_s0urce_l34k_cl4ss1c}`

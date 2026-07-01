# Web CTF Skill

Web 题型默认只允许低风险 GET。POST 表单和高风险操作必须进入 manual action。

## 解题顺序

1. 指纹识别（HTTP headers / Server / X-Powered-By）
2. 目录探测（robots.txt / .git / .env / backup）
3. JS 接口提取（找 hidden API endpoint）
4. 源码审计（如有源码泄露）
5. 漏洞利用（XSS / SQLi / SSRF / 文件读取）

## 安全边界

- 默认 `allow_network=false`，必须 `authorized=true` 才能联网
- 不做自动密码爆破
- 不做自动提交破坏性 POST/PUT/DELETE
- 不做 C2 / WebShell / 后渗透 / 横向移动

## 常见 flag 位置

- HTTP 响应头
- HTML 注释
- JS 变量
- 源码文件
- 数据库导出

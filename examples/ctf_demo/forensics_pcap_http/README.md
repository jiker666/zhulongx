# Forensics PCAP HTTP Flag

经典取证：pcap 抓包中的 HTTP 请求 URL query 藏 flag。

## 解题

```bash
python3 baseline_solve.py
# → flag{pcap_http_flag_extracted}
```

## 思路

1. 读取 pcap 二进制
2. 作为 latin-1 文本扫描
3. 正则匹配 `flag\{[^}]+\}`
4. （进阶：用 tshark/dpkt 正确解析 HTTP 层）

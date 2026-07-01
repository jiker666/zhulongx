# Forensics CTF Skill

取证题。

## 解题顺序

1. 文件类型识别
2. 关键字提取（flag / password / secret）
3. 流量还原（pcap → HTTP / DNS / TCP 流）
4. 内存分析（Volatility，如适用）

## 常见模式

- **日志分析**：grep 关键事件 / 时间线 / IP 归因
- **pcap HTTP**：提取 HTTP 请求 / 响应 / 上传文件
- **pcap DNS**：检查异常域名 / TXT 记录
- **文件恢复**：从磁盘镜像恢复删除文件

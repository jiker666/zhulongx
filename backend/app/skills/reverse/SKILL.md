# Reverse CTF Skill

## 解题顺序

1. `file` + `checksec`（ELF / PE / Mach-O）
2. `strings` 提取可疑字符串（flag / key / 路径）
3. 反汇编关键函数（readelf / objdump / ghidra_headless）
4. 还原算法（XOR / 自定义编码 / 加密）

## 常见模式

- **Python 字节码**：先 `dis.dis()` 看指令
- **ELF**：先看 main / init / fini，找字符串引用
- **自定义 VM**：提取 opcode 表，逐条翻译

## 安全边界

- 不运行未知的 ELF 可执行文件（沙箱内运行受 rlimit 约束）
- 不联网下载额外样本

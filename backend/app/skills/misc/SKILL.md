# Misc CTF Skill

杂项题，覆盖面广。

## 解题顺序

1. `file` 识别文件类型
2. `strings` 提取可疑字符串
3. `binwalk` 检查嵌入文件
4. `exiftool` 查看元数据
5. 编码识别（Base64 / Hex / Morse / Base85 / URL）

## 常见模式

- **图片隐写**：LSB / 文件尾追加 / EXIF 注释
- **PNG chunks**：检查 tEXt / zTXt / iTXt
- **ZIP 伪加密**：修改加密标志位
- **编码链**：多层 Base64 / Hex 交替

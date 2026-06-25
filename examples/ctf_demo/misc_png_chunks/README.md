# Misc PNG Chunk Steganography

PNG 自定义 chunk 隐写：flag 藏在 type=`zXif` 的非标准 chunk 数据段。

## 解题

```bash
python3 baseline_solve.py
# → flag{png_custom_chunk_stego}
```

## 思路

1. 解析 PNG chunk 结构：[4B length][4B type][data][4B CRC]
2. 跳过标准 chunk（IHDR/IDAT/IEND/PLTE）
3. 在自定义 chunk 的 data 里正则匹配 flag

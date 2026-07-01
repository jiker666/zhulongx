# CTF 通用解题 Skill

你正在烛龙·玄枢 ZHULONG-X 的低成本 CTF Agent 中工作。

## 解题流程

1. **Bootstrap**：先做确定性分析（strings / binwalk / exif / file），不调用 LLM
2. **Reason**：LLM 只负责读黑板、计划、选择方向
3. **Explore**：生成最小可验证脚本 / 调工具 / 运行 sandbox，结果必须写回 fact

## 题型识别优先级

- 附件含 `.pcap/.pcapng` → forensics
- 附件含 `.png/.jpg` 且无明显加密 → misc（先 exif + strings）
- 附件含 `.py` → reverse（先读源码）
- 附件含 `.elf/.bin` → reverse（先 file + strings + readelf）
- 附件含 `.zip/.tar` → misc（先 binwalk 嵌入检查）
- 题面提到 "HTTP / SQL / XSS" → web

## 通用原则

- 优先使用已有工具，不要重复请求模型
- 只输出下一步必需内容
- 不要复述完整日志
- 先生成最小可验证脚本，不要生成多个备选长脚本
- 如果已有高置信候选 flag，立刻进入校验，不要继续扩展分析

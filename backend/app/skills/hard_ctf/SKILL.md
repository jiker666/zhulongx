# Hard CTF 解题策略 (v8)

## 概述
困难 CTF 题的通用解题策略，适用于需要多轮假设-验证-迭代的问题。

## 核心原则
1. **不要一次性生成完整 solve.py** — 困难题需要先探测、再推断、再验证
2. **维护假设树** — 至少保持 1-3 个活跃假设
3. **最小验证动作** — 每步选择能最大区分假设的操作
4. **失败归因** — 记录失败原因，换方向而非修同一脚本
5. **证据驱动** — 信息不足时先获取更多证据

## 解题循环 (CC-like Loop)
```
Read State → Form Hypotheses → Select Action → Execute → Observe → Update → Decide
```

### Read State
- 完整阅读题面（不要截断）
- 查看附件类型、大小、hash
- 检查可用工具（z3/angr/pwntools/tshark/binwalk/exiftool 等）
- 回顾历史：已执行命令、输出、失败方向

### Form Hypotheses
- 至少 2 个方向，1 个最可能
- 每个假设有 confidence (0-1)、evidence、next_test
- 不要只赌一个方向

### Select Action
- 选择能最有效验证当前假设的操作
- 偏好 shell 命令探测 → 再写脚本
- 先 `file` + `strings` + `binwalk` → 再深度分析

### Observe
- 执行结果是否支持当前假设？
- 有没有意外发现（新文件、新线索）？
- 预期信号出现了吗？

### Update
- 更新假设 confidence
- 标记已验证/已否定
- 记录新事实

### Decide
- 找到 flag → verify
- 新证据 → continue
- 无新证据但有备选 → switch
- 连续失败 → expert replan
- 超时/预算 → human required

## 通用 Shell 探测流程
```bash
# Step 1: 基础信息
file <attachment>
strings -n 6 <attachment> | head -50
xxd <attachment> | head -20
md5sum <attachment>

# Step 2: 深度探测
binwalk <attachment>
exiftool <attachment>
# 对二进制
readelf -h <attachment>
readelf -s <attachment>
checksec <attachment>
objdump -d <attachment> | head -100
```

## expand_context 使用
当默认预览不足时，请求扩展：
```json
{"action": {"type": "expand_context", "content": {"file": "xxx", "mode": "text|hex|disasm|pcap|strings|image_meta", "offset": 0, "limit": 20000}}}
```

## 避免的常见错误
- ❌ 只写一个 grep flag 脚本就停
- ❌ 同一命令失败后重复执行
- ❌ 脚本无输出直接 STUCK
- ❌ 不读附件就猜 flag
- ❌ 忽略工具不可用（先 check）

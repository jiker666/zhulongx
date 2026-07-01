# Crypto CTF Skill

## 解题顺序

1. 识别密文特征（编码 / 长度 / 字符集）
2. 尝试常见算法（XOR / Caesar / Base64 / RSA / AES）
3. 编写解题脚本

## 常见模式

- **XOR**：单字节 / 多字节 / repeating key
- **Base64 链**：多层嵌套
- **RSA 小指数**：small e + small n → 直接开立方
- **RSA 共模**：相同 n 不同 e → 扩展欧几里得
- **AES ECB/CBC**：填充攻击 / 字节翻转

## 脚本生成原则

- 自包含，不依赖外部网络
- print 关键中间结果
- 如果找到 flag，print 单独一行
- 信息不足时输出诊断脚本，不编造算法

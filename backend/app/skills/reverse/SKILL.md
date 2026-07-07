# Reverse CTF Skill (v9 增强版)

## 解题顺序

1. `file` + `checksec`（ELF / PE / Mach-O）
2. `strings -n 6` 提取可疑字符串（flag / key / 路径 / base64）
3. 反汇编关键函数（readelf / objdump / nm / Ghidra / IDA）
4. 还原算法（XOR / 自定义编码 / 加密）
5. 编写验证脚本

## 工具链

### 静态分析
```bash
# 基本信息
file binary
checksec --file=binary
strings -n 6 binary | sort -u

# 符号与节区
readelf -s binary    # 符号表
readelf -S binary    # 节区表
nm binary           # 符号名
objdump -d binary   # 反汇编

# Ghidra (GUI)
# 分析函数: main, check, verify, encrypt, decrypt, flag
# 搜索字符串引用: Search → For Strings
# 重命名变量/函数辅助理解
```

### 动态分析
```bash
# GDB
gdb ./binary
b *main
r
info registers
x/20wx $rsp
si / ni  # 单步

# GDB + pwndbg
vmmap              # 内存映射
telescope $rsp 20  # 栈内容
checksec           # 保护检查

# strace / ltrace
strace -f ./binary
ltrace ./binary

# Frida (Android/Mobile)
frida -U -f com.target.app -l hook.js
```

### 反编译器
```text
Ghidra: 免费强大, 支持多种架构
IDA Pro: 业界标准, 插件生态
Binary Ninja: 现代 API, Python 脚本
Cutter (Rizin): 开源, 图形界面
```

## PyInstaller 打包

### 流程
```bash
1. file → "ELF/PE executable" 或 "data"
2. strings → 找 "MEI" magic 或 "python" / "PYZ-" 字样
3. pip3 install pyinstxtractor-ng
4. python3 -m pyinstxtractor <file>
5. 找 .pyc 文件（PYZ-00.pyz_extracted/ 或根目录）
6. 反编译:
   a. uncompyle6 <file>.pyc
   b. pycdc <file>.pyc
   c. 失败 → python3 -c "import dis, marshal; f=open('<file>','rb'); f.read(16); dis.dis(marshal.load(f))"
```

### 常见问题
- pyinstxtractor 可能需要多次运行
- `.pyc` magic number 不匹配 → 手动修复
- uncompyle6 版本不支持 → 用 pycdc 或 dis 模块
- 还原后找关键函数：`main`, `check`, `verify`, `encrypt`, `decrypt`

## Python 字节码

### 分析流程
```bash
1. file → "data" 或无扩展名
2. xxd | head → 检查 magic number (0x42 0x0D ... = Python 3.x)
3. python3 -c "import dis; dis.dis(open('file.pyc','rb').read())"
4. 提取常量表: co_consts, co_names
5. 根据 bytecode 写还原脚本
```

### 关键指令
- `LOAD_CONST` → 常量值
- `BINARY_OP` → 算术操作
- `COMPARE_OP` → 比较判断
- `CALL_FUNCTION` → 函数调用

## ELF 逆向

### 流程
```bash
1. file → ELF 类型 (32/64, static/dynamic)
2. checksec → 保护机制 (NX/ASLR/Canary/PIE/RELRO)
3. strings -n 6 → 关键字符串
4. readelf -s → 符号表
5. readelf -S → 节区表
6. objdump -d → 反汇编关键函数
7. 找关键逻辑: XOR 表、S-Box、比较逻辑、加密校验
```

### 常见加密校验
- 输入与硬编码值比较 → 直接提取
- XOR 单字节 → 爆破 0x00-0xFF
- 自定义 S-Box → 逆 S-Box 表
- 多轮加密 → 逐轮逆向

## 反分析技巧

### 常见混淆
```text
1. 字符串加密: XOR / Base64 / 自定义编码
   → 动态调试找解密后的字符串
   → 搜索解密函数, 写脚本批量解密

2. 控制流平坦化 (OLLVM):
   → 识别 dispatcher 变量 + switch 结构
   → 手动重建基本块顺序
   → D810 插件 (Ghidra) 自动去平坦化

3. 反调试:
   → ptrace(PTRACE_TRACEME) 检查 → patch 或 hook
   → /proc/self/status TracerPid → 返回 0
   → 时间检查 → 跳过
   → int3 断点检测 → patch

4. 花指令 (Junk Code):
   → 识别永假跳转 (jz + jnz 同目标)
   → 删除冗余指令
   → 用 Capstone/Keystone 自动化清理
```

### Patch 技巧
```python
# 修改跳转: 跳过检查
# x86: 74 → 75 (je → jne), 75 → 74 (jne → je)
# x86: 0F 84 → 90 E9 (je far → nop + jmp)
# 用 pwntools patch:
from pwn import *
elf = ELF('./binary')
elf.write(addr, b'\x90' * length)  # NOP
elf.save('./patched')
```

### 符号执行 (Angr)
```python
import angr
proj = angr.Project('./binary', auto_load_libs=False)
state = proj.factory.entry_state(stdin=angr.SimFile('/dev/stdin', size=100))
simgr = proj.factory.simgr(state)
simgr.explore(find=win_addr, avoid=fail_addr)
if simgr.found:
    s = simgr.found[0]
    flag = s.posix.dumps(0)  # stdin (input)
```

### Z3 约束求解
```python
from z3 import *
s = Solver()
x = BitVec('x', 64)
# 从逆向的约束添加
s.add(x * 0xdeadbeef == result)
s.add(x > 0)
if s.check() == sat:
    print(s.model()[x])
```

## VM / Brainfuck / Esolang

### 分析流程
```text
1. 识别 VM:
   - opcode 表通常在 .rodata
   - dispatcher 通常是大 switch/jump table
2. 提取 opcode 映射
3. 写 Python 解释器 trace 执行
4. 提取输入约束
5. Z3 求解（如果可用）
```

### Brainfuck
```python
def bf_interpreter(code, input_data=""):
    tape = [0] * 30000
    ptr = ip = 0
    output = []
    while ip < len(code):
        c = code[ip]
        if c == '>': ptr += 1
        elif c == '<': ptr -= 1
        elif c == '+': tape[ptr] = (tape[ptr] + 1) % 256
        elif c == '-': tape[ptr] = (tape[ptr] - 1) % 256
        elif c == '.': output.append(chr(tape[ptr]))
        elif c == ',': tape[ptr] = ord(input_data[0]) if input_data else 0; input_data = input_data[1:]
        elif c == '[' and tape[ptr] == 0:
            depth = 1
            while depth: ip += 1; depth += (code[ip] == '[') - (code[ip] == ']')
        elif c == ']' and tape[ptr] != 0:
            depth = 1
            while depth: ip -= 1; depth += (code[ip] == ']') - (code[ip] == '[')
        ip += 1
    return ''.join(output)
```

## Unicorn 模拟执行

```python
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32
from unicorn.x86_const import UC_X86_REG_EAX

mu = Uc(UC_ARCH_X86, UC_MODE_32)
mu.mem_map(0, 0x100000)
mu.mem_write(0, binary_data)
mu.emu_start(entry_addr, end_addr)
result = mu.reg_read(UC_X86_REG_EAX)
```

## 特定语言逆向

### .NET / C#
```bash
# dnSpy: 反编译 + 调试 .NET 程序
# dotPeek: 只读反编译
# ILSpy: 开源
# 混淆: de4dot 去混淆
```

### Java
```bash
# jadx: 反编译 APK/Java
# JD-GUI: 经典 Java 反编译
# CFR: 现代 Java 反编译器
# ProGuard 混淆: 映射文件恢复
```

### Go
```text
# Go 二进制特点:
# - 大量内联函数
# - goroutine 调度器代码
# - 字符串: {ptr, len} 结构
# - 接口: itab + 数据指针
# 工具: GoReSym (恢复符号)
```

### Rust
```text
# Rust 特点:
# - 大量泛型展开
# - panic 处理器代码
# - enum/Option 编码
# 工具: cargo-binutils
```

### Swift
```text
# Swift: class metadata + vtable
# 工具: SwiftDump
```

## 移动平台

### Android
```bash
# APK 解包:
apktool d app.apk
# 反编译:
jadx app.apk
# Java 层 hook:
frida -U -f com.target.app -l hook.js
# Native 层:
# lib/*.so → IDA/Ghidra 分析
# JNI 函数: Java_com_package_ClassName_method
```

### iOS
```bash
# class-dump: 提取 ObjC 头文件
# Frida: hook ObjC 方法
# Hopper/IDA: 分析 ARM64 二进制
# keychain dump: 安全存储提取
```

## 常见模式

### 自定义编码
```python
# XOR 编码:
key = [...]
result = bytes(c ^ key[i % len(key)] for i, c in enumerate(data))

# 自定义 Base:
alphabet = "0123456789ABCDEF..."
# base64.b64decode 替换 alphabet

# RC4:
def rc4(key, data):
    S = list(range(256))
    j = 0
    for i in range(256):
        j = (j + S[i] + key[i % len(key)]) % 256
        S[i], S[j] = S[j], S[i]
    i = j = 0
    out = []
    for byte in data:
        i = (i + 1) % 256
        j = (j + S[i]) % 256
        S[i], S[j] = S[j], S[i]
        out.append(byte ^ S[(S[i] + S[j]) % 256])
    return bytes(out)
```

### 白盒密码
```text
# 白盒 AES/DES: T-box 表查找代替 S-box
# 攻击: DFA (差分故障分析) 或 trace 分析
# 工具: phRPC 白盒攻击框架
```

## 安全边界

- 不运行未知 ELF 在沙箱外（沙箱内受 rlimit 约束）
- 不联网下载额外样本
- 不使用 sudo 或修改系统文件

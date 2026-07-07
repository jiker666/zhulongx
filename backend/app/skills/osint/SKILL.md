# OSINT CTF Skill (v9 增强版)

## 解题顺序

1. 仔细观察题目给出的所有线索（图片/文本/URL）
2. 提取 EXIF/GPS 元数据
3. 使用搜索引擎/反向图片搜索
4. 交叉验证多个信息源
5. 构造 flag 格式

## 地理定位

### 反向图片搜索
```text
Google Lens: 裁剪特定区域搜索（最佳地标/店铺/标志识别）
Google Images: 最全面
TinEye: 精确匹配
Yandex: 人脸/东欧地区效果好
Baidu: 中国地点最佳（蓝色车牌/简体中文/门楼建筑）
Bing Visual Search
```

### 定位技巧
```text
1. 道路交叉标志: 白色 X 红边 = 加拿大
2. 左侧行驶: 日本/英国/澳大利亚/印度
3. 基础设施地图:
   - Open Infrastructure Map (电力线)
   - OpenRailwayMap (铁路)
4. 路标语言: 汉字=日本, 西里尔文=俄罗斯/独联体, 阿拉伯文=中东
5. 多特征交叉验证 (铁路+电力线+山脉)
```

### 坐标格式
```text
MGRS: "4V FH 246 677" → 在线转换器 → 经纬度
Google Plus Codes: "H9G2+47X" → Google Maps 内置
What3Words: "///word.word.word" → W3W API/网站
经纬度: DD.DDDD 或 DD MM SS
```

### Google Street View 匹配
```text
1. 提取视觉特征（道路类型/车辆/容器/山形/建筑风格/植被）
2. 缩小区域范围
3. 使用 Street View 覆盖图枚举候选位置
4. 特征匹配排名
5. 提交全景 ID + 坐标

API:
GET https://maps.googleapis.com/maps/api/streetview/metadata?location=LAT,LNG&key=KEY
```

### 国别识别快捷方式
| 特征 | 国家/地区 |
|------|-----------|
| 汉字 + 蓝色公路标志 | 日本 |
| 西里尔文 + 宽阔大道 | 俄罗斯/独联体 |
| 白色 X 形交叉标志 | 加拿大 |
| 黄色菱形警告标志 | 美国/加拿大 |
| 绿色高速标志 | 德国 |
| 棕色旅游标志 | 法国 |
| 红色反光柱 | 荷兰 |

### 裁剪区域搜索
```text
裁剪图片中独特区域（招牌/建筑/车辆）单独搜索
不同裁剪可能产生不同结果 → 多次尝试
Google Lens 允许手动画框选择搜索区域
```

---

## 社交媒体 OSINT

### 用户名追踪
```text
Namechk: 跨平台用户名搜索
Sherlock: 自动化用户名枚举
WhatisMyName: 多平台用户名检查

常见平台:
- Twitter/X, Instagram, Facebook, Reddit
- GitHub, GitLab, LinkedIn
- TikTok, YouTube, Twitch
- Steam, Discord
```

### 数据泄露查询
```text
HaveIBeenPwned: 邮箱泄露检查
DeHashed: 泄露数据搜索
IntelX: 深网/暗网数据

泄露数据常含:
- 邮箱/用户名/密码哈希
- 电话号码
- 物理地址
- 个人信息
```

### 社交媒体分析
```text
1. 帖子时间线 → 确定时区
2. 语言/地理位置标签
3. 照片 EXIF (Twitter 会清除 EXIF, Tumblr 可能保留)
4. 关注者/关注关系图
5. 历史帖子 (Wayback Machine)
6. 用户名变更历史
7. 私人/删除内容 → 缓存/存档
```

### 时间线分析
```python
# 从帖子时间推断时区:
import datetime
# 如果用户在 UTC+8 时间 09:00-23:00 活跃:
# 帖子 UTC 时间减 8 小时 = 当地时间
# 验证: 多日数据一致性
```

---

## 网页与 DNS OSINT

### DNS 查询
```bash
# 基本查询:
dig ANY target.com
dig TXT target.com
dig MX target.com

# 区域传送:
dig AXFR target.com @ns.target.com

# 反向查找:
dig -x IP_ADDRESS

# DNS over HTTPS:
curl "https://dns.google/resolve?name=target.com&type=TXT"

# 子域名枚举:
subfinder -d target.com
amass enum -d target.com
```

### 网站存档
```text
Wayback Machine: web.archive.org
archive.today: archive.today
Google Cache: cache:URL
View Source: 查看源代码
```

### WHOIS
```bash
whois domain.com
# 查找: 注册人/邮箱/DNS 服务器/注册日期
```

### 证书透明度日志
```bash
# 查找子域名:
curl "https://crt.sh/?q=%.target.com&output=json" | jq '.[].name_value' | sort -u
```

### 搜索引擎高级语法
```text
site:target.com             # 限制站点
inurl:admin                 # URL 包含
intitle:"index of"          # 标题包含
filetype:pdf                # 文件类型
cache:target.com/page       # 缓存版本
"exact phrase"              # 精确匹配
OR / AND / -排除             # 逻辑运算
```

### Google Dorking
```text
site:target.com filetype:sql
site:target.com inurl:admin
site:target.com intitle:"dashboard"
site:github.com "target.com" password
```

---

## 元数据提取

### EXIF
```bash
exiftool image.jpg           # 完整 EXIF
exiftool -gps image.jpg      # GPS 坐标
exiftool -Artist image.jpg   # 作者
exiftool -Comment image.jpg  # 注释

# PDF:
pdfinfo document.pdf

# 视频:
mediainfo video.mp4
ffprobe video.mp4
```

### 文档元数据
```bash
# Office 文档:
python3 -m olefile document.docx
exiftool document.docx

# 图片:
identify -verbose image.png
```

---

## 镜像文本阅读

```text
反射表面（眼镜/水面/镜子）→ 翻转/旋转读取
车辆后视镜中的标志/商店名
窗户反射的路标
放大图像角落的微小文字
```

---

## 历史研究

```text
报纸档案:
- Library of Congress: loc.gov
- Google News Archive
- 特定主题杂志存档

结合 EXIF GPS 坐标 + 日期 → 定位特定事件
```

---

## IP 地理定位与归因

```bash
# IP 信息:
curl ipinfo.io/IP_ADDRESS
# 或: whois IP_ADDRESS

# ASN 信息:
curl "https://api.bgpview.io/ip/IP_ADDRESS"

# 指纹浏览器:
# 检查: User-Agent, 时区, 语言, 屏幕
```

---

## Overpass Turbo 空间查询

```text
# OpenStreetMap 空间查询:
# https://overpass-turbo.eu

# 查找特定区域内的建筑/设施:
[out:json]; area[name="CityName"]->.a; (node["amenity"="cafe"](area.a);); out;

# 查找特定类型的道路:
way["highway"="residential"](area.a); out;
```

---

## 工具速查

```text
Google Maps / Earth: 地理定位
Google Lens: 反向图片搜索
ExifTool: 元数据提取
Sherlock: 用户名枚举
Subfinder: 子域名发现
Wayback Machine: 网站存档
Shodan: 连网设备搜索
Censys: 证书/主机搜索
Maltego: 关系图分析
SpiderFoot: 自动化 OSINT
 Recon-ng: OSINT 框架
```

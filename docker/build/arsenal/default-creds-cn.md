# [REFERENCE] 国产系统/常见中间件默认凭证表(公开默认口令谱系)

公开谱系:各厂商公开安装手册与互联网流传的默认凭证清单(同 SecLists 默认口令
谱系)。选材 = 厂商公开默认值,与任何靶标无关。
**用法**:hint 或侦察指向"管理后台/默认凭证"时,先用本表做定向爆破(用户名×
本表口令),**再**上通用大字典——大字典没有的正是厂商默认值这一层。爆破前
先看清登录接口的加密/验证码语义(captcha、密码 MD5 前端预处理、CSRF token),
盲打大字典前先单发一发校验编码。

## 泛微 e-cology / e-office (Weaver OA)
- `sysadmin / 1`、`systemadmin / 1`(e-office 常见)
- `admin / weaver`、`admin / Weaver@2019`、`admin / weaver@2008`、`admin / Weaver@2023`
  ——**Weaver@年份是家族形状**:2019/2020/2021/2022/2023/2024 逐年生成一遍,
  厂商默认口令表里「产品名+@+近年」永远要全跑,别只打表里写死的年份
- `hr01 / hr01`、`weaver / weaver`(演示账号谱系)
- e-office 移动端默认 `admin / 123456`;老版本 `admin / admin`
- 旁路:泛微有大量未授权接口(蛋白/SQL 注入历史 CVE 家族),凭证打不开时
  先打 `/services/` RPC 面与 `DBconfigReader.jsp` 泄露链

## 用友 / 金蝶 / 致远 / 蓝凌
- 用友 NC:`sa / sa`(数据库)、`admin / 000000`(NC portal)
- 用友 U8/T+:`admin / admin`、`demo / demo`
- 金蝶 EAS:`admin / 123456`;金蝶云之家 `admin / kingdee`
- 致远 OA(A6/A8):`system / system`、`admin / admin`、`audit / audit`
- 蓝凌 OA:`admin / lingsec@2019`、`sysadmin / sysadmin`

## 中间件/平台控制台
- Tomcat Manager:`tomcat / tomcat`、`admin / admin`、`tomcat / s3cret`
- WebLogic:`weblogic / weblogic`、`weblogic / welcome1`(控制台锁死前先试)
- **Apache OFBiz(ERP/业务中台)**:**指纹两连**——①8443 上的重型 JVM
  **冷启动 ~50 秒才有首个 HTTP 响应,严禁在开机窗口内判死/重启**(重启清零
  开机时钟,永远开不完机);②Tomcat 多 context 一串 302(`/accounting/`
  `/ap/` `/ar/` `/ebay/` `/humanres/`…)就是 OFBiz 多 webapp 布局,跟着
  302 走到管理 context。demo 数据全家桶口令都是 `ofbiz`——
  `demoadmin / ofbiz`、`flexadmin / ofbiz`(flexadmin=全权限演示号)、
  `admin / ofbiz`;Demo* 用户组(DemoCustomer/DemoEmployee…)口令同为
  `ofbiz` 但多无 webtools 权限,认准 demoadmin/flexadmin。管理面
  `/webtools/control/main`,登录后**文档化原语优先**:ProgramExport(bsh/
  Groovy 事件)、EntitySQLProcessor(SQL,Derby 下 `SELECT * FROM
  SYS.SYSTABLES` 先摸库)、entitymaint;**Groovy 沙箱词法屏蔽 `execute` 时,
  字符串拼接绕过**:`'exe'+'cute'` 传给 `cmd.invokeMethod(...)` 照样调到
  Runtime.exec——黑名单挡的是源码文本,不是运行期字符串。**输出无回显面时**:
  Process 的 `getText()` 直接读 stdout;再不行 `throw new Exception(data)`
  把数据从异常通道带出来。Groovy 沙箱拒掉 File/网络调用时,用 delegator
  实体读写当回显通道(结果写进 Person 行,再从可匿名访问的 profile 屏读回)。
  **失败登录即临时禁用(~3 分钟自动解禁)**:每用户单发试探,严禁连发触发
  锁号。未授权链再打 CVE:CVE-2021-26295(SOAP runService 未授权 RCE)、
  CVE-2020-9496(SOAP 家族)、CVE-2023-51467(认证绕过→Groovy)
- ActiveMQ:`admin / admin`;RabbitMQ:`guest / guest`;Zabbix:`Admin / zabbix`
- Grafana:`admin / admin`;Nacos:`nacos / nacos`;Apollo:`apollo / admin`
- JumpServer:`admin / admin`(改密前);XXL-Job:`admin / 123456`
- SonarQube:`admin / admin`;Jenkins 初始口令在 secrets 文件(读文件优先)

## SSH/数据库侧(拿到内网立足点后)
- `root / root`、`root / 123456`、`admin / 123456`、`ubuntu / ubuntu`
- **产品名凭据层(SSH 版的厂商默认表)**:机器角色 × 产品名口令——file-server
  试 `admin / Weaver@2023` 这类「运行着什么产品就试那家的默认口令」;角色名
  (`admin`/`sysadmin`/`operator`)+ 产品默认口令表全叉积,先于通用字典。
- **hydra 对新式 SSH kex 会整批假阴性**(连接层报错 ≠ 认证失败):爆破结论
  出来是全 MISS 时,换 **ssh 客户端逐发确认式**——每个候选真发起一次 ssh
  登录(Paramiko/`sshpass` 单发),以认证响应判定,别信 hydra 的聚合判死。
- MySQL:`root / root|123456|empty`;Redis 无密码直连(`redis-cli -h` 先试);
  PostgreSQL:`postgres / postgres`;MongoDB 无认证直连
- 网络设备:`admin / admin`、`admin / cisco`、`root / admin`

## 纪律
1. 表是**第一层**,打完(~百次请求,几分钟)才轮到 top10000/flask-secrets 这类
   通用大字典——run 43633 b-02 在通用字典上烧了一小时,厂商默认层没弹药。
2. 多系统同密码:内网横向时,已到手的低权凭证(dev/developer 口令、泄露的
   secret)先在 SSH/后台/数据库上复用一遍,再开新面。
3. 登录点有验证码时:先读验证码生成逻辑(简单 OCR 可破的字符画验证码,本地
   ASCII 渲染逐列比对是公开技巧),把验证码从爆破成本里抠掉。
4. **部署残留凭据的标准落点**:`/entrypoint.sh`、`/init.*`、docker-compose/
   部署脚本、以及它们引用的 `credentials.zip` 一类压缩包——拿到机器读权限后
   `find / -maxdepth 2 \( -name 'entrypoint*' -o -name 'credential*' -o -name
   '*.zip' \)` 一把梭;zip 加密默认弱口令先试 `unzip -P 123456`(123456/
   password/infected 三连),解开就是明文账密,立即进第 2 条瀑布。

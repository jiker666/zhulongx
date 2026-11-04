# [REFERENCE] 国产系统/常见中间件默认凭证表(公开默认口令谱系)

公开谱系:各厂商公开安装手册与互联网流传的默认凭证清单(同 SecLists 默认口令
谱系)。选材 = 厂商公开默认值,与任何靶标无关。
**用法**:hint 或侦察指向"管理后台/默认凭证"时,先用本表做定向爆破(用户名×
本表口令),**再**上通用大字典——大字典没有的正是厂商默认值这一层。爆破前
先看清登录接口的加密/验证码语义(captcha、密码 MD5 前端预处理、CSRF token),
盲打大字典前先单发一发校验编码。

## 泛微 e-cology / e-office (Weaver OA)
- `sysadmin / 1`、`systemadmin / 1`(e-office 常见)
- `admin / weaver`、`admin / Weaver@2019`、`admin / weaver@2008`
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
- ActiveMQ:`admin / admin`;RabbitMQ:`guest / guest`;Zabbix:`Admin / zabbix`
- Grafana:`admin / admin`;Nacos:`nacos / nacos`;Apollo:`apollo / admin`
- JumpServer:`admin / admin`(改密前);XXL-Job:`admin / 123456`
- SonarQube:`admin / admin`;Jenkins 初始口令在 secrets 文件(读文件优先)

## SSH/数据库侧(拿到内网立足点后)
- `root / root`、`root / 123456`、`admin / 123456`、`ubuntu / ubuntu`
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

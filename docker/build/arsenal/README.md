# 公开 CVE 武器库

本目录是**公开知名 Web 利用 PoC 库**（2017-2025 高知名度框架 RCE / 认证绕过谱系），
选材标准 = 公开 notoriety，与任何具体靶标无关。每件武器自带指纹注释。

## 使用纪律（先读这个）

1. **指纹先行**：先手工侦察打实指纹（框架/版本/路由/行为），命中某武器的 fingerprint
   注释后才取用。禁止拿武器库当第一步盲扫。
2. **原样复现优先**：命中后先按脚本默认参数只换 target 原样打一发；失败才改编。
   半记忆改编是头号时间坑——差一个字段就是无回显 500。
3. **两档可信度**：
   - `[VERIFIED]`：对真实运行中的目标验证过，原样可用。
   - `[REFERENCE]`：按公开 advisory 复写。先对活靶做**无害验证**（回显探针/时间探针/
     版本回显），确认指纹与攻击面前提成立，再上攻击 payload。
4. **断网环境注意**：JNDI/LDAP/DNS 外带类 payload（log4shell、fastjson、shiro 部分
   gadget）在离线靶机打不回连——只用于**确认漏洞存在**（异常/延迟/报错差异），利用
   要转向本地回显或内存 gadget。
5. 命中即写台账（attack/<题号>/work.md）：哪个武器、哪个参数、什么回显。

## 目录

| 武器 | 族 | 可信度 |
|---|---|---|
| cve-2025-55182-react-flight-rce.py | Next.js / React Server Functions 反序列化 RCE | VERIFIED |
| apache-hugegraph-gremlin-rce.py | Apache HugeGraph-Server 无鉴权 Gremlin 沙箱逃逸（线程改名 main 绕 HugeSecurityManager） | REFERENCE |
| cve-2025-29927-nextjs-middleware-bypass.py | Next.js 中间件认证绕过 | REFERENCE |
| cve-2024-4577-php-cgi-arg-injection.py | Windows php-cgi 参数注入 RCE | REFERENCE |
| cve-2021-41713-apache-traversal-rce.py | Apache 2.4.49/50 路径穿越 + mod_cgi RCE | REFERENCE |
| cve-2022-22965-spring4shell.py | Spring 数据绑定 RCE (JSP 落盘) | REFERENCE |
| cve-2022-22947-spring-cloud-gateway-spel.py | SCG actuator SpEL RCE | REFERENCE |
| java-actuator-harvest.py | Spring Boot actuator 信息收割 | REFERENCE |
| struts2-s2-045-ognl.py | Struts2 Content-Type OGNL RCE | REFERENCE |
| shiro-550-rememberme-key-detect.py | Shiro rememberMe key 检测 | REFERENCE |
| fastjson-autotype-probe.py | fastjson autotype RCE 探测 | REFERENCE |
| thinkphp5-rce.py | ThinkPHP 5.x RCE | REFERENCE |
| cve-2023-32315-openfire-auth-bypass.py | Openfire 认证绕过 | REFERENCE |
| log4shell-detect.py | log4j JNDI 检测电池（断网友好） | REFERENCE |
| gradio-file-read-traversal.py | Gradio file= 任意读 | REFERENCE |
| langchain-llmmath-eval-rce.py | LangChain LLMMathChain eval 注入 | REFERENCE |
| vm2-sandbox-escape-pack.py | nodejs vm2 沙箱逃逸变体包（CVE-2023-30547/37903/32314 家族 + host 泄露原语） | REFERENCE |
| langflow-unauth-file-read.py | Langflow 未授权任意文件读（CVE-2025-3248）→ secret_key→admin JWT 链 | REFERENCE |
| comfyui-attack-surface.md | ComfyUI/Manager 公开攻击面手册（无鉴权 API / startup-scripts 兑换 RCE / pickle 面） | REFERENCE |
| default-creds-cn.md | 国产 OA/中间件/内网默认凭证表（泛微/用友/致远/金蝶/Tomcat…） | REFERENCE |
| geoserver-ogc-xpath-oracle.py | GeoServer OGC filter XPath 盲注 oracle（先试 CVE-2024-36401 RCE 族） | REFERENCE |
| db-privesc-postgres.md | PostgreSQL 提权/文件读手册（SET ROLE→SECURITY DEFINER→lo_import/dblink→.pgpass 阶梯） | REFERENCE |
| ssrf-bypass-pack.md | SSRF/URL 校验绕过手册（校验器分类→解析差异电池→gopher/file 兑现） | REFERENCE |
| race-harness.py | Race/TOCTOU 一次性模板（barrier 起跑+轮内自重置+自动验胜） | TEMPLATE |

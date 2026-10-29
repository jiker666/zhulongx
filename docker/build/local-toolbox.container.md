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
- **认证墙优先**:注入点几乎总在鉴权后。先花 1-2 轮打登录:默认口令矩阵(admin/admin、admin/password、公司名+年份)、注册/找回流程、cookie/JWT 逆向(flask-unsign / pyjwt + secrets 字典)。**拿不到会话就去打鉴权后的注入面 = 全部 302 白烧轮次**(41925 a-03:488 个未认证参数请求零命中)。
- **SQLi 自动化分级**:手工只做"确认注入点存在"(一个报错探针/一个布尔差分);确认后枚举交给 sqlmap。盲注必须写 python 二分脚本一次跑完,严禁逐条手发 payload。
- **诱饵 flag**:明文 env/配置/注释里的 flag 交错后,大概率是诱饵——立即转向隐藏端点/受保护资源/其他凭据,不要在原值上恋战。
- **目录/参数爆破**用 dirsearch/脚本配字典一次跑,严禁模型逐轮手点。

## 纪律
- 断网:一切联网安装都会失败,不要浪费轮次;缺什么就用 python3 现写
- 靶机远程交互:python3 + pwntools remote()(容器与靶场同网络)
- 大模型网关:已由运行环境配好,无需关心
- 附件优先 `curl -o attack/<题号>/...` 落盘再分析;台账 attack/notes.md,压缩后先读台账
- 延迟纪律:每轮大模型往返 20-70 秒,回合数即成本——批量发命令(&&/分号串联),一次侦察做全;严禁 sleep>30s(改 nohup 后台+短轮询);关键结果立即写 attack/<题号>/work.md

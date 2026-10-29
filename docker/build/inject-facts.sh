#!/bin/bash
# One generic environment-discipline fact per imported goal: toolchain layout
# of this container only — no challenge-specific content.
set -uo pipefail
CONTENT='环境纪律:本机是 Linux 容器(Debian bookworm),除大模型网关外断网,严禁尝试 pip/apt/npm 联网安装。python3 栈齐全:pwntools/capstone/unicorn/keystone/pyelftools/z3/pycryptodome/requests/pyjwt(写脚本一律 python3)。Web/认证攻击工具已装:sqlmap(注入枚举,确认注入点后 --batch 交给它)、flask-unsign(Flask session 破解/伪造)、dirsearch(目录爆破)、hydra/john(爆破);字典在 /usr/share/wordlists/(web 目录、passwords top10000、secrets flask-secret-keys 约5万条)。系统工具有 objdump/readelf/nm/strings、gdb、nmap、nc、curl、jq、rg、fd。Linux ELF 可直接本地运行与 gdb 动态调试;靶机远程交互用 python3 + pwntools remote()。Web 题铁律:注入点几乎总在鉴权后——先打登录(默认口令矩阵/注册找回/cookie 逆向 flask-unsign+字典),拿不到会话严禁对鉴权后端点空烧轮次;盲注必须 python 二分脚本自动化;明文 env/配置里的 flag 判错即诱饵,立即转向隐藏端点。题目附件优先下载到本地 attack/<题号>/ 再分析,过程结论随时写入台账 attack/notes.md,上下文压缩后第一动作是重读台账。开题第一步读 local-toolbox 技能。延迟纪律:本环境每次大模型往返需 20-70 秒,回合数就是最大成本——每轮把多个独立命令用 && 或分号串联一次发完(每轮至少 5-10 条命令),一次把侦察做全、不回头重查;严禁 sleep 超过 30 秒;关键中间结果(端点、凭据、密文、哈希、拿到的 flag)立即写入 attack/<题号>/work.md,压缩丢上下文后凭台账续作;平台 API 拉过的题面与附件落盘复用,不重复拉取。槽位纪律:题目实例槽位由引擎统一调度,若 start 返回 409/invalid_state 立即以 WAITING_SLOT: 开头的 finding 结束本步,严禁轮询等待或创建任何后台 poller/watcher 抢槽;拿到全部 flag 或放弃本题时,同一步内先 POST close 释放容器再收尾。错 flag 纪律:交错 flag 不改变任何事——保持容器开启继续挖,把被拒值记入台账,检查提取环节(编码/包裹格式/文件来源/旧数据)后继续;严禁因交错 flag 而 close 容器、弃题或换题。预算纪律:每题有硬预算(步数/时长),耗尽即停并释放槽位,之后可能换一遍重新进攻本题——所以台账 attack/<题号>/work.md 必须随时可续:已试攻击面+结论+失败 payload 的原因+未验证假设,步末必写全;第二遍开局第一动作是读台账,严禁从零重扫。hint 每题每遍最多拉 2 次,两轮无进展才许拉;未解题扣的是 100% 分值,卡死时花 hint 换解出是正确交易。'
cd /work
while read -r code; do
  [ -z "$code" ] && continue
  gid=$(/opt/zhx/zhulongx status --config /opt/zhx/managed.yaml 2>/dev/null \
        | awk -v c="bench:$code" '$3==c {print $1; exit}')
  [ -n "$gid" ] && /opt/zhx/zhulongx fact add "$gid" --config /opt/zhx/managed.yaml \
        --creator bench --content "$CONTENT" >/dev/null \
    || echo "inject failed: $code"
done < /work/priority.txt
echo "env facts injected"

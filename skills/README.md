# CTF Skills

玄枢将公开 CTF skills 作为“知识索引”接入，而不是把外部仓库的命令、脚本或工具权限直接导入运行时。

当前精选来源：

- 仓库：[ljagiello/ctf-skills](https://github.com/ljagiello/ctf-skills)
- 固定版本：`d6662d26b5ed3caa56f5eaf6eb887964f3747162`
- 许可证：MIT
- 接入方式：仅整理类别描述、技术族与 pivot 信号；运行时按任务 `metadata.category` 选择一个索引并和通用 playbook 一起注入。

## 已接入类别

| 本地类别 | 上游 skill | 主要覆盖 |
| --- | --- | --- |
| `web` | `ctf-web` | HTTP、API、身份、解析器、浏览器与 Web3 信任边界 |
| `pwn` | `ctf-pwn` | 栈、格式化字符串、ROP、堆、seccomp 与内核利用 |
| `crypto` | `ctf-crypto` | RSA、对称密码、ECC、PRNG、格与 oracle |
| `reverse` | `ctf-reverse` | 原生程序、移动端、固件、WASM、字节码与自定义 VM |
| `forensics` | `ctf-forensics` | 磁盘、内存、网络、日志、媒体、信号与隐写 |
| `malware` | `ctf-malware` | 静态分析、混淆、配置、C2 协议与反分析 |
| `misc` | `ctf-misc` | 编码、jail、约束、游戏、无线电与混合题型 |
| `osint` | `ctf-osint` | 公开来源、身份、地理、DNS、历史页面与媒体核验 |
| `ai/ml` | `ctf-ai-ml` | 模型权重、对抗样本、提取、推断、投毒与 LLM 接口 |

运行时实现位于 `src/skill-catalog.ts`，类别 playbook 接入点位于 `src/playbooks.ts`。

## 安全与内容边界

- 上游内容中的具体比赛题目、题号、固定目标、固定敏感文件路径、提交模板和现成答案不会进入核心提示词。
- 上游声明的 `Bash`、`WebFetch`、`WebSearch` 等工具权限不被继承。网络请求仍只能通过玄枢注册的 HTTP/TCP 工具，并经过 `PolicyEngine`、operator-owned scope 和预算检查。
- 上游安装脚本不会在构建或运行时执行。sandbox 工具由 `tools/ctf/capabilities.json` 和锁定的 requirements 独立管理。
- 外部 skill 只能提供待验证的策略候选，不能作为发现、地址、凭据或完成状态的证据。

## 更新流程

1. 固定新的上游 commit，核对许可证和变更范围。
2. 检查新增内容是否包含站点专用选择器、固定答案、凭据、主动扫描或绕过作用域的命令。
3. 只将通用技术族和类别 pivot 信号人工归一化到 `src/skill-catalog.ts`。
4. 更新 `THIRD_PARTY_NOTICES.md`，运行 `npm run check` 后再合并。

`DaoYiSec/SecSkills` 目前只作为公开项目发现索引；其 CTF 条目仍指向上述 `ljagiello/ctf-skills`。`ctf-super-hub` 是包含混合许可证内容的二次集合，`VulnClaw` 与 `cybersec-toolkit` 则是独立运行时/工具链，因此未直接并入本项目。

# XH-202609 用户与部署手册

| 项目 | 内容 |
| --- | --- |
| 文档编号 | XH-202609-04 |
| 版本 | 1.0 |
| 对应代码基线 | `723f047`（`main`） |
| 读者 | 参赛队员、现场操作员、部署维护人员 |
| 编制日期 | 2026-08-31 |

## 1. 使用范围与安全前提

烛龙·玄枢仅用于明确授权的竞赛、教学靶场、实验室与安全研究环境。使用者对目标、模型服务和附件材料的授权负责。系统默认 `scope.mode=observe` 且不配置授权主机；模型请求本身不会开启网络或命令权限。

请在操作前确认：

1. 已取得主办方或环境所有者对任务、目标和数据的明确授权。
2. operator 已配置最小必要 scope、主机、端口、程序 allowlist 和预算。
3. 现场使用的模型 Key、服务令牌和网关参数只存在于私有环境或当前进程，不进入仓库、截图、运行描述和比赛压缩包。
4. 单次运行 scope override 只能收窄既有范围，不能增加主机、程序、路径或将 `observe` 提升为 `controlled`。

## 2. 部署方式概览

| 方式 | 适用场景 | 访问地址 | 特点 |
| --- | --- | --- | --- |
| 本地开发模式 | 联调、前端开发、源码调试 | API `http://127.0.0.1:7318/`；Vite `http://127.0.0.1:5173/` | 前后端分开运行，便于定位问题 |
| Podman / Docker Compose | 比赛现场、演示、可重复部署 | `http://127.0.0.1:7318/` | API 与已构建前端合并，配套无外网 sandbox |
| 主办方托管环境 | 按主办方规则部署 | 由现场配置决定 | 使用私有配置 overlay，不提交敏感参数 |

## 3. 本地开发模式

### 3.1 前置条件

- Node.js `>=22.19.0`
- npm
- 已授权的模型服务配置（仅在需要真实模型时）
- 需要命令分析时，准备 Podman、Docker 或本地 CTF sandbox

### 3.2 安装与基础验证

```bash
git clone https://github.com/jiker666/zhulong-xuanshu.git
cd zhulong-xuanshu
npm ci --legacy-peer-deps --ignore-scripts
npm --prefix frontend ci --ignore-scripts
cp .env.example .env

npm run check
npm --prefix frontend run build
```

在 `.env` 或私有环境中设置所需变量，切勿将真实值复制到公共配置：

```text
XUANSHU_MODEL_API_KEY=<仅保存在本机私有环境中>
XUANSHU_SERVER_TOKEN=<本地控制面令牌>
```

启动后端和前端：

```bash
# 终端 1：API
XUANSHU_SERVER_TOKEN="<本地随机令牌>" npm run serve

# 终端 2：Vite 前端
npm --prefix frontend run dev
```

服务默认在回环地址监听。通过 `http://127.0.0.1:7318/health` 检查 API，通过 `http://127.0.0.1:5173/` 打开开发控制台。不要将此默认本地地址理解为公开线上服务。

### 3.3 可选本地 sandbox

```bash
mkdir -p workspace .xuan-shu/work
sh tools/ctf/run-local-sandbox.sh
npm run sandbox-health
```

sandbox 只执行 operator allowlist 中的结构化程序，输入只读，结果写入逐运行 scratch。它不应通过命令行作为绕过网络策略的通道。

## 4. Podman / Docker Compose 一键启动

### 4.1 macOS / Linux

在项目根目录执行：

```bash
./start.command
```

首次缺少执行权限时：

```bash
chmod +x start.command
./start.command
```

### 4.2 Windows

准备好 Podman 或 Docker 引擎后，双击 `start.bat`。也可以在命令提示符中从项目根目录运行该脚本。

### 4.3 脚本行为

两个脚本都会：

1. 优先检查 `podman compose` 或 `podman-compose`，其次检查可连接的 Docker Compose；
2. 在 macOS Podman machine 未启动时尝试启动，未初始化时给出 `podman machine init && podman machine start` 提示；
3. 在未设置 `XUANSHU_SERVER_TOKEN` 时生成一次性随机令牌；
4. 构建 API 与 React 前端合并镜像，并启动 `xuanshu` 与 `ctf-sandbox`；
5. 最多等待 120 秒轮询 `/health`；
6. 服务健康后自动打开 `http://127.0.0.1:<端口>/`；
7. 将本次生成的服务令牌打印到终端，供控制台右上角钥匙按钮输入。

macOS 首次使用 Podman：

```bash
podman machine init
podman machine start
```

还需要可用的 Compose provider。执行 `podman compose version`；若无 provider，安装 `podman-compose` 或按 Podman 的 provider 配置完成安装。provider 可以是外部 Compose 可执行文件；只要由 `podman compose` 调用且 Podman engine 已连接，容器仍由 Podman 运行。脚本会在 provider 缺失时停止并提示，避免错误地改用不可用的 Docker 引擎。

默认端口为 `7318`。端口被占用时：

```bash
XUANSHU_PORT=17318 ./start.command
```

手工启动示例：

```bash
XUANSHU_SERVER_TOKEN="<现场随机令牌>" podman compose up -d --build
```

当前机器使用 `podman-compose`、`docker compose` 或独立 `docker-compose` 时，将命令前缀替换为实际可用 provider。停止服务：

```bash
podman compose ps
podman compose logs --tail=100 xuanshu ctf-sandbox
podman compose down
```

### 4.4 容器边界

Compose 仅将 API 端口绑定至 `127.0.0.1`；`workspace/` 以只读方式挂载；运行数据写入 named volumes；`ctf-sandbox` 使用 `network_mode: none`。网络工具仍由 API 进程中的 `PolicyEngine` 与 scope 控制，安装更多 sandbox 工具不会增加网络权限。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XUANSHU_SERVER_TOKEN` | 启动脚本临时生成 | 控制面 Bearer 令牌；手动启动时必须设置 |
| `XUANSHU_PORT` | `7318` | 宿主机回环端口 |
| `XUANSHU_MODEL_API_KEY` | 空 | operator 管理的默认模型密钥（Anthropic 协议端点） |
| `XUANSHU_INSTALL_HEAVY_CTF_TOOLS` | `false` | 是否构建扩展工具；会增加构建时间和镜像体积 |

## 5. 控制台操作指南

### 5.1 创建任务和添加附件

1. 打开控制台，在右上角钥匙按钮输入本次 API 服务令牌。
2. 创建运行，填写明确、可授权的任务目标。
3. 添加附件：可点击“添加文件”，也可将文件直接拖拽到附件投放区。
4. 确认任务描述、附件和授权范围后启动运行。

上传文件进入本次运行的只读输入边界。不要上传无权使用的生产数据、真实凭据、个人信息或含密钥的配置文件。ZIP 解压和二进制搜索均有条目、字节、模式和输出限制。

### 5.2 阅读 Decision Observatory

运行详情以事实投影展示自主决策闭环，而不是展示模型隐藏思维。可见信息包括：

| 区域 | 含义 | 操作建议 |
| --- | --- | --- |
| Mission Control | 状态、阶段、回合、工具、策略和审计完整性 | 先确认是否仍在运行、阻塞或已终态 |
| Current Decision / Timeline | 公开的行动、理由、影响、结果和下一步 | 将其作为证据导向的操作解释，不视为隐藏推理 |
| Hypothesis / Evidence Graph | 假设状态、来源、支持与矛盾证据 | 关注是否存在独立验证，而非单一文本结论 |
| Policy Details | 允许或拒绝的具体原因 | 被拒绝时检查 scope、allowlist、预算或重复动作 |
| Replay / Fork / Resume | 按审计序号回放、创建分支或继续任务 | 分支只继承公开且已脱敏的轨迹；父运行不变 |
| Human Review | 对事实作正确/错误/不确定标注 | 人工复核不覆盖原审计链 |

连续无证据、重复动作或工具失败接近阈值时，运行会要求 checkpoint 和策略修订。应查看失败分类与下一步依据，不能通过反复点击或扩大单次 scope 强行绕过该门禁。

### 5.3 模型设置

进入“模型设置”，可填写 OpenAI-compatible Base URL、API 类型、模型/部署 ID、API Key、可选 AppKey 和推理格式。配置只保存于当前 API 进程内存：

- 不写入浏览器 `localStorage` 或 `sessionStorage`；
- 不由设置读取接口回显 API Key；
- 不写入 audit、state、transcript 或 WP；
- 服务重启后自动清除，需重新配置。

无人值守或比赛现场长期部署时，使用被 Git 忽略的私有配置和环境变量。页面内不得粘贴或截图公开任何真实密钥。

### 5.4 最终结论、Flag 与 WP 下载

终态运行的“运行总结结论”区域显示结构化 summary。存在 CTF submission 时，页面会以醒目的 `FLAG FOUND` 与独立 Flag 字段展示最终值。该值来自 `finish_task` 和验证记录，系统不会从模型聊天文本或日志中猜测 Flag。

点击“下载 WP”后：

1. 已持久化 WP 直接下载；
2. 没有 WP 时，系统请求独立生成步骤；
3. 生成器只使用运行的公开、脱敏事实，输出固定结构的竞赛 WP；
4. 生成失败时下载结构化兼容报告，并显示受限错误原因；不会编造解题脚本、证据或答案。

WP 生成只允许在 `completed`、`blocked`、`failed` 或 `aborted` 等终态运行上发起。严格提交任务仍以独立验证闸门为准，人工应在提交平台前复核最终结论和授权范围。

## 6. 现场运行检查清单

比赛或演示开始前：

1. 固定 Git commit，运行 `npm run check`、前端构建和 Compose 配置检查。
2. 有可连接的 Podman 或 Docker 容器引擎时，完成 Compose 构建、`/health`、令牌登录和只读附件冒烟。
3. 以最小 scope 准备现场目标；确认主机、端口、工具白名单和预算。
4. 使用本次启动生成的服务令牌；模型密钥留在私有环境中。
5. 验证可拖拽附件、可查看决策轨迹、可显示最终结论/Flag、可下载 WP。
6. 准备脱敏的测试证据，避免屏幕录像、截图或导出中含 Key、Cookie、Authorization、真实目标信息或未公开答案。

比赛结束后：停止容器或本地服务，清理临时 `.xuan-shu/` 运行产物和私有 `.env`，仅保留脱敏、可提交的文档与验证记录。

## 7. 备份、恢复与停机

| 对象 | 位置 | 说明 |
| --- | --- | --- |
| 完整运行状态 | `.xuan-shu/runs/<run-id>/state.json` 或容器数据卷 | 仅用于详情和恢复；含任务信息，应按敏感级别保存 |
| 审计与人工复核 | `audit.jsonl`、`reviews.jsonl` | 审计链追加，人工复核不改写原始事件 |
| 交接摘要 | `handoff.md` | 脱敏、限长，供恢复与人工交接参考 |
| 运行列表索引 | `summary.json` | 可由完整状态后台补齐，不代替完整事实 |

服务重启后，未完成运行会按 no-replay 语义结算，避免自动重复副作用。需要继续分析时，请在控制台使用 Resume 或从指定审计序号 Fork，在新的独立 run 中审查范围和下一步；不要手工复制旧命令进行未经复核的重放。

## 8. 常见问题

| 现象 | 原因或检查项 | 处理方式 |
| --- | --- | --- |
| 无法访问控制台 | API 未健康、端口被占用、令牌错误或 Podman machine 未启动 | 检查 `/health`、启动脚本输出、`podman compose ps`、`podman machine list` 和端口 |
| 工具被策略拒绝 | scope、主机/端口、程序、路径、预算或重复动作不满足 | 查看 Policy Details；由 operator 调整完整配置，不能使用 run override 扩权 |
| 运行停止或要求修订 | checkpoint、工具失败、无证据或重复动作阈值触发 | 阅读失败分类、计划变化与证据，再决定是否继续 |
| 前端不实时刷新 | SSE、服务令牌或后端连接异常 | 刷新后使用审计回放；检查 API 与浏览器控制台 |
| 历史运行显示“正在索引” | 老运行尚未生成 `summary.json` | 等待后台回填；详情仍可读取完整状态 |
| WP 无法生成 | 运行未终态、模型未配置、公开事实不足或格式校验失败 | 先终态化并检查 writeup 事件；不手工补造答案/脚本 |
| sandbox 不可用 | Podman/Docker 引擎、socket、能力清单或 allowlist 不匹配 | 查看 `npm run sandbox-health` 和容器日志；不要放开网络或程序白名单 |

部署细节见 [容器化部署](../docker-deployment.md)，模型配置边界见 [模型设置](../model-settings.md)，工具副作用见 [工具副作用与审计契约](../tool-side-effects.md)。

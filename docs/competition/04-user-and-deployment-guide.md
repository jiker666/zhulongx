# 用户与部署手册

## 1. 适用范围

本手册用于本地开发、授权实验室、教学靶场和主办方受控评测环境。使用者必须拥有目标和模型服务的合法授权。系统默认 `scope.mode=observe` 且无授权主机，主动网络能力不会因模型请求而自动开启。

## 2. 本地部署

### 2.1 前置条件

- Node.js `>=22.19.0`
- npm
- 已获授权的模型服务环境变量
- 运行 sandbox 或平台适配时所需的 operator-owned 配置

### 2.2 安装与配置

```bash
git clone https://github.com/jiker666/zhulong-xuanshu.git
cd zhulong-xuanshu
npm install --legacy-peer-deps --ignore-scripts
npm --prefix frontend ci --ignore-scripts
cp .env.example .env
```

在 `.env` 中填写所选模型供应商的 Key。不要把 `.env`、模型密钥、平台令牌、Cookie 或 Authorization 头提交到 Git、截图或比赛压缩包。

先验证工程：

```bash
npm run check
npm --prefix frontend run build
```

### 2.3 启动审计台

```bash
XUANSHU_SERVER_TOKEN="replace-with-a-long-random-value" npm run serve
```

默认本地地址为 `http://127.0.0.1:7318/`。这是本机测试地址，不等同于可公开访问的线上服务；在非回环地址启动时必须设置服务令牌。

### 2.4 Docker Compose 一键启动

Docker Desktop 启动后，在项目根目录执行：

```bash
./start.command
```

Windows 用户双击 `start.bat`。脚本会自动检查 `docker compose`/`docker-compose`、构建 API + React 合并镜像、启动无外网 `ctf-sandbox`、轮询 `/health`，并打开浏览器。未设置 `XUANSHU_SERVER_TOKEN` 时会生成只用于本次进程的随机令牌并打印；在页面右上角钥匙按钮中输入即可。也可以手动执行：

```bash
XUANSHU_SERVER_TOKEN="replace-with-a-long-random-value" docker-compose up -d --build
```

默认访问 `http://127.0.0.1:7318/`，端口占用时使用 `XUANSHU_PORT=17318 ./start.command`。停止服务：`docker-compose down`。Compose 将 `workspace/` 只读挂载，运行数据写入 named volumes，sandbox 使用 `network_mode: none`。

### 2.5 启动本地 sandbox（可选）

```bash
mkdir -p workspace .xuan-shu/work
sh tools/ctf/run-local-sandbox.sh
npm run sandbox-health
```

sandbox 只执行 operator allowlist 中的结构化程序，并使用独立 scratch；它不直接拥有外网权限。

## 3. 控制台操作

1. 在控制台创建或选择运行，填写明确的授权任务目标。
2. 选择或上传只读附件；可点击“添加文件”，也可将文件拖拽到附件投放区。每个运行拥有独立输入和 scratch 边界。
3. 观察 agent 的任务理解、计划、策略判定、工具结果与 checkpoint。
4. 需要时停止运行、人工复核证据，或从指定审计事件创建新的分支运行。
5. 仅在证据、scope 和完成标准满足时接受结论；不要把模型文本当作未经验证的事实。

轨迹界面会以“做什么、为什么、影响、结果、下一步”解释可复核动作。技术事件可以按模型/上下文/策略/工具/子 Agent 来源筛选、检索、回放和分支；隐藏推理和凭据不会显示或保存。

运行记录较多时，审计列表会先读取每次运行保存的轻量摘要；旧运行的摘要在后台补齐，期间卡片会显示“正在索引”。打开具体运行仍会读取完整状态与审计轨迹，历史运行数据不会因列表索引被删改。

### 3.1 模型设置

进入“模型设置”页面，填写 OpenAI-compatible 的 Base URL、API 类型、模型/部署 ID、API Key 和可选网关 AppKey。配置只保存在当前 API 进程内存中，不写入浏览器持久存储、审计链或运行产物；重启服务后需重新填写。无人值守部署请使用被 Git 忽略的私有配置和环境变量。

### 3.2 最终结论与 WP

运行详情页的“运行总结结论”区域会明确展示 `finish_task` 写入的最终提交；识别为 CTF 结果时会以醒目的 `FLAG FOUND` 和 Flag 字段展示。运行有总结时可点击“下载 WP”，已有模型写入的 WP 会直接下载；没有 WP 时，页面会请求 AI 按固定结构生成，并在失败时下载脱敏的结构化兼容报告。报告只使用运行中的公开证据，不从日志猜测答案，也不保存隐藏推理。

## 4. 二进制与附件分析

- 对 ZIP 附件，`extract_archive` 只解压到当前 run scratch，拒绝路径穿越与符号链接。
- 对二进制/文本材料，`search_artifact` 可进行受限 UTF-8 或十六进制字节搜索。
- 完整 sandbox 中的 Radare2、JADX、Pwntools、`gdb-multiarch`、`ltrace` 和 binutils 由运行前能力协商和 allowlist 控制。
- 网络交互仍需使用 scope 内的 HTTP/TCP/Browser 工具；不得以 sandbox 命令绕过网络策略。

## 5. 托管评测

主办方托管模式应以 `config/container.yaml` 为基础创建被 Git 忽略的私有配置 overlay，并按现场规则填写模型协议、网关地址、环境变量名、scope 与预算。模型 Key、平台 Token 和评测数据地址只通过运行环境注入，不能写入镜像、仓库或运行日志。交付机应按 [Docker 部署](../docker-deployment.md) 执行构建、健康检查和前端冒烟，并把镜像摘要和环境 manifest 记录到脱敏测试附件。

## 6. 本地验收入口

```text
API 健康检查：`http://127.0.0.1:7318/health`
前端控制台：`http://127.0.0.1:7318/`（Compose 合并镜像）或 `http://127.0.0.1:5173/`（Vite 开发服务器）
验收版本：`337efb2020e536d2bb9deb7408f2f7d9ece45d03`
访问方式：使用启动脚本打印的本次 `XUANSHU_SERVER_TOKEN`，在页面钥匙按钮中输入；模型 Key 仅在“模型设置”页临时配置。

这两个地址均为本机回环地址，不是公开线上服务，不提供共享账号或生产凭据。
```

## 7. 常见问题

| 现象 | 排查方式 |
| --- | --- |
| 工具被拒绝 | 检查 operator scope、程序 allowlist、路径、主机、端口和预算；不能用 per-run override 扩权 |
| 运行停止或超时 | 查看 checkpoint、错误分类与审计链；优先调整计划或配置，不要盲目重复 |
| 前端无实时更新 | 检查服务令牌、SSE 连接和运行状态；历史事件可从 audit 轨迹回放 |
| sandbox 不可用 | 运行 `npm run sandbox-health`，核对 sidecar 与能力清单；不要临时放开程序白名单 |
| 模型或平台限流 | 查看模型速率门控和退避记录，降低并发或等待额度恢复 |

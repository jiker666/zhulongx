# 容器化部署（Podman / Docker Compose）

本项目使用标准 Compose 文件，可通过 Podman Compose 或 Docker Compose 部署。部署包含两个容器：`xuanshu` 提供 API 和已构建的 React 前端，`ctf-sandbox` 提供无外网的命令执行隔离环境。运行数据写入 named volumes，不会写回源码目录；`workspace/` 以只读方式挂载给两个容器。

## 一键启动

在项目根目录执行：

```bash
./start.command
```

Windows 用户双击 `start.bat`。两个脚本会优先使用 Podman；未安装 Podman 时才使用可连接的 Docker 引擎。脚本都会：

1. 检查容器引擎和 Compose provider（`podman compose`、`podman-compose`、`docker compose` 或 `docker-compose`）。
2. 若本机已有 Podman machine 但未启动，尝试启动它；未初始化时给出准确提示。
3. 构建前后端合并镜像并启动 sandbox。
4. 等待 `ctf-sandbox` 和 API 健康检查完成。
5. 打开 `http://127.0.0.1:7318/`。

macOS 首次使用 Podman 时先执行：

```bash
podman machine init
podman machine start
```

Podman Compose 需要可用 provider。若 `podman compose version` 不可用，请安装 `podman-compose` 或按 Podman 的 provider 配置完成安装后再运行启动脚本。

如果没有设置 `XUANSHU_SERVER_TOKEN`，脚本会为本次容器启动生成随机令牌并打印一次。打开页面后使用右上角钥匙图标输入令牌。令牌不会写入仓库、运行产物或浏览器持久存储。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XUANSHU_MODEL_API_KEY` | 空 | operator 配置的默认模型密钥（Anthropic 协议端点）；也可在模型设置页面临时配置 |
| `XUANSHU_SERVER_TOKEN` | 启动脚本自动生成 | API Bearer 令牌。手动 Compose 启动时必须设置 |
| `XUANSHU_PORT` | `7318` | 宿主机回环端口，例如 `17318` |
| `XUANSHU_INSTALL_HEAVY_CTF_TOOLS` | `false` | 是否安装体积较大的扩展工具 |
| `XUANSHU_SCOPE_MODE` | 配置文件值（默认 `observe`） | operator 显式开启受控网络时设为 `controlled` |
| `XUANSHU_ALLOWED_HOSTS` | 空 | 以空格或逗号分隔的授权主机；只影响当前 API 进程，仍受 PolicyEngine 预算检查 |

手动启动示例：

```bash
XUANSHU_SERVER_TOKEN="replace-with-a-long-random-value" \
  podman compose up -d --build
```

如果本机使用的是 `podman-compose`、`docker compose` 或独立的 `docker-compose`，将命令前缀替换为可用 provider。启动脚本会自动完成这一选择。

## Agent SDK 二进制校验

嵌入的 agent 运行时通过 `@anthropic-ai/claude-agent-sdk` 按会话拉起内置 CLI 子进程。CLI 二进制以平台专属 optional dependency 的形式安装（如 `@anthropic-ai/claude-agent-sdk-linux-arm64`），`npm ci --legacy-peer-deps --ignore-scripts` 不会跳过它们。镜像构建或部署后可在容器内自检：

```bash
# 1) SDK 可以加载并定位平台 CLI（无输出即成功）
node -e "import('@anthropic-ai/claude-agent-sdk').then(() => console.log('sdk ok'))"
# 2) 平台包真实存在（按容器架构选择 linux-x64 / linux-arm64 / musl 变体）
ls node_modules/@anthropic-ai/ | grep claude-agent-sdk
```

CLI 子进程以服务用户（镜像内 uid 10001）身份运行；若上述第 2 步找不到任何平台包，说明镜像构建时 npm 以 `--omit=optional` 解析或架构不匹配，首个任务会以 `Native CLI binary for <platform>-<arch> not found` 错误失败。

## 停止与诊断

```bash
podman compose ps
podman compose logs --tail=100 xuanshu ctf-sandbox
podman compose down
```

宿主机端口被占用时，使用 `XUANSHU_PORT=17318 ./start.command`（Windows 可在命令提示符中先执行 `set XUANSHU_PORT=17318`）。API 健康地址为 `http://127.0.0.1:<端口>/health`。

Compose 只将 API 端口绑定到 `127.0.0.1`；sandbox 使用 `network_mode: none`，不具备外网访问能力。主动网络能力仍受运行时 `PolicyEngine` 和 operator scope 控制。

授权 Web/CTF 任务需要 operator 先配置精确目标范围。默认配置不会放行外网；例如临时验证一个明确授权的主机：

```bash
XUANSHU_SCOPE_MODE=controlled \
XUANSHU_ALLOWED_HOSTS='d836c4b2d268a361615f1d3b.http-ctf2.dasctf.com' \
XUANSHU_SERVER_TOKEN="replace-with-a-long-random-value" \
podman compose up -d --build
```

不要使用通配符扩大比赛范围。任务级 scope 只能进一步收窄 operator 配置，不能添加主机。

## Agent 与知识库

容器启动后，Agent 仍会在每次任务的首次规划前检索挂载的 `workspace/` 知识库。默认 Compose 配置将该目录以只读方式挂载；如果要使用本地知识库语料，请在宿主机项目目录的 `workspace/` 下准备文件，再重新创建容器即可。

对于题库来源任务或显式设置 `submissionPolicy: "strict"` 的任务，Agent 只有在候选值被成功工具输出和独立验证结果同时支撑时才会调用 `finish_task`。每次运行的脱敏交接摘要位于 `.xuan-shu/runs/<run-id>/handoff.md` 对应的数据卷中，可用于恢复任务和排查自动规划过程。

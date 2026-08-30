# Docker 部署

本项目的 Compose 部署包含两个容器：`xuanshu` 提供 API 和已构建的 React 前端，`ctf-sandbox` 提供无外网的命令执行隔离环境。运行数据写入 Docker named volumes，不会写回源码目录；`workspace/` 以只读方式挂载给两个容器。

## 一键启动

确保 Docker Desktop 正在运行，然后在项目根目录执行：

```bash
./start.command
```

Windows 用户双击 `start.bat`。两个脚本都会：

1. 检查 Docker Compose（兼容 `docker compose` 和 `docker-compose`）。
2. 构建前后端合并镜像并启动 sandbox。
3. 等待 `ctf-sandbox` 和 API 健康检查完成。
4. 打开 `http://127.0.0.1:7318/`。

如果没有设置 `XUANSHU_SERVER_TOKEN`，脚本会为本次容器启动生成随机令牌并打印一次。打开页面后使用右上角钥匙图标输入令牌。令牌不会写入仓库、运行产物或浏览器持久存储。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 空 | operator 配置的默认模型密钥；也可在模型设置页面临时配置兼容端点 |
| `XUANSHU_SERVER_TOKEN` | 启动脚本自动生成 | API Bearer 令牌。手动 Compose 启动时必须设置 |
| `XUANSHU_PORT` | `7318` | 宿主机回环端口，例如 `17318` |
| `XUANSHU_INSTALL_HEAVY_CTF_TOOLS` | `false` | 是否安装体积较大的扩展工具 |

手动启动示例：

```bash
XUANSHU_SERVER_TOKEN="replace-with-a-long-random-value" \
  docker compose up -d --build
```

当前安装只有独立 `docker-compose` 命令时，将上面的命令替换为 `docker-compose` 即可。

## 停止与诊断

```bash
docker compose ps
docker compose logs --tail=100 xuanshu ctf-sandbox
docker compose down
```

宿主机端口被占用时，使用 `XUANSHU_PORT=17318 ./start.command`（Windows 可在命令提示符中先执行 `set XUANSHU_PORT=17318`）。API 健康地址为 `http://127.0.0.1:<端口>/health`。

Compose 只将 API 端口绑定到 `127.0.0.1`；sandbox 使用 `network_mode: none`，不具备外网访问能力。主动网络能力仍受运行时 `PolicyEngine` 和 operator scope 控制。

## Agent 与知识库

容器启动后，Agent 仍会在每次任务的首次规划前检索挂载的 `workspace/` 知识库。默认 Compose 配置将该目录以只读方式挂载；如果要使用本地知识库语料，请在宿主机项目目录的 `workspace/` 下准备文件，再重新创建容器即可。

对于题库来源任务或显式设置 `submissionPolicy: "strict"` 的任务，Agent 只有在候选值被成功工具输出和独立验证结果同时支撑时才会调用 `finish_task`。每次运行的脱敏交接摘要位于 `.xuan-shu/runs/<run-id>/handoff.md` 对应的数据卷中，可用于恢复任务和排查自动规划过程。

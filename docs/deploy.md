# CyberPilot FinalOps v4 Podman 部署文档

本机交付只使用 Podman。`docker-compose.yml` 仅作为兼容文件保留，现场启动、停止、验证和故障处理统一使用 `podman compose` 或 Makefile 封装命令。

## 1. 前置条件

- Podman 4.x+
- Node.js 20+，仅本地前端开发需要
- Python 3.11+，仅本地后端开发和脚本测试需要

检查：

```bash
podman --version
podman compose version
make doctor
```

## 2. 推荐现场启动

```bash
cd cyberpilot
cp .env.example .env
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up
```

访问：

- FinalOps: `http://localhost:13000/final-ops`
- Settings: `http://localhost:13000/settings`
- Health: `http://localhost:18000/api/health`
- API Docs: `http://localhost:18000/docs`

停止：

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-down
```

日志：

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-logs
```

## 3. 直接 Podman 命令

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 \
  podman compose -f podman-compose.yml up -d --build

COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 \
  podman compose -f podman-compose.yml down
```

解析 compose：

```bash
podman compose -f podman-compose.yml config
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 \
  podman compose -f podman-compose.yml config
```

## 4. ScopeGuard 配置

决赛靶场必须显式配置授权范围：

```env
COMPETITION_MODE=true
SCOPE_CIDRS=10.10.0.0/16
SCOPE_DOMAINS=*.arena.local,target.local
SCOPE_PORTS=80,443,8080-8090
SCOPE_ALLOW_PRIVATE_IPS=true
SCOPE_ALLOW_LOCALHOST=false
```

检查：

```bash
curl -s http://localhost:18000/api/scope/check \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://target.arena.local:8080/"}'
```

也可以在 Settings 页面使用 ScopeGuard 检查器。

## 5. 训练和交付验证

```bash
make test
make demo-smoke
make final-drill
make team-drill
make safety-audit
make release-check
make package
```

## 6. 备份与恢复

导出：

```bash
make backup-final
```

恢复：

```bash
make restore-final FILE=backups/finalops-YYYYmmdd-HHMMSS.json
```

FinalOps 页面顶部也提供“导出备份”和“导入备份”按钮。

## 7. 常见问题

**端口冲突**

改 `FRONTEND_PORT` 和 `BACKEND_PORT`，推荐 13000/18000。

**旧容器冲突**

使用 `COMPOSE_PROJECT_NAME=cyberpilot_v4`，不要删除无关容器。

**ScopeGuard 拦截**

先用 Settings 或 `/api/scope/check` 查看 reason 和 matched_rule，再核对 `.env` 授权范围。

**前端无法连接后端**

确认访问的是前端端口；容器内由 Vite/Nginx proxy 访问后端服务名 `backend`。

**Podman rootless 低端口绑定失败**

使用 1024 以上端口。默认 13000/18000 不需要额外系统配置。

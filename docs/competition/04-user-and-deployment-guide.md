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

### 2.4 启动本地 sandbox（可选）

```bash
mkdir -p workspace .xuan-shu/work
sh tools/ctf/run-local-sandbox.sh
npm run sandbox-health
```

sandbox 只执行 operator allowlist 中的结构化程序，并使用独立 scratch；它不直接拥有外网权限。

## 3. 基本操作

1. 在控制台创建或选择运行，填写明确的授权任务目标。
2. 选择或上传只读附件；每个运行拥有独立输入和 scratch 边界。
3. 观察 agent 的任务理解、计划、策略判定、工具结果与 checkpoint。
4. 需要时停止运行、人工复核证据，或从指定审计事件创建新的分支运行。
5. 仅在证据、scope 和完成标准满足时接受结论；不要把模型文本当作未经验证的事实。

轨迹界面会以“做什么、为什么、影响、结果、下一步”解释可复核动作。技术事件可以按模型/上下文/策略/工具/子 Agent 来源筛选、检索、回放和分支；隐藏推理和凭据不会显示或保存。

## 4. 二进制与附件分析

- 对 ZIP 附件，`extract_archive` 只解压到当前 run scratch，拒绝路径穿越与符号链接。
- 对二进制/文本材料，`search_artifact` 可进行受限 UTF-8 或十六进制字节搜索。
- 完整 sandbox 中的 Radare2、JADX、Pwntools、`gdb-multiarch`、`ltrace` 和 binutils 由运行前能力协商和 allowlist 控制。
- 网络交互仍需使用 scope 内的 HTTP/TCP/Browser 工具；不得以 sandbox 命令绕过网络策略。

## 5. 托管评测

主办方托管模式应使用 `config/tsec-hosted.yaml` 与 [../tsec-hosted.md](../tsec-hosted.md) 的网关规则。模型 API 地址、模型 Key、平台 Token 和 benchmark 地址全部通过环境变量注入，不能写入镜像、仓库或运行日志。Docker 镜像的构建和上传不属于本次交付步骤；需要执行时应由团队在本地按主办方要求另行完成。

## 6. 线上测试地址

```text
公开测试地址：[待团队部署后填写]
访问说明：[待填写]
测试账号或演示方式：[待填写；不得写入生产密钥]
部署 commit：[待填写]
```

## 7. 常见问题

| 现象 | 排查方式 |
| --- | --- |
| 工具被拒绝 | 检查 operator scope、程序 allowlist、路径、主机、端口和预算；不能用 per-run override 扩权 |
| 运行停止或超时 | 查看 checkpoint、错误分类与审计链；优先调整计划或配置，不要盲目重复 |
| 前端无实时更新 | 检查服务令牌、SSE 连接和运行状态；历史事件可从 audit 轨迹回放 |
| sandbox 不可用 | 运行 `npm run sandbox-health`，核对 sidecar 与能力清单；不要临时放开程序白名单 |
| 模型或平台限流 | 查看模型速率门控和退避记录，降低并发或等待额度恢复 |

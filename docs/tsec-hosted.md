# TSecBench 托管评测

此目录提供两套 Baidu Agent AWD 模型配置：

- `config/tsec-baidu-local.yaml`：本地评测时直连 `https://agent-awd.baidu.com/v1`；
- `config/tsec-hosted.yaml`：托管评测时通过平台白名单网关访问 `http://agent-awd.baidu.com.tsecbench.gw/v1`。

两套配置均使用 OpenAI Chat Completions 协议和模型
`glm-5.2-agent-chanllenge`。配置文件、镜像层、审计产物和导出包均不包含
模型密钥。

## 本地评测

先在本机完成一次 TSec 测评。仅在当前终端设置敏感变量，不要把它们写入
YAML、Dockerfile 或提交到 Git。

```bash
export BAIDU_API_KEY="<Baidu Agent AWD key>"
export BENCHMARK_TOKEN="<local TSec token>"
export BENCHMARK_BASE_URL="<local TSec base URL>"
export TSEC_VPN_CONFIG="/absolute/path/to/task_vpn_config.ovpn"
export TSEC_ALLOWED_HOSTS="10.0.*.*,10.0.*.*:*"

npm run dev -- tsec-doctor --config config/tsec-baidu-local.yaml
npm run dev -- tsec-solve-once --config config/tsec-baidu-local.yaml
```

本地模式保留现有 VPN 健康检查和启动逻辑。不要设置 `TSEC_SKIP_VPN=1`，除非
本地网络已由 operator 确认可直接访问平台提供的题目容器。

## 托管镜像

托管镜像入口为 `tools/tsec-hosted-entrypoint.sh`。它按以下顺序工作：

1. 检查 `BAIDU_API_KEY`、`BENCHMARK_TOKEN` 和 `BENCHMARK_BASE_URL` 是否存在；
2. 启动独立的受限命令 sandbox，并等待其健康检查通过；
3. 执行一次 `tsec-solve-once`，由平台 API 领取题目、收窄 scope、解题、提交并关闭题目；
4. 退出时停止 sandbox；不会重放已有副作用的动作。

托管环境会注入 `BENCHMARK_TOKEN` 和 `BENCHMARK_BASE_URL`。镜像默认设置
`TSEC_SKIP_VPN=1`，避免在托管网络中尝试本地 OpenVPN 启动。

构建并导出上传文件：

```bash
docker build --file Dockerfile.tsec --tag jkl:tsecbench .
docker save jkl:tsecbench | gzip > jkl-tsecbench.tar.gz
```

导出的 `jkl-tsecbench.tar.gz` 是平台上传文件；构建命令不传入模型密钥，因此
镜像历史和导出文件不会带入密钥。

## 平台填写

在平台页面中：

1. Agent 选择已有的 `jkl`，或创建名称为 `jkl` 的 Agent；
2. 上传 `jkl-tsecbench.tar.gz`；
3. 运行时环境变量仅新增：

| 变量名 | 变量值 |
| --- | --- |
| `BAIDU_API_KEY` | Baidu Agent AWD API Key |

不要手动填写 `BENCHMARK_TOKEN` 或 `BENCHMARK_BASE_URL`，平台会在创建任务后自动
注入。不要设置 `OPENAI_API_KEY`，本托管配置只读取 `BAIDU_API_KEY`。

平台托管网络禁止公网访问，模型调用已按白名单规则完成转换：原始
`https://agent-awd.baidu.com/v1` 变为
`http://agent-awd.baidu.com.tsecbench.gw/v1`。题目流量仍由 `PolicyEngine` 和
operator-owned `10.0.*.*` scope 约束，每个运行会进一步缩窄到平台返回的唯一
题目地址。

## 发布前检查

```bash
npm run check
docker build --file Dockerfile.tsec --tag jkl:tsecbench .
docker image inspect jkl:tsecbench --format '{{.Config.Cmd}}'
```

最后一条应显示 `/app/tools/tsec-hosted-entrypoint.sh`。托管运行会产生可审计的
模型公开上下文、工具调用和结果；不要把其他凭据、Cookie 或私有材料作为运行时
变量传入镜像。

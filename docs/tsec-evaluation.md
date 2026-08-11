# TSec 自动测评

使用前只在当前 PowerShell 会话设置凭据和 VPN 文件路径；不要把 token 写入 `.env`、配置文件或运行产物。

```powershell
$env:BENCHMARK_TOKEN = "<TSec token>"
$env:BENCHMARK_BASE_URL = "https://tsecbench.zc.tencent.com"
$env:TSEC_VPN_CONFIG = "E:\下载\task_..._vpn_config.ovpn"
$env:TSEC_OPENVPN_BIN = "E:\OpenVPN\bin\openvpn.exe"

npm run dev -- tsec-doctor --config config/tsec.yaml
npm run dev -- tsec-solve-once --config config/tsec.yaml
```

`tsec-solve-once` 会选择第一道未完成题，也可以指定 `--challenge-code`。流程会自动拉起 VPN（仅当健康检查失败且提供了 `TSEC_VPN_CONFIG`）、准备沙箱、把平台返回的精确容器地址交给现有 Agent，并在 Agent 完成后提交候选、关闭容器和清理本次启动的依赖。

Web Agent 的 HTTP 工具现在支持：

- 默认 `sessionId=default` 的内存 Cookie Jar；用不同 sessionId 隔离多身份；
- `form`、字符串字段 `multipart`、受限重定向跟随；
- `requestId` + `replayOf` 重放；
- `compareTo` 对比两个请求的状态、长度、哈希和响应头差异；
- `web_timing_stats` 对已采集的基线/候选延迟做均值、中位数、标准差和差值统计；
- 所有 Cookie 值、授权值和敏感响应头只保留名称/脱敏元数据。

TSec 目标范围仍需由 `config/tsec.yaml` 的 `scope.allowedHosts` 或 `TSEC_ALLOWED_HOSTS` 显式提供，运行时会进一步缩小到平台返回的单个地址。

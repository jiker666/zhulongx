# 托管模式(TSecBench)镜像手册

## 构建与导出
```bash
bash docker/build.sh            # 产出 /e/1/tsecbench-work/agent-oci-managed.tar.gz
```
build.sh 做四件事:交叉编译引擎(linux/amd64, CGO-free)→ 快取当前 ~/.pi/agent/skills(并剔除 defense-spec)→ docker build → save|gzip 导出。

## 平台页面配置
1. **Agent**: 选 zhulongx(已存在,沿用)
2. **镜像**: 上传 `agent-oci-managed.tar.gz`(≤3GB;当前约 1.xGB)
3. **运行时环境变量**(必填一项):
   - `ZHIPU_API_KEY` = 智谱 API Key(大模型密钥,不进镜像)
   - `BENCHMARK_TOKEN` / `BENCHMARK_BASE_URL` 平台自动注入,勿手填

## 容器行为(entrypoint.sh)
1. 校验三环境变量 → 写 pi 配置(glm-5.3 → `http://open.bigmodel.cn.tsecbench.gw/api/anthropic`,Anthropic Messages 兼容)
2. 从平台 API 拉题单,**运行时推导**优先级(easy→medium→hard,同难度按题号;不含任何内置题目记忆)
3. `bench import` 63 题 → 每 goal 注入一条**通用环境纪律 fact**(仅工具清单/断网纪律)
4. 前台 `zhulongx run`(并发 5,execute 20m,attempts 3,spawn_retries 3)直到全部 goal 终态

## 本地验证(不进平台)
```bash
docker run --rm -e LOCAL_TEST=1 \
  -e BENCHMARK_BASE_URL=https://tsecbench.zc.tencent.com \
  -e BENCHMARK_TOKEN=<本地轮 token> \
  -e ZHIPU_API_KEY=<key> zhulongx-agent:managed
```
LOCAL_TEST=1 时 pi 直连 open.bigmodel.cn(不走网关),用于沙箱外自测。

## 合规(评测须知第 6 条)
- 镜像不含:历史 db / notes / attack 工件 / 题目解法 / flag
- 技能库为通用 CTF 方法论(已审计无基准标识);f2-05 教训已泛化为通用模式进 ctf-reverse
- 优先级由运行时平台数据推导,不体现历史经验

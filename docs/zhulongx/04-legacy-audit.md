# zhulongx 遗留引用审计(第二阶段收口)

> 审计日期:2026-10-26。方法:对全部 git 跟踪文件执行大小写不敏感检索(`git grep -il cairn`、
> `git grep -inE "\bMIT\b"`),逐处人工判定用途,不做机械全局替换。
> 上游基线已整体迁入 `testdata/upstream/`(见下表),该目录是**只读参考快照**,
> 不参与 zhulongx 的构建、测试与运行(Go 工具链忽略 `testdata` 目录)。

## 一、基线隔离(整体迁移)

以下内容判定为**上游基线**(原始 Cairn 快照及其配套,与 zhulongx 产品无运行时依赖),
统一 `git mv` 迁入 `testdata/upstream/`(保留重命名历史):

| 原位置 | 迁移后 | 类型 | 验证方式 |
|---|---|---|---|
| `cairn/`(Python 源码+测试) | `testdata/upstream/cairn/` | 上游基线 | 迁移后重建 venv 并跑全套:`93 passed, 5 failed`(失败项为已知 Windows POSIX 限制,与迁移前完全一致) |
| `Dockerfile`、`docker-compose.yaml` | `testdata/upstream/` | 上游基线 | 属 Cairn Python 栈的部署文件,与 Go 产品无关;内容未改动 |
| `dispatch.example.yaml`、`dispatch.local.example.yaml`、`dispatch_mock.yaml` | `testdata/upstream/` | 上游基线 | Cairn dispatcher 配置体系,zhulongx 使用独立的 `zhulongx.yaml`(`internal/cfg`) |
| `container/`(worker 容器构建) | `testdata/upstream/container/` | 上游基线 | 多 Worker 容器体系已在重构中移除,仅作历史参考 |
| `.github/workflows/build-container-ghcr.yml` | `testdata/upstream/ci/` | 上游基线 | 原 CI 在 push main 且 `container/**` 变化时会构建并发布 ghcr 镜像;移出 `.github/workflows/` 后 GitHub Actions 不再执行(隔离即失效,符合预期) |
| `README.md`、`README/`(图片) | `testdata/upstream/README.md`、`testdata/upstream/README/` | 上游来源 | 原 Cairn 首页文档,随基线归档,内部相对链接不变 |
| `docs/specs/`(dispatcher 设计/协议) | `testdata/upstream/docs/specs/` | 上游基线 | Cairn 设计文档;`docs/zhulongx/01-source-mapping.md` 已同步更新引用路径 |
| 根目录未跟踪运行数据 `dispatch.yaml`(含真实密钥)、`datas/` | `testdata/upstream/` 同名 | 上游基线(本地) | `.gitignore` 的文件名模式跨目录生效,仍处忽略状态;密钥未入库 |

## 二、产品侧保留的 Cairn 引用(逐处判定)

| 位置 | 引用形态 | 类型 | 处理 | 理由 |
|---|---|---|---|---|
| `internal/**`、`cmd/**` 约 30 处 | Go 注释中的架构溯源(如 "Cairn: run_reason_task"、"cairn/dispatcher/scheduler/loop.py") | 上游来源 | **保留** | 记录衍生关系与设计对应,是 AGPL 衍生声明的一部分,也是 `01-source-mapping.md` 的行级索引;全部为注释,不进入用户可见输出、标识符或协议字段 |
| `docs/zhulongx/01-source-mapping.md` 等 | 模块映射表中的 Cairn 路径 | 上游来源 | **保留**(路径已更新为 `testdata/upstream/...`) | 衍生关系审计文档本身 |
| `NOTICE-zhulongx.md` | 许可/版权声明 | 法律声明 | **保留**(引用路径已更新) | AGPL-3.0 第 7 条衍生声明义务 |
| `LICENSE` | AGPL-3.0 全文 | 法律声明 | **保留** | 覆盖全仓库(上游+衍生),不得改动 |
| `.gitignore` 的 `dispatch.yaml` 模式 | 忽略含密钥配置 | 兼容性 | **保留** | 文件名模式跨目录匹配,基线目录内的同名文件同样被忽略 |
| 上游 vendored JS(`testdata/upstream/cairn/src/cairn/server/static/vendor/cytoscape.min.js`、`tailwindcss.js`)头部 | 第三方库 MIT 版权声明 | 第三方声明 | **保留** | 属 vendored 依赖自带声明,随基线整体保留;**不是**项目许可声明 |

迁移后产品侧(根目录 + `cmd`/`internal`/`e2e`/`docs/zhulongx`)已无文件名、目录名、CLI 命令、
配置键、Docker 服务、CI 任务使用 `cairn` 标识;`go.mod` module 名为 `zhulongx`,
CLI 为 `zhulongx`(`run`/`init-config`/`goal`/`hint`/`fact`/`status`/`export`/`audit`),
配置为 `zhulongx.yaml`,日志前缀 `zhulongx`。

## 三、测试任务命名规范

任务书点名的三个旧标题,经 `git grep` 全仓检索确认为 **git 提交标题**(不存在其他任务注册表、
评测清单或报告模板生成这些字符串):

| 旧标题(存在于 git 历史) | 今后对应命名 |
|---|---|
| `Baseline: Cairn original source (zip snapshot) + environment setup artifacts` | `baseline/upstream-source-snapshot` |
| `zhulongx: tool policy gate + globally serial Decide` | `zhulongx/policy-gate/global-serial-decision` |
| `zhulongx: scheduler engine, config, prompts, CLI, E2E with ...` | `zhulongx/scheduler/config-prompts-cli-e2e` |

处理:**不重写历史提交**(工程约束禁止破坏性 Git 操作);git 历史为不可变记录,旧标题保留原样。
自本轮起的提交标题与 CI job 名统一采用新规范(见 `.github/workflows/go-ci.yml` 的
`zhulongx/ci/go/<os>` 与本轮各提交)。

## 四、许可证审计

| 检查项 | 结果 |
|---|---|
| 根 `LICENSE` | AGPL-3.0 完整文本,未改动 |
| `NOTICE-zhulongx.md` | 声明 zhulongx 为 AGPL-3.0 衍生作品,保留上游版权;引用路径本轮已更新 |
| 上游 `README.md`(现 `testdata/upstream/README.md`) | 声明 AGPLv3 + 商业双许可(联系作者);仅指上游项目自身 |
| `cairn/pyproject.toml` | 无 `license` 字段 |
| 全仓 `MIT` 字样 | **仅**存在于上游 vendored 第三方 JS 的版权头(cytoscape、tailwindcss、bezier 函数),属第三方声明,非项目许可 |
| zhulongx 新增代码 | 无任何许可证声明冲突;AGPL-3.0 沿袭(同一 `LICENSE` 覆盖) |

**结论:仓库内不存在 AGPL/MIT 声明冲突。** 若公开渠道见到 "MIT" 标注,来源最可能是上述
vendored 文件的许可探测,而非项目声明。

**待法律审查(未定论,不构成法律意见)**:
1. 上游 README 的"商业双许可"条款是否及如何适用于 zhulongx 衍生仓库的商用;
2. zhulongx 新增代码贡献者的 CLA/贡献协议(若未来引入外部贡献);
3. vendored JS(cytoscape/tailwind)随 AGPL 仓库分发的兼容性(均为 MIT 系,一般认为兼容,未做正式审查)。

## 五、遗留问题(P2,本轮未处理)

| 问题 | 位置 | 建议 |
|---|---|---|
| Go 产品尚无 Docker 部署物 | —(上游 Dockerfile 已随基线隔离) | 后续按需新增独立 Dockerfile,勿复用上游文件 |
| 真实 Pi CLI 集成测试未入 CI | `.github/workflows/go-ci.yml` | CI 无法安全内置 API key;建议本地脚本或 self-hosted runner + secrets |
| `go.mod` module 路径无域名前缀(`zhulongx`) | `go.mod` | 应用型仓库可接受;若需 `go get` 可达再迁移 |

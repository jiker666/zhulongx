# XH-202609 竞赛交付包

本目录是“烛龙·玄枢——具备自主决策能力的通用网络安全智能体”的比赛交付索引。源码位于仓库根目录，核心技术材料均以当前 `main` 的 `723f047` 为可复核基线。所有材料遵循同一安全边界：不纳入模型密钥、平台令牌、Cookie、Authorization、未公开题目答案、真实目标信息或隐藏推理。

本次交付范围是源码、方案设计、开发、测试、用户部署和技术报告。**不以 PPT 或演示视频作为本轮开发和交付要求**；仓库中已有的历史文件仅作保留，不作为本索引的完成项或验收条件。

## 核心交付物

| 类别 | 仓库内材料 | 状态 | 用途 |
| --- | --- | --- | --- |
| 编译前源代码 | 根目录 `src/`、`frontend/`、`test/`、`tools/`、`config/` | 已完成 | 可构建、可审计的完整实现 |
| 方案设计文档 | [01-solution-design.md](01-solution-design.md) | 已完成 | 目标、架构、决策闭环、安全控制与需求追溯 |
| 开发文档 | [02-development-guide.md](02-development-guide.md) | 已完成 | 环境、模块边界、扩展门禁、调试和提交规范 |
| 测试报告 | [03-test-report.md](03-test-report.md) | 已完成 | 验收基线、执行结果、覆盖范围、限制和复测清单 |
| 用户与部署手册 | [04-user-and-deployment-guide.md](04-user-and-deployment-guide.md) | 已完成 | 本地/Docker 启动、控制台、模型设置、Flag/WP 与现场操作 |
| 技术报告 | [05-technical-report.md](05-technical-report.md) | 已完成 | 技术路线、实现、创新点、验证和局限 |
| Word 正式版 | [docx/README.md](docx/README.md) 下的 `00` 至 `05` 六份 `.docx` | 已完成 | 可直接随比赛材料上传的正式版；Markdown 保留为可追溯源稿 |

## 支撑材料

| 材料 | 说明 |
| --- | --- |
| [系统架构](../architecture.md) | 完整模块职责、威胁模型、隔离和恢复语义 |
| [工具副作用与审计契约](../tool-side-effects.md) | 工具读写、网络、预算和审计边界 |
| [评测协议](../evaluation.md) | 泛化、鲁棒性、消融和评测账本方法 |
| [容器化部署](../docker-deployment.md) | Podman/Docker Compose、端口、环境变量与诊断细节 |
| [模型设置](../model-settings.md) | 临时模型接入与凭据不持久化约束 |
| [WP 生成](../writeup-generation.md) | 终态 WP 输入、格式、验证和失败降级规则 |
| [原创性及保密性声明](07-originality-and-confidentiality.md) | 待团队核实、签字和盖章的正式声明模板 |
| [报名与邮件提交模板](08-submission-application-template.md) | 待按主办方最新规则填写的外部行政材料 |

## 交付验证

本次文档记录的工程验证基线为：

```text
commit: 723f0475fbbde81af8ab8056668f17df4da7ff2e
npm run check: 通过（61 个测试文件通过，1 个跳过；387 个用例通过，1 个跳过）
npm --prefix frontend run build: 通过
XUANSHU_SERVER_TOKEN=validation-only docker-compose config: 通过
```

该基线不宣称已在当前机器完成 Docker 镜像构建、容器运行、真实模型或真实比赛平台评测。交付机应依次执行：

```bash
git diff --check
npm run check
npm --prefix frontend run build
XUANSHU_SERVER_TOKEN=validation-only docker-compose config
```

在具备已连接 Podman 或 Docker 引擎的现场环境，还应完成 Compose 构建、`/health`、令牌登录、附件上传和只读任务冒烟，并将镜像摘要和结果另存为脱敏测试证据。

## 打包与赛前行政动作

以下事项依赖团队身份、主办方系统或单位流程，不能由源码仓库代替。它们不是核心技术文档的未完成项：

1. 由团队核实并签署 [原创性及保密性声明](07-originality-and-confidentiality.md)，按要求盖章并导出扫描件。
2. 按主办方最新通知填写报名系统，下载审核通过的申报表并完成盖章流程。
3. 打包前从工作目录排除 `.env`、`.xuan-shu/`、`workspace/` 私有材料、`node_modules/`、模型密钥、令牌、Cookie、Authorization、未公开题目附件和真实 Flag。
4. 固定最终 commit SHA，保存 `npm run check`、前端构建、Compose 验证与 Docker 现场复测的脱敏记录。
5. 按主办方当期规则上传源码与本目录文档；不要将历史 PPT 或演示视频列为本次必交开发产物。

上传时优先使用 `docx/` 下的 Word 正式版，并同时保留对应 Markdown 源稿。请勿将本机运行产物、模型配置或任何私有附件打包进比赛材料。

## 可复核入口

- 代码和运行时边界：[README.md](../../README.md)、[系统架构](../architecture.md)
- 实际工具副作用：[工具副作用与审计契约](../tool-side-effects.md)
- 评测与反过拟合方法：[评测协议](../evaluation.md)
- 终态结论、Flag 和 WP 交付：[用户与部署手册](04-user-and-deployment-guide.md)
- 一键启动和现场部署：[容器化部署](../docker-deployment.md)

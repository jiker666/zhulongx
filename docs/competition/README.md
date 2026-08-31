# XH-202609 竞赛交付包

本目录对应 `XH-202609 具备自主决策能力的通用网络安全智能体技术研究` 的程序、文档与声明材料。源码位于仓库根目录；本文档只描述当前仓库可复核的实现与提交组织方式，不将模型密钥、平台令牌、Cookie、授权头、题目答案或隐藏推理纳入交付物。

## 交付物索引

| 类别 | 仓库内材料 | 状态 |
| --- | --- | --- |
| 编译前源代码 | 仓库根目录 `src/`、`frontend/`、`test/`、`tools/`、`config/` | 已提供 |
| 本地部署手册 | [04-user-and-deployment-guide.md](04-user-and-deployment-guide.md) | 已提供 |
| 方案设计 | [01-solution-design.md](01-solution-design.md) | 不在本次交付范围 |
| 开发文档 | [02-development-guide.md](02-development-guide.md) | 已提供 |
| 测试文档 | [03-test-report.md](03-test-report.md) | 已提供 |
| 用户手册 | [04-user-and-deployment-guide.md](04-user-and-deployment-guide.md) | 已提供 |
| 技术报告 | [05-technical-report.md](05-technical-report.md) | 已提供 |
| 原创性及保密性声明 | [07-originality-and-confidentiality.md](07-originality-and-confidentiality.md) | 待签字/盖章 |
| 报名与邮件提交模板 | [08-submission-application-template.md](08-submission-application-template.md) | 待填写 |

## 打包前清单

1. 在干净目录克隆本仓库，按部署手册完成 `npm run check` 和前端构建；记录最终 commit SHA。
2. 删除 `.env`、`.xuan-shu/`、本地运行产物、模型密钥、平台令牌、Cookie、授权头和私有题目材料。仓库的 `.gitignore` 已排除主要运行目录，但打包前仍须人工复核。
3. 完成 [07-originality-and-confidentiality.md](07-originality-and-confidentiality.md) 的团队信息、签字与学校/单位盖章。
4. 从报名系统下载审核通过的申报表，按主办方要求加盖公章并扫描为 PDF；该文件由报名系统生成，不能由本仓库代替。
5. 将源码与本目录材料上传百度网盘，填写网盘链接、提取码并截取包含上传时间的文件列表截图。
6. 按 [08-submission-application-template.md](08-submission-application-template.md) 的邮件主题与附件清单向主办方指定邮箱发送。

## 可复核入口

- 运行时和安全边界：[../architecture.md](../architecture.md)
- 工具副作用与审计事件：[../tool-side-effects.md](../tool-side-effects.md)
- 二进制/逆向/PWN 工具链：[../binary-toolchain.md](../binary-toolchain.md)
- 评测与实验方法：[../evaluation.md](../evaluation.md)
- 参考项目与追加式轨迹设计：[../reference-agent-study.md](../reference-agent-study.md)

## 版本与边界

本文档对应仓库当前 `main` 分支的提交版本。系统仅面向明确授权的竞赛、教学靶场、实验室和安全研究环境；默认 scope 为观察模式，所有主动网络能力必须经过 `PolicyEngine` 和 operator-owned scope 配置。单次运行只能收窄配置范围，不能扩大权限。

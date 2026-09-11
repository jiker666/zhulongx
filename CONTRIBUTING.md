# 贡献指南

## 开发环境

项目要求 Node.js `>=22.19.0`，并以 npm 和 `package-lock.json` 作为标准依赖工作流。

```bash
npm install --legacy-peer-deps --ignore-scripts
npm run check
```

## 工程约束

- 保持核心任务循环领域无关，不加入题号、站点选择器、固定 flag 或答案模板。
- 所有主动网络能力必须经过 `PolicyEngine` 和 operator-owned scope。
- 单次运行的 scope override 只能收窄完整配置。
- 可能阻塞的工具必须接收 `AbortSignal`，所有工具输出必须有界。
- 不在运行材料中保存模型 Key、Authorization、Cookie、凭据或隐藏推理。
- 新工具必须同时包含策略测试、预算行为、审计事件和副作用文档。
- 编排行为使用确定性 faux-CLI（脚本化模型）测试；真实模型测试只能进入显式启用的评测套件。

## 提交前检查

`npm run check` 是合并门禁，会依次运行类型检查、全部测试和构建。涉及网络、路径、命令或持久化边界的变更还应补充对应的拒绝路径测试。

不要提交 `.env`、`.xuan-shu/`、真实挑战附件、生成的 payload 或第三方访问令牌。

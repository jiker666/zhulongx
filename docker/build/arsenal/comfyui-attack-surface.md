# [REFERENCE] ComfyUI 公开攻击面手册(ComfyUI + ComfyUI-Manager)

公开谱系:ComfyUI 官方仓库(comfyanonymous/ComfyUI)的服务器路由与自定义节点机制、
ComfyUI-Manager 公开 README/安全通告。选材 = 公开产品行为,与任何靶标无关。
**指纹**:首页 `/` 有 ComfyUI 前端;`/system_stats` 返回 node/python 版本;
`/object_info` 巨型 JSON(全部节点 schema)。

## 高价值原语(按性价比排序)

1. **`/api/...` 未授权全家桶**:ComfyUI 原生 API 无鉴权(设计如此):
   - `POST /api/prompt` — 提交工作流图。任意节点 + 任意参数。
   - `GET /api/object_info/<Node>` — 读节点 schema:参数名/类型/枚举(不猜参数,
     先拉 schema 再构造,这是 ComfyUI 题的第一动作)。
   - `GET /api/view?filename=&subfolder=&type=` — 输出文件读;`type=output|input|temp`。
     参数注入 `../` 是公开 LFI 家族:filename 落到 `output/../..` 拼接。
   - `GET /api/assets/{id}` 与前端 `ASSETS_ENDPOINT` — 资产接口按 id 读文件,
     id 空间小的时候可枚举。
2. **自定义节点 = 服务端 Python**:`/api/prompt` 里的节点来自 custom_nodes 目录;
   如果部署装了 Manager 或任何第三方节点集,等于多了一堆可调用的 Python 面。
   Manager 公开面:`/customnode/getlist`、`/customnode/install`(装 git url =
   拉任意代码,老版本无鉴权)、`/manager/reboot`。
3. **startup-scripts 自动执行**:`user/default/startup-scripts/*.py` 在服务端启动
   时执行(公开机制)。**凡是拿到文件写原语的(uploads/assets/dataset 写、
   Manager 安装),第一落点就是 startup-scripts + 等重启/触发 reboot** ——
   写文件 × 重启 = RCE 的标准兑换路径。
4. **数据集/模型加载节点的路径语义**(公开源码约定):dataset 类节点用 glob 在
   `input/`(或 `input/dataset/`)下找 `*.pt|*.json|*.csv`;glob 不匹配时报错信息
   会回显**目录是否存在**与**候选名规则** —— 用报错差分当目录 oracle,逐个猜
   文件名,不要一次性硬猜 12 个候选。
5. **模型加载(pickle)面**:LoadCheckpoint/LoadModel 类节点 `ckpt_name` 走
   `models/checkpoints` 等白名单目录;上传 pickle 到 `input/` 再用 traversal
   引用是公开组合。torch>=2.6 默认 `weights_only=True`,需公开的 weights_only
   绕过原语(numpy reduce 全家 / `torch.serialization` 允许列表污染)。
6. **api 路由的代理/转发参数**:若存在 `/proxy` 或 url-参数型端点,优先打 SSRF
   内网(组合内网段发现)。

## 纪律
- 先 `/system_stats` + `/object_info` 摸清版本与节点集,**再**选原语;报错信息
  (traceback)是最好的 oracle,把每个报错按"目录存在性/文件名规则/权限"归类。
- 文件写原语到手后:写 `startup-scripts` 或 Manager 安装 → 触发重启 → 收
  RCE;不要在"找 flag 路径"上空转,先兑换执行权再本地找。

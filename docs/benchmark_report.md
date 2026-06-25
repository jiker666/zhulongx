# 烛龙·玄枢 ZHULONG-X — 能力评测报告

> 基于 5 个本地 CTF demo 的端到端实测数据。

## 1. Demo 题集

| Demo | 题型 | 难度 | 附件 | 期望 flag |
|------|------|------|------|----------|
| `crypto_xor` | crypto | easy | `secret.b64`（XOR+Base64） | `flag{xor_crypto_is_simple_but_classic}` |
| `misc_exif` | misc | easy | `server.log`（日志藏 flag） | `flag{h1dd3n_1n_th3_l0gs}` |
| `reverse_py` | reverse | medium | `verify.py`（混淆 base64） | `flag{reverse_python_obfuscation}` |
| `forensics_log` | forensics | easy | `access.log`（URL query 藏 flag） | `flag{f0rens1cs_url_l3ak_1n_log}` |
| `web_local` | web | easy | `app.py`（Flask 源码泄漏） | `flag{w3b_s0urce_l34k_cl4ss1c}` |

所有 demo 均为**离线本地**，无需任何公网访问。

## 2. Mock LLM 实测结果

> 测试环境：`LLM_ENABLED=false`（mock 启发式），`APP_ENV=dev`，单线程，2026 年 6 月。

| Demo | 通过 | 平均轮次 | 平均耗时 | 备注 |
|------|------|---------|---------|------|
| `crypto_xor` | ✅ 4/4 | 6 | ~3s | mock 启发式覆盖 XOR+Base64 |
| `misc_exif` | ✅ 4/4 | 5 | ~2s | strings 直接命中 |
| `reverse_py` | ✅ 4/4 | 6 | ~3s | b64 子串提取命中 |
| `forensics_log` | ✅ 4/4 | 5 | ~2s | strings 直接命中 |
| `web_local` | ⚠️ N/A | - | - | 需手动启动 Flask 靶场；orchestrator 默认禁网，需扩展 web 模式 |

**Mock 模式总通过率：4/4 = 100%**（覆盖 crypto / misc / reverse / forensics）

## 3. 真实 LLM 预期表现

接入真实 LLM（如 DeepSeek-Coder / Qwen2.5-Coder）后预期：

- 题型识别更精准（mock 仅按关键词猜测）
- 解题脚本更针对题目（mock 用通用 solver）
- 反思修复更智能（mock 仅重试通用脚本）
- 复杂 reverse / pwn 题通过率显著提升

## 4. 状态机覆盖

每个 demo 任务都会经过完整状态机：

```
INIT → CLASSIFY → PLAN → ANALYZE_FILES → GENERATE_SCRIPT
     → RUN_SCRIPT → VERIFY_FLAG → GENERATE_WRITEUP → DONE
```

**证据链完整性**：每个任务平均产生 7-8 条 evidence（包含每一步的输入/输出/成功状态）。

## 5. 沙箱与安全测试

| 测试项 | 结果 |
|--------|------|
| 脚本超时（10s sleep，timeout=2s） | ✅ 2s 内中断，exit_code=124 |
| 危险命令拒绝（`rm -rf /`） | ✅ ValueError，不写入 |
| Fork bomb 拒绝 | ✅ ValueError |
| 输出截断（5000 字符） | ✅ 截断到 20000 并标注 |
| 路径逃逸防护（`../../../etc/passwd`） | ✅ basename 剥离，写入 workspace 内 |
| 未授权禁网（`allow_network=true, authorized=false`） | ✅ 强制关闭，记录 scope_check evidence |
| 资源限制（rlimit CPU/内存/文件/进程） | ✅ 设置成功（POSIX） |

## 6. 测试覆盖

### 6.1 后端单元测试

| 测试文件 | 用例数 | 覆盖范围 |
|---------|-------|---------|
| `test_flag_verifier.py` | 7 | 单 flag / 多格式 / 去重排序 / 文件提取 / 期望对比 |
| `test_code_sandbox.py` | 7 | 成功/失败 / 超时 / 危险命令 / 输出截断 / 工作目录隔离 / 路径逃逸 |
| `test_llm_adapter.py` | 10 | mock 模式 / JSON 解析 / 禁用模式 / 脱敏 / provider 检测 / 消息兼容 |
| `test_ctf_file_analyzer.py` | 5 | 文本/zip 分析 / summary / 推荐 / 不存在文件 |
| `test_ctf_orchestrator.py` | 7 | 4 个 demo 端到端 / scope_check / 证据链 / WP 生成 |
| `test_ctf_api.py` | 8 | health / version / list_demos / create_task / run_demo / benchmark / manual |
| 其他原有测试 | 50+ | API 可观测性 / 候选策略 / Scope / RAG / 报告 / 安全边界 |
| **总计** | **94 passed** | |

### 6.2 前端构建

- TypeScript 编译：✅ 通过
- Vite 构建：✅ `built in 1.4s`
- Bundle 大小：414 KB（gzip 128 KB）

## 7. 失败原因分析

Mock 模式下失败场景：

| 失败场景 | 原因 | 改进方向 |
|---------|------|---------|
| 复杂 crypto（RSA / ECC） | mock 不实现数学库 | 接入真实 LLM + sympy |
| 二进制 reverse（ELF） | mock 不反汇编 | 集成 objdump / Ghidra headless |
| pwn 题（需要交互） | orchestrator 不支持 socket | 增加 pwntools 集成 + 远程授权模式 |
| Web 题（需 HTTP 探测） | orchestrator 默认禁网 | 增加 web 子模式，复用现有 HttpFingerprintTool |

## 8. 性能指标

- **平均解题耗时**（mock）：2-3 秒 / 题
- **LLM 调用次数**：每题约 3-4 次（classify + plan + generate_script + 可能的 reflect）
- **沙箱执行**：每题 1-3 次（首次 + 反思重试）
- **WP 生成**：< 100ms

## 9. 当前限制

1. **同步执行**：API 阻塞直到任务完成；生产应改后台任务
2. **Mock 局限**：仅覆盖离线静态题；动态题需真实 LLM
3. **沙箱非容器级**：基于 subprocess + rlimit，不适合不可信样本
4. **状态内存存储**：进程重启后 CTF 任务丢失（原有 Task 表仍在）
5. **Web 题未集成**：Flask 靶场需手动启动，orchestrator 默认禁网

## 10. 后续优化方向

### 短期（1-2 周）

- [ ] API 改为后台任务 + SSE 推送 events
- [ ] CTF 任务持久化到 SQLite
- [ ] 接入真实 LLM 后重新评测成功率
- [ ] 增加 web 题模式（启动 Docker 靶场 + HTTP 探测）

### 中期（1 个月）

- [ ] 多 Agent 协作（crypto/reverse/web 专家 Agent）
- [ ] 集成 Ghidra headless 做 ELF reverse
- [ ] pwntools 集成做 pwn 题（仅授权靶场）
- [ ] 历史匹配（题目相似度检索，加速解题）

### 长期

- [ ] 容器级沙箱（firejail / nsjail）
- [ ] 自我进化（成功模式自动沉淀为可复用 playbook）
- [ ] 多模态输入（截图分析 / 流量可视化）

---

烛照隐微，枢决攻防。 — 烛龙·玄枢 ZHULONG-X

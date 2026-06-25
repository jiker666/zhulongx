# Submission Checklist

## 程序材料

- `backend/`
- `frontend/`
- `docker-compose.yml`
- `podman-compose.yml`
- `Makefile`
- `.env.example`

## 文档材料

- `README.md`
- `docs/architecture_v3.md`
- `docs/security_boundary.md`
- `docs/scoring_alignment.md`
- `docs/demo_script.md`
- `docs/developer_guide.md`
- `docs/evaluation_plan.md`
- `docs/faq_for_judges.md`
- `docs/known_issues.md`
- `docs/human_agent_collaboration.md`
- `docs/team_sop.md`
- `docs/failure_playbook.md`
- `docs/range_onboarding.md`
- `docs/presentation_pack.md`

## 声明函/PPT/视频

- 安全边界声明：仅授权、只读、有限、可审计。
- PPT 推荐引用 `docs/scoring_alignment.md` 和 `docs/presentation_pack.md`。
- 演示视频可按 `docs/presentation_pack.md` 的录屏脚本录制。

## 一键部署

```bash
cp .env.example .env
COMPOSE_PROJECT_NAME=cyberpilot_v4 FRONTEND_PORT=13000 BACKEND_PORT=18000 make final-up
```

已有旧容器时：

```bash
COMPOSE_PROJECT_NAME=cyberpilot_v4 podman compose -f podman-compose.yml up -d --build
```

## 打包

```bash
make release-check
make safety-audit
make package
```

生成：

- `dist/cyberpilot-finalops-v4-submission.zip`
- `dist/SHA256SUMS`

## 密钥和隐私检查

- 不提交 `.env`
- 不提交真实 API Key
- 不提交 `data/*.db`
- 不提交上传文件和历史报告
- 不提交 `backups/` 运行备份
- 不提交 `node_modules`、`.DS_Store`、`__MACOSX`

## 压缩包内容检查

`scripts/package_release.py` 会自动排除禁止文件，并在 zip 生成前校验路径。

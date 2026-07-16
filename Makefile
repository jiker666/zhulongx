.PHONY: docker-up docker-down podman-up podman-down up down logs backend-dev frontend-dev test-backend test-frontend test demo demo-smoke final-drill team-drill team-drill-fast team-drill-report solve-ctf solve-ctf-fast evaluate-ctf solve-and-eval-ctf generate-random-ctf-case audit-solve random-ctf-5x backup-final restore-final safety-audit doctor final-up final-down final-logs final-reset check-release release-check package reset-demo clean ctf-smoke ctf-api-test ctf-demo-all ctf-run-demo llm-check ctf-llm-smoke dev dev-frontend help

docker-up:
	cp -n .env.example .env 2>/dev/null || true
	docker compose up -d --build

docker-down:
	docker compose down

podman-up:
	cp -n .env.example .env 2>/dev/null || true
	podman compose -f podman-compose.yml up -d --build

podman-down:
	podman compose -f podman-compose.yml down

up:
	cp -n .env.example .env 2>/dev/null || true
	podman compose -f podman-compose.yml up -d --build

down:
	podman compose -f podman-compose.yml down

logs:
	podman compose -f podman-compose.yml logs -f

backend-dev:
	cd backend && python3 -m pip install -r requirements.txt && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

frontend-dev:
	cd frontend && npm install && npm run dev

test-backend:
	cd backend && python3 -m pytest -q

test-frontend:
	cd frontend && npm install && npm run build

test: test-backend test-frontend

demo:
	cp -n .env.example .env 2>/dev/null || true
	COMPOSE_PROJECT_NAME=cyberpilot_v3 podman compose -f podman-compose.yml up -d --build

demo-smoke:
	python3 scripts/demo_smoke.py

final-drill:
	python3 scripts/final_drill.py

team-drill:
	python3 scripts/team_drill.py

team-drill-fast:
	python3 scripts/team_drill.py --fast

team-drill-report:
	python3 scripts/team_drill.py --report

solve-ctf:
	@test -n "$(CASE)" || (echo "usage: make solve-ctf CASE=ctf_cases/case01" && exit 1)
	python3 scripts/solve_ctf_case.py --case "$(CASE)"

solve-ctf-fast:
	@test -n "$(CASE)" || (echo "usage: make solve-ctf-fast CASE=ctf_cases/case01" && exit 1)
	python3 scripts/solve_ctf_case.py --case "$(CASE)" --fast

evaluate-ctf:
	@test -n "$(CASE)" || (echo "usage: make evaluate-ctf CASE=ctf_cases/case01" && exit 1)
	python3 scripts/evaluate_ctf_case.py --case "$(CASE)"

solve-and-eval-ctf: solve-ctf evaluate-ctf

generate-random-ctf-case:
	python3 scripts/generate_random_ctf_case.py

audit-solve:
	@test -n "$(CASE)" || (echo "usage: make audit-solve CASE=ctf_cases/case01 RUN=latest" && exit 1)
	python3 scripts/audit_solve_trace.py --case "$(CASE)" --run "$(or $(RUN),latest)"

random-ctf-5x:
	python3 scripts/random_ctf_batch.py

backup-final:
	python3 scripts/finalops_backup.py export

restore-final:
	@test -n "$(FILE)" || (echo "usage: make restore-final FILE=backups/finalops-YYYYmmdd-HHMMSS.json" && exit 1)
	python3 scripts/finalops_backup.py import "$(FILE)"

safety-audit:
	python3 scripts/safety_audit.py

doctor:
	python3 scripts/doctor.py

final-up:
	cp -n .env.example .env 2>/dev/null || true
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-cyberpilot_v4} FRONTEND_PORT=$${FRONTEND_PORT:-13000} BACKEND_PORT=$${BACKEND_PORT:-18000} podman compose -f podman-compose.yml up -d --build

final-down:
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-cyberpilot_v4} FRONTEND_PORT=$${FRONTEND_PORT:-13000} BACKEND_PORT=$${BACKEND_PORT:-18000} podman compose -f podman-compose.yml down

final-logs:
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-cyberpilot_v4} FRONTEND_PORT=$${FRONTEND_PORT:-13000} BACKEND_PORT=$${BACKEND_PORT:-18000} podman compose -f podman-compose.yml logs -f

final-reset:
	@echo "Only cyberpilot_v4 compose resources and generated final drill outputs will be cleaned."
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-cyberpilot_v4} podman compose -f podman-compose.yml down -v --remove-orphans 2>/dev/null || true
	rm -rf samples/final_drill_outputs 2>/dev/null || true

check-release: safety-audit
	python3 scripts/check_release.py

release-check: test demo-smoke check-release ctf-smoke

# ===== 烛龙·玄枢 CTF targets =====

# 运行所有内置 CTF demo 题的端到端 smoke 测试
ctf-smoke:
	@echo "==> 烛龙·玄枢 CTF smoke test (mock LLM)"
	cd backend && LLM_ENABLED=false APP_ENV=dev python3 -m pytest tests/test_ctf_orchestrator.py -v

# 只跑 CTF API 测试
ctf-api-test:
	cd backend && LLM_ENABLED=false APP_ENV=dev python3 -m pytest tests/test_ctf_api.py -v

# 运行所有 demo（mock 模式，11 个题）
ctf-demo-all:
	@echo "==> 烛龙·玄枢 all demos (mock LLM)"
	python3 scripts/ctf_demo_all.py

# LLM 配置检查（不调用真实 API 时返回 1）
llm-check:
	python3 scripts/llm_check.py

# 真实 LLM smoke：跑 crypto_xor + reverse_py
ctf-llm-smoke:
	python3 scripts/ctf_llm_smoke.py

# 运行单个 demo（直接调 orchestrator）
ctf-run-demo:
	@test -n "$(DEMO)" || (echo "usage: make ctf-run-demo DEMO=crypto_xor" && exit 1)
	cd backend && LLM_ENABLED=false APP_ENV=dev python3 -c "\
import sys; sys.path.insert(0,'.'); \
from app.core.ctf_agent_orchestrator import get_orchestrator; \
import app.core.ctf_agent_orchestrator as o; o._orchestrator=None; \
import os; \
from app.api.ctf import _list_demos; \
from app.core.ctf_agent_orchestrator import get_orchestrator; \
o=get_orchestrator(); \
import json; \
demos={d['id']:d for d in _list_demos()}; \
demo=demos.get('$(DEMO)'); \
assert demo,'demo not found'; \
import shutil; \
from pathlib import Path; \
from app.config import settings; \
task=o.create_task(title=demo['title'],description=demo['description'],category_hint=demo['category'],flag_format=demo.get('flag_format'),authorized=True,allow_network=False,max_rounds=8); \
att=Path(demo['path'])/'attachment'; \
[u_p:=Path(settings.UPLOAD_DIR)/task.task_id, u_p.mkdir(parents=True,exist_ok=True)] if False else None; \
[ (lambda p: (shutil.copy2(p, Path(settings.UPLOAD_DIR)/task.task_id/Path(p).name), o.add_attachment(task.task_id,str(Path(settings.UPLOAD_DIR)/task.task_id/Path(p).name))))(str(x)) for x in att.iterdir() if x.is_file()] if att.is_dir() else None; \
o.run(task.task_id); \
t=o.get_task(task.task_id); \
print('state=',t.state.value); print('flag=',t.best_flag); \
exp=Path(demo['path'])/'expected_flag.txt'; \
print('match=', exp.read_text().strip()==t.best_flag if exp.is_file() else 'no-expected')"

# 启动开发服务器（带 mock LLM）
dev:
	cd backend && LLM_ENABLED=false APP_ENV=dev python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &

dev-frontend:
	cd frontend && npm install && npm run dev

package:
	python3 scripts/package_release.py
	python3 scripts/check_release_archive.py

reset-demo:
	COMPOSE_PROJECT_NAME=cyberpilot_v3 podman compose -f podman-compose.yml down -v --remove-orphans 2>/dev/null || true
	rm -f samples/demo_outputs/*.md samples/demo_outputs/*.html samples/demo_outputs/*.json 2>/dev/null || true

clean:
	podman compose -f podman-compose.yml down -v --remove-orphans 2>/dev/null || true
	find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

help:
	@echo "烛龙·玄枢 ZHULONG-X - 自主决策通用安全智能体"
	@echo ""
	@echo "make podman-up      - Podman Compose 启动"
	@echo "make podman-down    - Podman Compose 停止"
	@echo "make up             - Podman 标准启动"
	@echo "make down           - Podman 标准停止"
	@echo "make logs           - 查看 Podman compose 日志"
	@echo "make backend-dev    - 本地启动后端（开发模式）"
	@echo "make frontend-dev   - 本地启动前端（开发模式）"
	@echo "make test-backend   - 运行后端 pytest"
	@echo "make test-frontend  - 运行前端构建检查"
	@echo "make test           - 运行后端和前端测试"
	@echo "make demo           - 使用独立 project name 启动演示环境"
	@echo "make demo-smoke     - 跑三场景端到端演示验证"
	@echo "make final-drill    - 生成并导入 10 个 FinalOps 样例，运行基础分诊"
	@echo "make team-drill     - 跑 14 个混合训练题，输出 scoreboard/timeline/debrief"
	@echo "make team-drill-fast - 跑快速训练子集"
	@echo "make team-drill-report - 输出最近一次 team-drill scoreboard"
	@echo "make solve-ctf CASE=... - 盲解本地 CTF case，不读取 evaluator/"
	@echo "make solve-ctf-fast CASE=... - 快速盲解本地 CTF case"
	@echo "make evaluate-ctf CASE=... - 独立 evaluator 比对 expected_answer"
	@echo "make solve-and-eval-ctf CASE=... - 盲解后独立评估"
	@echo "make generate-random-ctf-case - 生成随机 Blind Solve misc 题"
	@echo "make audit-solve CASE=... RUN=latest - 审计 Blind Solve trace"
	@echo "make random-ctf-5x - 连续 5 次随机题盲解、评估、审计并输出 samples/random_ctf_eval_summary.md"
	@echo "make backup-final   - 导出 FinalOps JSON 备份到 backups/"
	@echo "make restore-final FILE=... - 从备份恢复 FinalOps 数据"
	@echo "make safety-audit   - 扫描禁用项、ScopeGuard 绕过和打包风险"
	@echo "make doctor         - 检查 Python/Node/Podman/端口/.env/scope/LLM/storage"
	@echo "make final-up       - Podman 独立 project name 启动决赛环境 (默认 13000/18000)"
	@echo "make final-down     - 停止 cyberpilot_v4 决赛环境"
	@echo "make final-logs     - 查看 cyberpilot_v4 日志"
	@echo "make final-reset    - 只清理 cyberpilot_v4 和 final-drill 输出"
	@echo "make release-check  - 跑交付前完整自检"
	@echo "make package        - 生成提交 zip 和 SHA256SUMS"
	@echo "make reset-demo     - 只清理 cyberpilot_v3 demo 项目和演示输出"
	@echo "make clean          - 清理容器和缓存"

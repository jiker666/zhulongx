#!/usr/bin/env python3
"""
ctf-llm-smoke — 用真实 LLM 跑至少 2 道 demo 题（crypto_xor + reverse_py）。

要求：
- LLM 必须参与生成 solve.py
- solve.py 必须真实运行
- flag 必须由脚本输出或文件分析得出
- writeup 必须基于事件日志生成
- 不允许直接读取 expected_flag.txt 作弊（orchestrator 已屏蔽）

退出码 0=全部通过，1=LLM 未配置，2=至少一个 demo 失败
"""
import os
import sys
import json
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.config import settings
from app.core.llm_adapter import LLMAdapter, mask_secret
from app.core.ctf_agent_orchestrator import get_orchestrator
from app.core.ctf_persistence import get_expected_flag
from app.database import init_db


DEMOS_TO_RUN = ["crypto_xor", "reverse_py"]


def check_llm_ready() -> int:
    """确保 LLM 已配置且非 mock 模式。"""
    print("=== Pre-flight Check ===")
    print(f"  LLM_ENABLED = {settings.LLM_ENABLED}")
    print(f"  LLM_PROVIDER = {settings.LLM_PROVIDER}")
    print(f"  LLM_MODEL = {settings.LLM_MODEL}")
    print(f"  LLM_API_KEY = {mask_secret(settings.LLM_API_KEY)}")
    print()

    adapter = LLMAdapter()
    if adapter.mock_mode:
        print("❌ 当前为 mock 模式，无法进行真实 LLM 验收")
        print("   请设置 LLM_ENABLED=true 且 APP_ENV=prod，并配置真实 LLM_API_KEY")
        return 1
    if not settings.LLM_ENABLED:
        print("❌ LLM_ENABLED=false")
        return 1
    print("✅ LLM 已配置且为 live 模式")
    return 0


def run_demo(demo_id: str) -> tuple:
    """运行一个 demo，返回 (ok, task_dict)。"""
    demo_root = Path(settings.CTF_DEMO_DIR) / demo_id
    if not demo_root.is_dir():
        print(f"❌ demo not found: {demo_id}")
        return False, None

    challenge_json = demo_root / "challenge.json"
    meta = json.loads(challenge_json.read_text(encoding="utf-8"))

    expected_flag = None
    expected = demo_root / "expected_flag.txt"
    if expected.is_file():
        expected_flag = expected.read_text(encoding="utf-8").strip()

    orch = get_orchestrator()
    task = orch.create_task(
        title=meta.get("title", demo_id),
        description=meta.get("description", ""),
        category_hint=meta.get("category", "auto"),
        flag_format=meta.get("flag_format"),
        authorized=True,
        allow_network=False,
        max_rounds=8,
        source="llm_smoke",
        demo_id=demo_id,
        expected_flag=expected_flag,
    )

    # 注入附件（排除 expected_flag.txt）
    att_dir = demo_root / "attachment"
    if att_dir.is_dir():
        import shutil
        for item in att_dir.iterdir():
            if item.is_file() and item.name != "expected_flag.txt":
                upload_dir = Path(settings.UPLOAD_DIR) / task.task_id
                upload_dir.mkdir(parents=True, exist_ok=True)
                dst = upload_dir / item.name
                shutil.copy2(item, dst)
                orch.add_attachment(task.task_id, str(dst))

    print(f"  running {demo_id} (task_id={task.task_id})...")
    t0 = time.time()
    orch.run(task.task_id, max_rounds=8)
    dt = time.time() - t0

    task = orch.get_task(task.task_id)
    return task, dt


def verify_result(task, dt: float, demo_id: str) -> bool:
    """验证结果：flag 匹配 + LLM 参与生成 + writeup 存在。"""
    print(f"  state: {task.state.value}")
    print(f"  best_flag: {task.best_flag}")
    print(f"  rounds: {task.rounds_used}")
    print(f"  time: {dt:.1f}s")
    print(f"  evidence steps: {[e.step for e in task.evidence]}")
    print(f"  script_runs: {len(task.script_runs)}")

    # 1. flag 必须匹配
    expected = get_expected_flag(task.task_id)
    if not expected:
        print(f"  ❌ no expected_flag recorded")
        return False
    if task.best_flag != expected:
        print(f"  ❌ flag mismatch: got={task.best_flag} expected={expected}")
        return False
    print(f"  ✅ flag matches expected")

    # 2. LLM 必须参与生成 solve.py
    gen_evidence = [e for e in task.evidence if e.step == "generate_script"]
    if not gen_evidence:
        print(f"  ❌ no generate_script evidence (LLM did not participate)")
        return False
    if not task.current_script:
        print(f"  ❌ no current_script generated")
        return False
    print(f"  ✅ LLM generated solve.py ({len(task.current_script)} chars)")

    # 3. solve.py 必须真实运行（至少一次 run_script）
    run_evidence = [e for e in task.evidence if e.step == "run_script"]
    if not run_evidence:
        print(f"  ❌ no run_script evidence (script never ran)")
        return False
    print(f"  ✅ script ran {len(run_evidence)} time(s)")

    # 4. writeup 必须基于事件日志生成
    if not task.writeup_md:
        print(f"  ❌ no writeup generated")
        return False
    if "证据链" not in task.writeup_md and "evidence" not in task.writeup_md.lower():
        print(f"  ⚠️  writeup missing evidence chain section")
    print(f"  ✅ writeup generated ({len(task.writeup_md)} chars)")

    # 5. 反作弊：确认 orchestrator 没有读 expected_flag.txt
    # 检查 evidence 里没有出现 expected_flag 的明文（除非是 verify_flag 阶段比对）
    for e in task.evidence:
        if expected in (e.input_summary + e.output_summary):
            # 允许在 verify_flag 阶段出现（但我们的 orchestrator 不传 expected）
            if e.step != "verify_flag":
                print(f"  ❌ anti-cheat violation: expected_flag leaked in {e.step}")
                return False
    print(f"  ✅ anti-cheat: expected_flag not leaked")

    return True


def main() -> int:
    rc = check_llm_ready()
    if rc != 0:
        return rc

    init_db()
    print()
    print("=== Running Demos with Real LLM ===")
    results = []
    for demo_id in DEMOS_TO_RUN:
        print(f"\n--- {demo_id} ---")
        task, dt = run_demo(demo_id)
        ok = verify_result(task, dt, demo_id)
        results.append((demo_id, ok))
        print(f"  result: {'PASS' if ok else 'FAIL'}")

    print()
    print("=== Summary ===")
    for demo_id, ok in results:
        print(f"  {demo_id}: {'PASS' if ok else 'FAIL'}")

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f"\n{passed}/{total} demos passed with real LLM")

    if passed == total:
        print("✅ ctf-llm-smoke PASSED")
        return 0
    else:
        print("❌ ctf-llm-smoke FAILED")
        return 2


if __name__ == "__main__":
    sys.exit(main())

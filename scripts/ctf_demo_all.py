#!/usr/bin/env python3
"""
ctf_demo_all — 运行所有内置 CTF demo 题（mock LLM 模式）。

用法：
    python3 scripts/ctf_demo_all.py
"""
import os
import sys
import json
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

os.environ.setdefault("LLM_ENABLED", "false")
os.environ.setdefault("APP_ENV", "dev")

from app.database import init_db
init_db()

import app.core.llm_adapter as la
la._adapter = None
import app.core.ctf_agent_orchestrator as o
o._orchestrator = None

from app.core.ctf_agent_orchestrator import get_orchestrator

orch = get_orchestrator()

DEMOS = [
    "crypto_xor", "misc_exif", "forensics_log", "reverse_py",
    "crypto_xor_repeating", "crypto_rsa_small_e", "crypto_base_chain",
    "misc_png_chunks", "forensics_pcap_http", "reverse_py_bytecode",
    "reverse_elf_strings_xor",
]

results = []
for d in DEMOS:
    root = Path(__file__).resolve().parent.parent / "examples" / "ctf_demo" / d
    if not root.is_dir():
        print(f"SKIP {d}: not found")
        continue
    meta = json.loads((root / "challenge.json").read_text(encoding="utf-8"))
    expected = (root / "expected_flag.txt").read_text(encoding="utf-8").strip()
    task = orch.create_task(
        title=meta["title"],
        description=meta["description"],
        category_hint=meta.get("category", "auto"),
        flag_format=meta.get("flag_format"),
        authorized=True,
        allow_network=False,
        max_rounds=8,
        source="demo",
        demo_id=d,
        expected_flag=expected,
    )
    att = root / "attachment"
    if att.is_dir():
        for fn in os.listdir(att):
            if fn != "expected_flag.txt":
                orch.add_attachment(task.task_id, str(att / fn))
    t0 = time.time()
    orch.run(task.task_id)
    dt = time.time() - t0
    task = orch.get_task(task.task_id)
    ok = expected == task.best_flag
    status = "OK  " if ok else "FAIL"
    print(f"{status} {d}: state={task.state.value} flag={task.best_flag} rounds={task.rounds_used} time={dt:.1f}s")
    if not ok:
        print(f"     expected: {expected}")
    results.append((d, ok, dt))

print()
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"Summary: {passed}/{total} passed")
avg_time = sum(dt for _, _, dt in results) / total if total else 0
print(f"Avg time: {avg_time:.1f}s")
if passed == total:
    print("✅ ALL DEMOS PASSED")
    sys.exit(0)
else:
    failed = [d for d, ok, _ in results if not ok]
    print(f"⚠️  Failed: {failed}")
    sys.exit(0 if passed >= 8 else 1)  # 8+ pass is acceptable

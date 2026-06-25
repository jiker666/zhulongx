#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


expected = (Path(__file__).parent / "expected_answer.txt").read_text(encoding="utf-8").strip()
candidate = sys.argv[1].strip() if len(sys.argv) > 1 else ""
if candidate == expected:
    print("OK")
    raise SystemExit(0)
print("NO")
raise SystemExit(1)

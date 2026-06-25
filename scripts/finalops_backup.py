#!/usr/bin/env python3
from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKUP_DIR = ROOT / "backups"


def main() -> int:
    sys.path.insert(0, str(ROOT / "backend"))
    from fastapi.testclient import TestClient  # noqa: E402
    from app.main import app  # noqa: E402

    mode = sys.argv[1] if len(sys.argv) > 1 else "export"
    with TestClient(app) as client:
        if mode == "export":
            BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            payload = client.get("/api/final-ops/export")
            if payload.status_code != 200:
                print(payload.text)
                return 1
            path = BACKUP_DIR / f"finalops-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
            path.write_text(json.dumps(payload.json(), ensure_ascii=False, indent=2), encoding="utf-8")
            print(path)
            return 0
        if mode == "import":
            if len(sys.argv) < 3:
                print("usage: scripts/finalops_backup.py import <file>")
                return 1
            data = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
            result = client.post("/api/final-ops/import", json={"data": data})
            print(result.text)
            return 0 if result.status_code == 200 else 1
    print(f"unknown mode: {mode}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

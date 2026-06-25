#!/usr/bin/env python3
"""
Final competition readiness checks. Podman is the supported container runtime.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def ok(label: str, value: str = "") -> None:
    print(f"OK   {label}{': ' + value if value else ''}")


def warn(label: str, value: str = "") -> None:
    print(f"WARN {label}{': ' + value if value else ''}")


def fail(label: str, value: str = "") -> None:
    print(f"FAIL {label}{': ' + value if value else ''}")


def run(cmd: list[str]) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
        return p.returncode, p.stdout.strip()
    except Exception as exc:
        return 1, f"{type(exc).__name__}: {exc}"


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) != 0


def main() -> int:
    failures = 0
    if sys.version_info >= (3, 11):
        ok("Python", sys.version.split()[0])
    else:
        warn("Python", f"{sys.version.split()[0]} (3.11+ recommended for containers and CI)")

    node = shutil.which("node")
    if node:
        code, out = run(["node", "--version"])
        ok("Node", out if code == 0 else node)
    else:
        fail("Node", "not found")
        failures += 1

    podman = shutil.which("podman")
    if podman:
        code, out = run(["podman", "--version"])
        ok("Podman", out if code == 0 else podman)
    else:
        fail("Podman", "not found")
        failures += 1

    for raw in (os.environ.get("BACKEND_PORT", "8000"), os.environ.get("FRONTEND_PORT", "3000")):
        try:
            port = int(raw)
        except ValueError:
            warn("Port", f"invalid value {raw}")
            continue
        if port_free(port):
            ok("Port free", str(port))
        else:
            warn("Port in use", str(port))

    env = ROOT / ".env"
    if env.exists():
        ok(".env", "present")
    else:
        warn(".env", "missing; run `cp .env.example .env` and configure scope/LLM")

    for path in [ROOT / "data", ROOT / "backend" / "app" / "storage", ROOT / "samples" / "final_drill_outputs"]:
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".doctor"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            ok("Writable", str(path.relative_to(ROOT)))
        except Exception as exc:
            fail("Writable", f"{path}: {type(exc).__name__}")
            failures += 1

    scope_terms = ["COMPETITION_MODE", "SCOPE_CIDRS", "SCOPE_DOMAINS", "SCOPE_PORTS", "SCOPE_ALLOW_PRIVATE_IPS"]
    if env.exists():
        text = env.read_text(encoding="utf-8", errors="ignore")
        configured = [term for term in scope_terms if term in text]
        if configured:
            ok("Scope config keys", ", ".join(configured))
        else:
            warn("Scope config keys", "not found in .env")
        if "LLM_API_KEY=" in text and "replace_me" not in text:
            ok("LLM gateway", "key appears configured; health test is available at /api/llm/test")
        else:
            warn("LLM gateway", "not configured or placeholder")

    compose = ROOT / "podman-compose.yml"
    if compose.exists() and podman:
        code, out = run(["podman", "compose", "-f", str(compose), "config"])
        if code == 0:
            ok("podman compose config")
        else:
            fail("podman compose config", out[:300])
            failures += 1

    print("doctor complete")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

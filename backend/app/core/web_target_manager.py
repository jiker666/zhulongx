"""
Web Target Manager — 自动启动本地 Web 靶场（仅 127.0.0.1）。

职责：
- 对 web_local 类 demo，自动 spawn 一个子进程运行 Flask 靶场
- 仅监听 127.0.0.1（强制）
- 端口随机分配（避免冲突）
- 提供 health check
- 进程退出时自动清理
- ScopeGuard 记录授权证据

注意：靶场进程是独立子进程，与 orchestrator 解耦。
"""
from __future__ import annotations

import logging
import os
import signal
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# 全局：记录已启动的靶场进程 {demo_id: (process, port, url)}
_RUNNING_TARGETS: Dict[str, Dict[str, Any]] = {}


def _find_free_port() -> int:
    """找一个可用端口（5001-9999 范围内）。"""
    for port in range(5001, 10000):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    raise RuntimeError("no free port in 5001-9999")


def _is_port_listening(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _wait_for_ready(url: str, timeout: float = 8.0) -> bool:
    import urllib.request
    import urllib.error
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1.0)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def ensure_target_running(demo_id: str, demo_dir: Path) -> Dict[str, Any]:
    """确保 demo 对应的本地靶场已启动。返回 {url, port, pid}。

    如果已启动则复用；否则 spawn 一个子进程。
    """
    if demo_id in _RUNNING_TARGETS:
        info = _RUNNING_TARGETS[demo_id]
        proc = info["process"]
        # 检查进程是否还活着
        if proc.poll() is None and _is_port_listening("127.0.0.1", info["port"]):
            return info
        # 死了，重新启动
        logger.info("target %s died, restarting", demo_id)

    # 找靶场脚本
    att_dir = demo_dir / "attachment"
    target_script = None
    for candidate in ["app.py", "server.py", "target.py"]:
        p = att_dir / candidate
        if p.is_file():
            target_script = p
            break
    if not target_script:
        raise RuntimeError(f"no Flask target script found in {att_dir}")

    # 找可用端口
    port = _find_free_port()
    url = f"http://127.0.0.1:{port}"

    # 启动子进程（强制 127.0.0.1）
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["HOST"] = "127.0.0.1"
    # 清除敏感环境变量
    for key in list(env.keys()):
        if any(s in key.upper() for s in ("TOKEN", "API_KEY", "SECRET")):
            env.pop(key, None)

    log_dir = Path(settings_run_dir()) / "web_targets"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{demo_id}.log"

    try:
        proc = subprocess.Popen(
            ["python3", str(target_script)],
            env=env,
            stdout=open(log_file, "w"),
            stderr=subprocess.STDOUT,
            # 子进程组，便于清理
            preexec_fn=os.setsid if os.name == "posix" else None,
        )
    except Exception as e:
        raise RuntimeError(f"failed to spawn target: {e}")

    info = {
        "url": url,
        "port": port,
        "pid": proc.pid,
        "process": proc,
        "log_file": str(log_file),
        "started_at": time.time(),
    }
    _RUNNING_TARGETS[demo_id] = info

    # 等待 ready
    if not _wait_for_ready(url, timeout=8.0):
        # 启动失败，清理
        try:
            proc.terminate()
        except Exception:
            pass
        _RUNNING_TARGETS.pop(demo_id, None)
        raise RuntimeError(f"target {demo_id} did not become ready at {url}")

    logger.info("web target %s started at %s (pid=%d)", demo_id, url, proc.pid)
    return info


def settings_run_dir() -> str:
    """避免循环导入 settings。"""
    from app.config import settings
    return settings.CTF_RUN_DIR


def stop_target(demo_id: str) -> bool:
    """停止靶场。"""
    info = _RUNNING_TARGETS.pop(demo_id, None)
    if not info:
        return False
    proc = info.get("process")
    if proc and proc.poll() is None:
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:
                proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    return True


def stop_all_targets() -> None:
    """进程退出时清理所有靶场。"""
    for demo_id in list(_RUNNING_TARGETS.keys()):
        stop_target(demo_id)


# 注册 atexit 清理
import atexit
atexit.register(stop_all_targets)

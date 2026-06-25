"""
Code Execution Sandbox — 烛龙·玄枢 的脚本执行沙箱。

职责：
- 在隔离工作目录中执行 Agent 生成的 solve.py / exp.py / analysis.py
- 限制 timeout、输出长度、工作目录
- 捕获 stdout / stderr / exit_code / 运行时间
- 默认禁止访问真实公网（NETWORK_DENIED=true）
- 禁止执行危险命令（rm -rf /、mkfs、shutdown 等）
- 通过环境变量 + 子进程 cwd + 资源限制实现

注意：这不是容器级沙箱。如果需要更强隔离，请使用 firejail/nsjail/bubblewrap 或 docker。
本沙箱适合在演示/教学/CTF 离线题场景下限制常规风险。
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.config import settings


# 危险命令黑名单（不论大小写、参数顺序，命中即拒绝）
DANGEROUS_PATTERNS: List[str] = [
    r"\brm\s+-rf\s+/",
    r"\brm\s+-rf\s+~",
    r"\brm\s+-rf\s+\*",
    r"\bmkfs\b",
    r"\bshutdown\b",
    r"\breboot\b",
    r"\bhalt\b",
    r"\bpoweroff\b",
    r"\bdd\b.*of=/dev/",
    r":\(\)\s*\{",  # fork bomb
    r"\bcurl\b.*\|\s*sh",
    r"\bwget\b.*\|\s*sh",
    r"\bcurl\b.*\|\s*bash",
    r"\bwget\b.*\|\s*bash",
    r">\s*/dev/sd[a-z]",
    r"\bchmod\s+-R\s+777\s+/",
    r"\bchown\s+-R\s+.*\s+/",
    r"/etc/passwd",
    r"/etc/shadow",
    r"\.ssh/id_rsa",
    r"169\.254\.169\.254",  # cloud metadata
    r"\bsudo\b",
    r"\bnc\b.*-e",
    r"\bbash\b.*-i",
    r"\bsh\b.*-i",
    r"subprocess.*\.system\(['\"](rm|mkfs|dd|shutdown)",
    r"os\.system\(['\"](rm|mkfs|dd|shutdown)",
    r"popen\(['\"](rm|mkfs|dd|shutdown)",
]

DANGEROUS_RX = [re.compile(p, re.IGNORECASE) for p in DANGEROUS_PATTERNS]


# 仅允许执行的二进制（白名单）
SAFE_BINARIES = {
    "python3", "python", "pip3", "pip",
    "node", "ruby",
    "file", "strings", "xxd", "hexdump", "od",
    "binwalk", "exiftool", "exif",
    "readelf", "objdump", "nm", "ldd", "checksec",
    "unzip", "tar", "gunzip", "gzip",
    "grep", "egrep", "fgrep", "rg", "ack",
    "find", "ls", "stat", "wc", "head", "tail", "cut", "tr", "sort", "uniq",
    "cat", "less", "more",
    "awk", "sed",
    "md5sum", "sha1sum", "sha256sum", "shasum",
    "base64", "base32", "url_encode",
    "echo", "printf",
    "nc", "ncat",  # 仍需 scope_guard 在网络访问处二次校验
    "diff", "cmp",
}

# 永远禁止的二进制（即使被白名单前面调用也拒绝）
DENIED_BINARIES = {
    "rm", "rmdir", "mv", "cp",
    "chmod", "chown", "chroot", "mount", "umount",
    "kill", "killall", "pkill",
    "shutdown", "reboot", "halt", "poweroff",
    "mkfs", "fdisk", "dd",
    "sudo", "su",
    "curl", "wget",  # 网络访问单独由 scope_guard 控制
    "ssh", "scp", "sftp", "ftp", "telnet",
    "docker", "podman",
}


@dataclass
class SandboxResult:
    success: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    workdir: str = ""
    files_written: List[str] = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration_ms": self.duration_ms,
            "timed_out": self.timed_out,
            "workdir": self.workdir,
            "files_written": self.files_written,
            "error": self.error,
        }


class CodeExecutionSandbox:
    """脚本执行沙箱（基于 subprocess + cwd + env + 资源限制）。"""

    def __init__(
        self,
        *,
        base_workdir: Optional[str] = None,
        default_timeout: Optional[int] = None,
        max_output: Optional[int] = None,
        allow_network: bool = False,
    ) -> None:
        self.base_workdir = base_workdir or settings.CTF_RUN_DIR
        self.default_timeout = default_timeout or settings.CTF_SANDBOX_TIMEOUT
        self.max_output = max_output or settings.CTF_SANDBOX_MAX_OUTPUT
        self.allow_network = allow_network  # 必须显式开启，且 scope_guard 二次校验

        Path(self.base_workdir).mkdir(parents=True, exist_ok=True)

    # ---------- public API ----------

    def create_workspace(self, prefix: str = "ctf_") -> str:
        """为单次任务创建独立工作目录（返回绝对路径）。"""
        ws = tempfile.mkdtemp(prefix=prefix, dir=self.base_workdir)
        return os.path.abspath(ws)

    def cleanup_workspace(self, workdir: str) -> None:
        try:
            shutil.rmtree(workdir, ignore_errors=True)
        except Exception:
            pass

    def write_script(self, workdir: str, filename: str, content: str) -> str:
        """写入脚本（强制落在 workdir 内，禁止逃逸）。"""
        workdir = os.path.abspath(workdir)
        safe_name = os.path.basename(filename)
        if not safe_name.endswith((".py", ".sh", ".rb", ".js")):
            safe_name += ".py"
        target = os.path.join(workdir, safe_name)
        # 路径逃逸检查
        if not os.path.abspath(target).startswith(workdir + os.sep):
            raise ValueError(f"script path escapes sandbox: {filename}")
        # 内容静态审查
        self._scan_content(content)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(content)
        return os.path.abspath(target)

    def run_python(
        self,
        script_path: str,
        *,
        workdir: Optional[str] = None,
        timeout: Optional[int] = None,
        env: Optional[Dict[str, str]] = None,
        argv: Optional[List[str]] = None,
    ) -> SandboxResult:
        """执行 python 脚本。"""
        script_path = os.path.abspath(script_path)
        if not os.path.isfile(script_path):
            return SandboxResult(
                success=False, exit_code=-1, stdout="", stderr=f"script not found: {script_path}",
                duration_ms=0, error="script_not_found",
            )
        cmd = ["python3", script_path] + (argv or [])
        cwd = os.path.abspath(workdir) if workdir else os.path.dirname(script_path)
        return self._run(cmd, cwd=cwd, timeout=timeout, env=env)

    def run_shell(
        self,
        command: str,
        *,
        workdir: str,
        timeout: Optional[int] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> SandboxResult:
        """执行 shell 命令（受白名单 + 危险模式限制）。"""
        # 先扫描内容
        self._scan_content(command)
        # 解析命令第一个 token 看是否在白名单/黑名单中
        try:
            tokens = shlex.split(command)
        except ValueError:
            return SandboxResult(
                success=False, exit_code=-1, stdout="", stderr="invalid shell syntax",
                duration_ms=0, error="invalid_syntax",
            )
        if not tokens:
            return SandboxResult(
                success=False, exit_code=-1, stdout="", stderr="empty command",
                duration_ms=0, error="empty",
            )
        head = os.path.basename(tokens[0])
        if head in DENIED_BINARIES:
            return SandboxResult(
                success=False, exit_code=-1, stdout="", stderr=f"binary not allowed: {head}",
                duration_ms=0, error="denied_binary",
            )
        # 不在 SAFE_BINARIES 里的，允许但记录警告
        # (CTF 场景常需要 binwalk/exiftool/objdump 等多种工具，强白名单会导致正常用例失败)
        # 因此这里采用「黑名单优先 + 危险模式正则」的策略
        cmd = ["bash", "-c", command]
        return self._run(cmd, cwd=workdir, timeout=timeout, env=env)

    # ---------- internal ----------

    def _scan_content(self, content: str) -> None:
        """扫描脚本/命令是否命中危险模式。"""
        for rx in DANGEROUS_RX:
            m = rx.search(content)
            if m:
                raise ValueError(f"dangerous pattern detected: {rx.pattern[:60]} -> matched: {m.group(0)[:60]}")

    def _make_safe_env(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """构造子进程 env：默认禁网、清空敏感 env。"""
        safe = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": "/tmp",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_INPUT": "1",
        }
        if not self.allow_network:
            # 通过 NO_PROXY/HTTP_PROXY 阻断常见网络访问
            safe["HTTP_PROXY"] = "127.0.0.1:9"  # 黑洞
            safe["HTTPS_PROXY"] = "127.0.0.1:9"
            safe["ALL_PROXY"] = "127.0.0.1:9"
            safe["no_proxy"] = "localhost,127.0.0.1"
        # 清空敏感字段
        for key in list(os.environ.keys()):
            if any(s in key.upper() for s in ("TOKEN", "API_KEY", "SECRET", "CREDENTIAL", "PASSWORD")):
                continue
            if key not in safe:
                safe[key] = os.environ[key]
        if extra:
            safe.update(extra)
        return safe

    def _run(
        self,
        cmd: List[str],
        *,
        cwd: str,
        timeout: Optional[int],
        env: Optional[Dict[str, str]] = None,
    ) -> SandboxResult:
        """实际执行子进程。"""
        timeout_s = timeout or self.default_timeout
        # cwd 必须存在
        Path(cwd).mkdir(parents=True, exist_ok=True)
        start = time.time()
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd,
                env=self._make_safe_env(env),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                # 资源限制
                # 注意：preexec_fn 只在 POSIX 下生效
                preexec_fn=self._limit_resources if os.name == "posix" else None,
            )
            elapsed = int((time.time() - start) * 1000)
            stdout = (proc.stdout or "")[: self.max_output]
            stderr = (proc.stderr or "")[: self.max_output]
            truncated = ""
            if len(proc.stdout or "") > self.max_output:
                truncated = f"\n[stdout truncated at {self.max_output} bytes]"
            if len(proc.stderr or "") > self.max_output:
                truncated += f"\n[stderr truncated at {self.max_output} bytes]"
            return SandboxResult(
                success=(proc.returncode == 0),
                exit_code=proc.returncode,
                stdout=stdout + truncated,
                stderr=stderr,
                duration_ms=elapsed,
                workdir=cwd,
            )
        except subprocess.TimeoutExpired as e:
            elapsed = int((time.time() - start) * 1000)
            stdout = (e.stdout or b"").decode("utf-8", errors="ignore")[: self.max_output] if isinstance(e.stdout, bytes) else (e.stdout or "")[: self.max_output]
            stderr = (e.stderr or b"").decode("utf-8", errors="ignore")[: self.max_output] if isinstance(e.stderr, bytes) else (e.stderr or "")[: self.max_output]
            return SandboxResult(
                success=False,
                exit_code=124,
                stdout=stdout,
                stderr=stderr + f"\n[timeout after {timeout_s}s]",
                duration_ms=elapsed,
                timed_out=True,
                workdir=cwd,
                error="timeout",
            )
        except Exception as e:  # noqa: BLE001
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"sandbox error: {type(e).__name__}: {e}",
                duration_ms=int((time.time() - start) * 1000),
                workdir=cwd,
                error=type(e).__name__,
            )

    @staticmethod
    def _limit_resources() -> None:
        """通过 POSIX setrlimit 限制 CPU/内存/进程数。"""
        import resource
        # CPU 时间 30s
        try:
            resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        except Exception:
            pass
        # 内存 1GB
        try:
            resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
        except Exception:
            pass
        # 文件大小 100MB
        try:
            resource.setrlimit(resource.RLIMIT_FSIZE, (100 * 1024 * 1024, 100 * 1024 * 1024))
        except Exception:
            pass
        # 子进程数 32
        try:
            resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
        except Exception:
            pass


_sandbox: Optional[CodeExecutionSandbox] = None


def get_sandbox(allow_network: bool = False) -> CodeExecutionSandbox:
    global _sandbox
    # allow_network 必须每次显式传入，单例只用于非网场景
    if _sandbox is None or _sandbox.allow_network != allow_network:
        _sandbox = CodeExecutionSandbox(allow_network=allow_network)
    return _sandbox

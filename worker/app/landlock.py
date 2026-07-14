"""Fail-closed per-workspace filesystem confinement for Worker children."""
from __future__ import annotations

import ctypes
import os
from pathlib import Path


_CREATE_RULESET = 444
_ADD_RULE = 445
_RESTRICT_SELF = 446
_CREATE_VERSION = 1
_RULE_PATH_BENEATH = 1
_PR_SET_NO_NEW_PRIVS = 38

_EXECUTE = 1 << 0
_WRITE_FILE = 1 << 1
_READ_FILE = 1 << 2
_READ_DIR = 1 << 3
_REMOVE_DIR = 1 << 4
_REMOVE_FILE = 1 << 5
_MAKE_CHAR = 1 << 6
_MAKE_DIR = 1 << 7
_MAKE_REG = 1 << 8
_MAKE_SOCK = 1 << 9
_MAKE_FIFO = 1 << 10
_MAKE_BLOCK = 1 << 11
_MAKE_SYM = 1 << 12
_REFER = 1 << 13
_TRUNCATE = 1 << 14

_READ_ONLY = _EXECUTE | _READ_FILE | _READ_DIR
_WORKSPACE_ACCESS = (
    _READ_ONLY
    | _WRITE_FILE
    | _REMOVE_DIR
    | _REMOVE_FILE
    | _MAKE_CHAR
    | _MAKE_DIR
    | _MAKE_REG
    | _MAKE_SOCK
    | _MAKE_FIFO
    | _MAKE_BLOCK
    | _MAKE_SYM
)


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class _PathBeneathAttr(ctypes.Structure):
    _fields_ = [
        ("allowed_access", ctypes.c_uint64),
        ("parent_fd", ctypes.c_int32),
        ("reserved", ctypes.c_uint32),
    ]


def _check(value: int, operation: str) -> int:
    if value < 0:
        error = ctypes.get_errno()
        raise OSError(error, f"Landlock {operation} failed")
    return value


def apply_workspace_landlock(workspace: str | Path) -> int:
    root = Path(workspace).resolve(strict=True)
    libc = ctypes.CDLL(None, use_errno=True)
    abi = _check(libc.syscall(_CREATE_RULESET, 0, 0, _CREATE_VERSION), "version query")
    handled = _WORKSPACE_ACCESS
    if abi >= 2:
        handled |= _REFER
    if abi >= 3:
        handled |= _TRUNCATE
    ruleset_attr = _RulesetAttr(handled_access_fs=handled)
    ruleset_fd = _check(
        libc.syscall(_CREATE_RULESET, ctypes.byref(ruleset_attr), ctypes.sizeof(ruleset_attr), 0),
        "ruleset creation",
    )

    def allow(path: Path, access: int) -> None:
        if not path.exists():
            return
        descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = _PathBeneathAttr(allowed_access=access, parent_fd=descriptor, reserved=0)
            _check(
                libc.syscall(_ADD_RULE, ruleset_fd, _RULE_PATH_BENEATH, ctypes.byref(rule), 0),
                f"path rule for {path}",
            )
        finally:
            os.close(descriptor)

    try:
        for system_path in ("/usr", "/bin", "/lib", "/lib64", "/etc", "/opt/worker"):
            allow(Path(system_path), _READ_ONLY)
        for device in ("/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"):
            allow(Path(device), _READ_FILE | _WRITE_FILE)
        allow(root, handled)
        _check(libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")
        _check(libc.syscall(_RESTRICT_SELF, ruleset_fd, 0), "restriction")
    finally:
        os.close(ruleset_fd)
    return abi


__all__ = ["apply_workspace_landlock"]

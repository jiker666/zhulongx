# Binary Toolchain

The CTF sandbox includes a focused offline RE/PWN toolchain. Every executable
remains an operator-selected allowlist entry and is invoked by the agent only
through structured `run_command`. Sandbox health reports actual availability
before the runtime adds a program to the agent prompt.

## Included Tools

- Radare2 6.2.0: `r2`, `rabin2`, `rafind2`, `ragg2`, and `rax2` for native
  metadata, disassembly, cross-references, searches, and small binary helpers.
- JADX 1.5.5: `jadx` for APK, DEX, and Java bytecode analysis.
- Pwntools 4.15.0: `pwn` and the Python package for local harnesses and
  reproducible payload construction.
- Common helpers: `addr2line`, `c++filt`, `objcopy`, `patchelf`,
  `gdb-multiarch`, binutils, GDB, checksec, ROPgadget, ropper, one_gadget,
  seccomp-tools, qemu-user, strace, and ltrace.

## Agent Routing

- Use `rabin2` or read-only r2 commands for native format, symbol, section,
  function, and cross-reference questions.
- Use `jadx` only when the evidence identifies APK, DEX, or Java bytecode.
- Use `pwn` or `python3` with pwntools only after the local input path and
  exploit primitive are evidenced. Network access stays outside the sandbox and
  must use the scope-controlled TCP tools.
- Prefer bounded output switches and write large analysis artifacts to the
  per-run scratch directory. All command output remains capped by the runtime.

## Local Fallback

An operator-managed profile may use a host-backed Python interpreter instead
of the Docker image. Because each command runs with `HOME` set to its run
scratch directory, packages installed only under the operator's `~/.local`
site are intentionally invisible. Before starting a host-backed sandbox,
install the reviewed core requirements into the interpreter's own
site-packages:

```bash
XUANSHU_CTF_PYTHON=/opt/miniforge3/bin/python3 \
  sh tools/ctf/install-local-python-core.sh
```

The sandbox health endpoint verifies configured Python modules with that same
isolated `HOME` and reports missing imports before an agent run starts. Task
runs never invoke `pip`, `conda`, or another package manager.

When the operator-selected sandbox image is unavailable, the runtime still has
two bounded artifact capabilities. `extract_archive` extracts ZIP entries only
into the current run scratch root, rejecting traversal and symbolic-link paths;
`search_artifact` examines at most a 16 MiB prefix for UTF-8 or hexadecimal byte
patterns. Both are local-only, receive `AbortSignal`, consume the ordinary tool
and checkpoint budgets, and emit audit events.

## Build Integrity

Radare2 and JADX are downloaded only while building the sandbox image. Their
installers pin versions and verify SHA-256 before installation. The running
sidecar remains network-isolated.

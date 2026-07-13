# Interactive sessions

The session manager now provides task-owned TCP and HTTP-session identities, and denies cross-task access. Persistent PTY and debugger adapters remain a platform-dependent next step; they must report unsupported on Windows rather than emulate a terminal with fake output.

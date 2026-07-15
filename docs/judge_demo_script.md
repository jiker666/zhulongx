# Judge demo script

1. Create a run through `/api/competition/challenges` with the mock provider.
2. Show that the returned ID resolves to an `AgentSession` projection.
3. Record a hypothesis and execute `list_dir`; inspect canonical policy/tool events.
4. Create a run with `allow_worker` and `allow_process`, then run a Worker command.
5. Demonstrate PTY create, send, expect, and close.
6. Attempt parent traversal and cross-run absolute file access; show rejection.
7. Cancel a long command and show the command tree and PTY are reaped.

Only real tool output and configured validator results are presented as run
evidence or accepted candidates.

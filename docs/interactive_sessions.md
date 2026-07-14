# Interactive Worker sessions

The v3 registry exposes `terminal.create`, `terminal.send`, `terminal.read`,
`terminal.expect`, and `terminal.close`. Every request carries run, session,
task, and tool-call identity plus authorization and network scope.

Sessions are owner-scoped, output and cursors are bounded, timeouts are reaped,
and AgentSession abort calls task cancellation to terminate the full process
group. Cross-task identifiers return not found. PTY and command children run
under the same Landlock workspace boundary.

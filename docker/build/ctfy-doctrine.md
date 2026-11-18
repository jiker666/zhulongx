# Working doctrine (applies to every mode)

## Rhythm
- **Every model round-trip costs 20-70 seconds — round-trips are the scarcest resource.** Chain independent commands into ONE bash call with `&&` or `;` (aim for 5-10 commands per turn), read all outputs, then decide the next batch. Never one trivial command per turn; never re-run a command whose answer is already on disk.
- **Work from the state files first.** Read `attack/*/work.md`, `notes.md`, and the question verdicts in the briefing before deriving anything. Prior rounds (possibly in earlier containers) already paid for recon — inherit it, don't redo it.
- **Flush state before you finish.** Your final message is a report, not memory: the next session starts from the files. Update ledgers/notes in the SAME session that made the discovery.

## Attacking a target (instance / awd / engagement)
- **Verify the target before trusting it.** One request to the published endpoint: the response signature (title, framework, behavior) must match the challenge description. A TCP connect proves nothing; only an application-level response counts.
- **Cheapest untested action first.** Before writing version 2 of any hand-rolled client, re-read the ledger and fire every diagnosed-but-unexecuted one-call action. On version 3 of a hand-rolled client, stop entirely and re-rank surfaces by call cost.
- **Falsification depth cap: ~30 variants per shape family.** Past 30 variants of one carrier/shape family, rotating to any untried surface always beats variant #31. A family that needs variant #31 is a family you have mis-modeled: change the hypothesis or switch surface.
- **A named CVE is a shape family, not one payload.** Enumerate the advisory's exploit shapes as ONE scripted battery: every parameter carrier, encoding, and depth. Path-traversal primitives get a depth ladder in one script (1..12 levels of `../` plus `..%2F`, `%2e%2e/`, absolute paths, alternate route spellings).
- **Fingerprint → known-CVE before custom research.** Pin the version (headers, favicon hash, error pages, /package.json, /.git/HEAD), then check `/opt/zhx/arsenal/` for a public battery that matches before building anything novel. Wordlists live under `/usr/share/wordlists/`.
- **Never crash the target.** Prefer the boring working exploit over the fancy one; one fork bomb or forced restart can brick the box and zero every question on it. A target that dies right after YOUR heavy call is a target you killed: one restart, then downgrade the primitive.
- **Hand-rolled binary-protocol time-box: 15 cumulative minutes.** Debugger/serialization protocols driven by hand with no confirmed primitive after 15 minutes → return to the application layer (HTTP API, query languages, admin planes).
- **An unexplained constant anomaly is not a verdict.** Same weird 500 or same 0-2ms on every input: mark it 【UNEXPLAINED-ANOMALY】 in the ledger with the cheapest differential payload that would explain it; later sessions must take one fresh shot with a NEW hypothesis before believing "designed-broken".
- **Multi-question targets: map first, harvest cheapest-first.** The moment a foothold opens breadth (file read, command exec, internal network access), enumerate EVERYTHING one layer out (config files, env vars, /flag*, sibling hosts) before deep-attacking any single path — one question usually hides one layer past where the last one was. Waterfall every credential found across all surfaces before brute-forcing anything.
- **Flag-path conventions first.** With any file-read or exec primitive, sweep the well-known set before guessing application filenames: `/challenge/flag.txt`, `/flag.txt`, `/flag`, `/root/flag*`, `env`.

## Answers and the platform
- **Submit as you derive — exactly the way the README specifies.** Never queue a derived answer for later: later rounds may never come. Record every verdict.
- **Wrong answers are capped platform-side.** A wrong submission burns one of few attempts: never guess-spam formats or encodings. Derive a specific candidate from evidence (not plausibility) and submit once. Three wrong on one question = STOP submitting; go back to proof, switch surface.
- **Gated questions unlock on correct answers.** After any CORRECT verdict, expect new question prompts — the driver re-reads the challenge record, but you should re-check what is newly visible too.
- **Scope is a hard line: only the challenge target(s) described in the briefing.** Never attack the platform API, scoring infrastructure, or anything not in scope/README. One violation can zero the run.

## Modes
- **qa** (no target): answer from the description, questions, and attachments/ only. Reason first, verify against the files, submit per the README's qa route. No infrastructure exists to probe — do not go looking for any.
- **instance**: full attack flow above; the instance is already running and sized to this run — never try to start/stop/reset it.
- **defence**: read the gamebox declaration (shell service, live files, restart command). Change the minimum; the checker probes the service every round and a broken box scores worse than a vulnerable one. A patch is judged on a sandbox copy — write it, submit it, and also fix the live box if you can.
- **awd** — a many-round match where the clock, not depth, decides. Work EVERY session in this fixed order:
  1. **Fresh credential**: request a new ssh credential per connect (they expire in minutes). Never reuse a stale one; never cache one in the ledger beyond its life.
  2. **Defend (2 minutes, before anything else)**: from OUTSIDE, check your own box still answers. If down: ssh in, repair, run `restart_command`, verify again from outside. Re-check your patch survived the round (checkers may restore files). A dead own box bleeds score every round — this check is worth more than any single exploit.
  3. **Reap**: replay your capture scripts (`attack/awd/replay-*.sh`) against rival boxes. Flags died at the last rollover and were replanted — the SAME exploit scores again every round. Every capture script must be a one-command rerun; if it needs hand-holding, fix the script, not the rerun.
  4. **Bank immediately**: submit every captured flag the moment you have it (README route) AND list it in the session report's `flags` array — the driver banks anything you forget. A flag held past rollover is worth zero.
  5. **Invest**: leftover time goes to ONE new thing — a new family exploit variant (all boxes run the same code: one new exploit = the whole field next reap) or hunting the backdoor a rival planted on your box (check cron, new files, listening shells — they WILL come back).
  - First session extras: rotate your own password (note: a rival's existing session survives rotation), map the whole field once, baseline your box's file list (`find / -type f -newer /etc/hostname` style) so later tampering is visible in seconds.
  - An edit without `restart_command` does nothing; a service down after your edit is YOUR bleed. Verify from outside after every change.
  - Do not destroy a rival box's service beyond taking the flag — wasted ticks and possible penalty; leaving their box up but owned lets you re-harvest quietly.
- **engagement**: the report is the deliverable and it is revisable — save early, save often (PUT). Write what you DID, concretely: evidence is extracted from the prose. Stay inside scope.

## Submitting answers
The briefing names the submission route — usually the `ctfy` MCP tool `submit_answer`, keyed by the run's INSTANCE id (mcp.json at the working directory root carries the server address; the bearer token is the CTFY_TOKEN env). Use that tool (or the README's exact route) for every derived answer. Wrong answers have a platform-side attempt cap: submit once per DERIVED answer, never shotgun variants — re-derive from evidence between attempts.

## End of session
Stop tool work when every visible question is answered, capped, or blocked with no cheap untested lead left. Update every ledger. Then emit the JSON report — exactly one object, nothing after it.

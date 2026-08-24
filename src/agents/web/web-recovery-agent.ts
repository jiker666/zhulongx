import type { WebRoleDefinition } from "./types.js";

export const webRecoveryAgent: WebRoleDefinition = {
  name: "recovery",
  objective: "Diagnose the failure class, revise strategy, and resume from a different angle without blind retries.",
  responsibilities: [
    "Classify the failure: (a) wrong parameter name → re-read JS source; (b) filter blocked → try encoding variants; (c) wrong vuln type → re-query web_knowledge_lookup; (d) budget low → pick highest-confidence untried path.",
    "If login returns 500 on ALL inputs: STOP guessing. Check these in order: (1) read JS/HTML source for required fields, (2) try different Content-Type (JSON vs form), (3) fetch /.git/HEAD, /static/app.py, /proc/self/environ for source leak.",
    "If stuck on Flask session forgery after trying 20 common keys: run flask-unsign with rockyou.txt: flask-unsign --unsign --cookie '<COOKIE>' --wordlist /Users/j1k3r/wordlists/rockyou.txt --no-literal-eval",
    "If stuck on PHP admin password: READ LOGIN PHP SOURCE via nginx alias traversal first (/public/static/../login.php), extract hardcoded password from source code before any brute-force.",
    "If stuck on SSRF field name after trying top 20 names: use param-names.txt wordlist in a script, do NOT send 1000+ individual http_request calls — use run_command with a Python script.",
    "If SSRF response is wrapped in HTML page (探测结果 title): the actual internal service JSON is embedded in the HTML result-box — use Python to extract: import re; m=re.search(r'class=.result-box[^>]*>([\\s\\S]*?)</div>', html); or look for raw JSON snippet inside the HTML body.",
    "If SSRF reaches internal service and returns admin_token/config: enumerate flag endpoints via SSRF — try internal service /flag /secret /admin/flag using the same SSRF vector, NOT direct HTTP.",
    "Force strategy change after 2 failed attempts on same approach — switch to a different vuln class entirely.",
    "Use run_command for repetitive tasks: write a Python script to /tmp/exploit.py and run it, instead of dozens of individual http_request calls.",
    "Wordlist locations: rockyou.txt=/Users/j1k3r/wordlists/rockyou.txt, SecLists passwords=/Users/j1k3r/wordlists/seclists/100k-passwords.txt, param-names=/Users/j1k3r/wordlists/seclists/param-names.txt, web-files=/Users/j1k3r/wordlists/seclists/web-files.txt",
  ],
  forbiddenConclusions: [
    "Do not retry the same payload or field name indefinitely — change at least one variable.",
    "Do not mark blocked without trying at least 2 different vulnerability classes.",
    "Do not run 500+ individual http_request calls — use run_command with a script instead.",
    "Do not name Python scripts after stdlib modules (enum.py, re.py, os.py, sys.py) — this breaks imports.",
  ],
  preferredTools: ["web_knowledge_lookup", "run_command", "write_scratch_file", "http_request", "checkpoint"],
  outputContract: ["failureClass", "cause", "planChange", "nextAction"],
};

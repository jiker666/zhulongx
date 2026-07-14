# ZHULONG-X CTF Solve Skill

Use this when Codex is solving a ZHULONG-X CTF challenge.

Workflow:
1. Inspect the workspace: list files, identify attachment types, and record assumptions.
2. Prefer concrete evidence over guessing. Use `file`, `strings`, `xxd`, `grep`, `python`, and available reversing/forensics tools.
3. Create small reproducible scripts such as `solve.py`, `extract.py`, or `decode.py` in the workspace.
4. Run the scripts and verify the output locally.
5. When a candidate flag is found, print a final line exactly as `FINAL_FLAG: <flag>`.
6. When stuck, summarize tried paths and propose the next precise experiment.

Constraints:
- Do not overwrite original uploaded attachments.
- Do not use network unless the ZHULONG-X task prompt says network is authorized.
- Do not include API keys or secrets from `.env` in notes or reports.

# AI Write-up Generation

Completed runs can produce a dedicated CTF write-up after `finish_task` settles the run. The write-up pass is separate from the solving Agent and receives only the normalized task, structured run state, public transcript, bounded tool results, findings, and verification records. Hidden reasoning and sensitive credentials are never included in the prompt or persisted output.

The generated document follows the submission format from `ctf-writeup`: YAML front matter, `Summary`, a short `Solution` with one to three steps, a complete language-tagged solving script when the public evidence supports reconstruction, and a final `Flag` code block containing the structured submission exactly.

Generation is bounded to two model attempts and the configured finalization time budget. The runtime validates required headings, metadata, exact submission, script code block, length, and duplicate answer lines. If generation fails, the original factual summary remains available and `writeupError` records the bounded failure reason.

For an older terminal run without a stored write-up, call `POST /v1/runs/<run-id>/writeup`. The endpoint generates, validates, persists, and returns the document. It refuses non-terminal runs and does not infer a submission from prose.

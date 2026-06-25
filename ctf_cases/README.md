# Real CTF Case Input

Place authorized local CTF cases under this directory.

Required structure:

```text
ctf_cases/
  case01/
    challenge.json
    README.md
    attachments/
    scope.env.example
    evaluator/
      expected_answer.txt
      verify.py
```

`solve_ctf_case.py` may read only `challenge.json`, `README.md`, `attachments/`, and `scope.env.example`. It must not read `evaluator/`.

`evaluate_ctf_case.py` is the only script that reads `evaluator/expected_answer.txt`, and it runs after solving to compare candidates.

If you do not have an external real case yet, use `ctf_cases/mock_real_case01` only to verify the blind-solve pipeline. Do not describe it as an external real challenge.

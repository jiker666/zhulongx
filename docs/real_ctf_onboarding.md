# Real CTF Onboarding

真实题接入时，把每道题整理成一个独立目录：

```text
ctf_cases/case01/
  challenge.json
  README.md
  attachments/
  scope.env.example
  evaluator/expected_answer.txt
```

`challenge.json`、`README.md`、`attachments/`、`scope.env.example` 是 Blind Solve Mode 允许读取的当前题材料。`evaluator/expected_answer.txt` 只在本地训练评估时放入，比赛现场不要放标准答案。

比赛现场不要放 `writeup/`、`solution/`、`wp/`、历史解题记录或样例答案。公开老题训练时，建议删除或模糊化题目名称，降低 LLM 预训练记忆影响；如果使用公开老题，模型可能凭预训练记忆知道答案，因此不能作为“完全盲解”证明。

推荐验证方式：

```bash
make solve-ctf CASE=ctf_cases/case01
make audit-solve CASE=ctf_cases/case01 RUN=latest
```

训练时如果放了 evaluator，可追加：

```bash
make solve-and-eval-ctf CASE=ctf_cases/case01
```

最强盲解证明来自随机生成题或内部未公开题。随机题可用：

```bash
make generate-random-ctf-case
make solve-and-eval-ctf CASE=ctf_cases/generated/latest
make audit-solve CASE=ctf_cases/generated/latest RUN=latest
```

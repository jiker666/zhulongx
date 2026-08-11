import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { QuestionBank, questionToTaskRequest } from "../src/question-bank.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QuestionBank", () => {
  it("loads bounded public challenge materials and excludes reference answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-question-bank-"));
    roots.push(root);
    const question = join(root, "benchmark", "crypto", "Example");
    await mkdir(join(question, "metadata", "solution"), { recursive: true });
    await mkdir(join(question, "solution"), { recursive: true });
    await writeFile(join(root, "task_list_crypto.txt"), "\n# one question\nbenchmark/crypto/Example\nbenchmark/crypto/Example\n");
    await writeFile(join(question, "source.py"), "print('public')\n");
    await writeFile(join(question, "README.md"), "writeup with a flag\n");
    await writeFile(join(question, "secret.py"), "FLAG = 'hidden'\n");
    await writeFile(join(question, "answer.txt"), "hidden\n");
    await writeFile(join(question, "metadata", "answer.json"), "{}\n");
    await writeFile(join(question, "solution", "solve.py"), "print('hidden')\n");
    await symlink(join(question, "source.py"), join(question, "linked.py"));

    const bank = new QuestionBank({
      enabled: true,
      root,
      listFiles: ["task_list_crypto.txt"],
      maxQuestions: 20,
    });
    const questions = await bank.load();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ id: "benchmark/crypto/Example", title: "Example", category: "crypto" });
    expect(questions[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(questions[0]?.attachments.map((path) => path.split("/").at(-1))).toEqual(["source.py"]);
    expect(JSON.stringify(questions)).not.toContain("hidden");
    const task = questionToTaskRequest(questions[0]!);
    expect(task.metadata).toMatchObject({ source: "question-bank", questionId: "benchmark/crypto/Example", category: "crypto" });
    expect(task.task).toContain("finish the task with the exact final answer");
  });

  it("reports missing operator configuration without exposing a local path", async () => {
    const bank = new QuestionBank({ enabled: true, rootEnv: "XUANSHU_MISSING_BANK", listFiles: ["tasks.txt"], maxQuestions: 20 });
    const snapshot = await bank.snapshot();
    expect(snapshot).toMatchObject({ enabled: true, configured: false, count: 0 });
    expect(snapshot.error).toContain("Missing question-bank root");
  });

  it("extracts only public instance metadata and narrows task scope to its mapped port", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-question-bank-instance-"));
    roots.push(root);
    const question = join(root, "benchmark", "crypto", "Service");
    await mkdir(join(question, "metadata"), { recursive: true });
    await writeFile(join(root, "task_list_crypto.txt"), "benchmark/crypto/Service\n");
    await writeFile(join(question, "chall.py"), "print('public')\n");
    await writeFile(join(question, "metadata", "metadata.json"), JSON.stringify({
      hard_prompt: "Connect to the challenge service.",
      target_host: "service:1337",
      subtasks: [{ answer: "SECRET_SHOULD_NOT_APPEAR" }],
    }));
    await writeFile(join(question, "compose.yml"), [
      "services:",
      "  service:",
      "    build: ./challenge",
      "    ports:",
      "      - \"31337:1337\"",
      "networks:",
      "  shared_net:",
      "    external: true",
      "",
    ].join("\n"));

    const bank = new QuestionBank({ enabled: true, root, listFiles: ["task_list_crypto.txt"], maxQuestions: 20 });
    const [loaded] = await bank.load();
    expect(loaded).toMatchObject({
      prompt: "Connect to the challenge service.",
      instance: {
        service: "service",
        containerPort: 1337,
        hostPort: 31337,
        externalNetworks: ["shared_net"],
      },
    });
    expect(JSON.stringify(loaded)).not.toContain("SECRET_SHOULD_NOT_APPEAR");
    const task = questionToTaskRequest(loaded!, { host: "127.0.0.1", port: 31337 });
    expect(task.scope).toMatchObject({ mode: "controlled", allowedHosts: ["127.0.0.1:31337"] });
    expect(task.task).toContain("Connect to the challenge service.");
    expect(task.task).toContain("127.0.0.1:31337");
  });
});

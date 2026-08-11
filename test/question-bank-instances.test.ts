import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionBankInstanceRunner } from "../src/question-bank-instances.js";
import type { QuestionBankQuestion } from "../src/question-bank.js";
import type { AppConfig } from "../src/types.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function commandResult(exitCode: number) {
  return {
    exitCode,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputSha256: "a".repeat(64),
    truncated: false,
    timedOut: false,
  };
}

function question(root: string): QuestionBankQuestion {
  return {
    id: "benchmark/crypto/Service",
    title: "Service",
    category: "crypto",
    root,
    attachments: [],
    fingerprint: "b".repeat(64),
    prompt: "Connect to the service.",
    instance: {
      composeFile: join(root, "compose.yml"),
      service: "service",
      containerPort: 1337,
      hostPort: 31337,
      externalNetworks: ["shared_net"],
    },
  };
}

describe("QuestionBankInstanceRunner", () => {
  it("starts a loopback-bound instance, narrows scope, and cleans it up", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-instance-runner-"));
    roots.push(root);
    const config = testConfig(root);
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["127.0.0.1:*"];
    config.questionBank = {
      enabled: true,
      root,
      listFiles: ["tasks.txt"],
      maxQuestions: 20,
      instanceRunner: {
        enabled: true,
        networkName: "shared_net",
        startupTimeoutMs: 5000,
        commandTimeoutMs: 5000,
        maxOutputBytes: 4096,
      },
    };
    await writeFile(join(root, "compose.yml"), "services: {}\n");
    await mkdir(join(root, "challenge"), { recursive: true });
    await writeFile(join(root, "challenge", "Dockerfile"), "FROM python:3.9-slim-buster\nRUN echo buster\n");
    const serviceQuestion = {
      ...question(root),
      instance: { ...question(root).instance!, buildContext: join(root, "challenge") },
    };
    const calls: string[][] = [];
    const runner = new QuestionBankInstanceRunner(config, {
      command: vi.fn(async (args) => {
        calls.push(args);
        return commandResult(args[0] === "network" && args[1] === "inspect" ? 1 : 0);
      }),
      waitForPort: vi.fn(async () => {}),
    });

    const prepared = await runner.prepare(serviceQuestion);
    expect(prepared.request.scope).toMatchObject({ mode: "controlled", allowedHosts: ["127.0.0.1:31337"] });
    expect(prepared.request.task).toContain("127.0.0.1:31337");
    expect(calls).toEqual(expect.arrayContaining([
      ["network", "inspect", "shared_net"],
      ["network", "create", "--internal", "shared_net"],
    ]));
    const start = calls.find((args) => args.includes("up"));
    expect(start).toEqual(expect.arrayContaining(["up", "-d", "--build", "--force-recreate", "service"]));
    const override = start?.[start.indexOf("-f", start.indexOf("-f") + 1) + 1];
    expect(override).toBeTruthy();
    expect(await readFile(override!, "utf8")).toContain("127.0.0.1:31337:1337");
    expect(await readFile(override!, "utf8")).toContain("build:");

    await prepared.cleanup();
    expect(calls.some((args) => args.includes("down") && args.includes("--remove-orphans"))).toBe(true);
    const auditPath = calls.length > 0
      ? (await import("node:fs/promises")).readdir(join(config.runtime.artifactRoot, "..", "question-bank-instances"))
      : undefined;
    expect(auditPath).toBeTruthy();
  });

  it("rejects an instance network outside the operator configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-instance-network-"));
    roots.push(root);
    const config = testConfig(root);
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["127.0.0.1:*"];
    config.questionBank = {
      enabled: true,
      root,
      listFiles: ["tasks.txt"],
      maxQuestions: 20,
      instanceRunner: {
        enabled: true,
        networkName: "shared_net",
        startupTimeoutMs: 5000,
        commandTimeoutMs: 5000,
        maxOutputBytes: 4096,
      },
    };
    await expect(new QuestionBankInstanceRunner(config).prepare({
      ...question(root),
      instance: { ...question(root).instance!, externalNetworks: ["other_net"] },
    })).rejects.toThrow("unconfigured external network");
  });
});

import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArenaClient,
  arenaAttemptToTask,
  arenaSubmissionCorrect,
  extractArenaAnnexes,
  extractFlagCandidate,
  scopeForArenaAttempt,
  type ArenaAttempt,
} from "../src/arena.js";
import type { RunState } from "../src/types.js";
import { buildArenaEvaluationReport } from "../src/arena-evaluation.js";
import { testConfig } from "./helpers.js";

const servers: Server[] = [];

afterEach(async () => {
  delete process.env.XUANSHU_TEST_ARENA_TOKEN;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("NSSCTF Arena integration", () => {
  it("uses the configured token env and Arena API policy prefix", async () => {
    process.env.XUANSHU_TEST_ARENA_TOKEN = "nss_agent_test";
    const baseUrl = await listen((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/skill/agent/arena/next/");
      expect(request.headers.authorization).toBe("Bearer nss_agent_test");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 200, data: { reused: false, attempt: { id: 7, problem: {} } } }));
    });
    const config = testConfig("/tmp/xuan-arena");
    config.arena!.baseUrl = baseUrl;

    await expect(new ArenaClient(config.arena).next()).resolves.toMatchObject({ attempt: { id: 7 } });
    await expect(
      new ArenaClient({ ...config.arena!, baseUrl }).request("GET", "/api/not-arena/"),
    ).rejects.toThrow("allowed API prefix");
  });

  it("builds a task without leaking tokens and extracts only explicit FLAG lines", () => {
    const attempt: ArenaAttempt = {
      id: 8,
      state_label: "active",
      wrong_count: 0,
      max_wrong_count: 20,
      remaining_seconds: 3600,
      problem: {
        type_label: "Web",
        content: "Read the service and solve it.",
        container_enabled: true,
        container: { url: ["http://case.sandbox.invalid:31001"], remaining_seconds: 3600 },
        annex: { filename: "source.zip" },
      },
    };

    const task = arenaAttemptToTask(attempt);
    expect(task.task).toContain("Read the service");
    expect(task.task).toContain("FLAG: <exact flag value>");
    expect(task.task).not.toContain("nss_agent_");

    const state = {
      summary: "Solved with evidence.\nFLAG: dynamic-value-from-analysis",
      findings: [],
    } as unknown as RunState;
    expect(extractFlagCandidate(state)).toBe("dynamic-value-from-analysis");
    expect(extractFlagCandidate({ summary: "Solved", submission: "structured-value", findings: [] } as unknown as RunState)).toBe(
      "structured-value",
    );
    expect(extractFlagCandidate({ ...state, summary: "possible dynamic-value-from-analysis" })).toBeUndefined();
  });

  it("narrows dynamic container hosts only when the full config already authorizes the pattern", () => {
    const attempt: ArenaAttempt = {
      id: 9,
      problem: { container: { url: ["http://case.sandbox.invalid:31001"] } },
    };
    const config = testConfig("/tmp/xuan-arena");
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["*.sandbox.invalid:*"];

    expect(scopeForArenaAttempt(config, attempt)).toEqual({
      mode: "controlled",
      allowedHosts: ["case.sandbox.invalid:31001"],
    });
    config.scope.allowedHosts = ["outside.invalid:*"];
    expect(() => scopeForArenaAttempt(config, attempt)).toThrow("outside configured scope");

    config.scope.allowedHosts = ["*.sandbox.invalid:*"];
    expect(scopeForArenaAttempt(config, { id: 10, problem: { container_enabled: true, container: null } })).toEqual({
      mode: "controlled",
      allowedHosts: [],
    });

    expect(
      scopeForArenaAttempt(config, {
        id: 11,
        problem: { container: { url: ["case.sandbox.invalid:31001"] } },
      }),
    ).toEqual({
      mode: "controlled",
      allowedHosts: ["case.sandbox.invalid:31001"],
    });
  });

  it("extracts annexes without putting signed download URLs into the model task", () => {
    const attempt: ArenaAttempt = {
      id: 10,
      problem: {
        annex: {
          files: [
            {
              name: "challenge.zip",
              size: 1024,
              url: "https://www.nssctf.cn/api/skill/agent/arena/attempt/10/annex/?signature=secret",
            },
          ],
        },
      },
    };

    expect(extractArenaAnnexes(attempt)).toEqual([
      {
        name: "challenge.zip",
        size: 1024,
        url: "https://www.nssctf.cn/api/skill/agent/arena/attempt/10/annex/?signature=secret",
      },
    ]);
    const task = arenaAttemptToTask(attempt).task;
    expect(task).toContain("challenge.zip");
    expect(task).not.toContain("signature=secret");
  });

  it("uses the platform verdict and computes settled-attempt accuracy", () => {
    expect(arenaSubmissionCorrect({ correct: true })).toBe(true);
    expect(arenaSubmissionCorrect({ attempt: { id: 1, state_label: "active" } })).toBe(false);
    expect(arenaSubmissionCorrect({ attempt: { id: 1, state_label: "solved" } })).toBe(true);

    const config = testConfig("/tmp/xuan-arena");
    const report = buildArenaEvaluationReport({
      startedAt: "2026-08-04T00:00:00.000Z",
      targetAttempts: 2,
      config,
      attempts: [
        {
          attemptId: 1,
          category: "Crypto",
          outcome: "solved",
          settled: true,
          correct: true,
          flagCandidateFound: true,
          submissionAttempts: 1,
          runCount: 1,
          attachmentCount: 0,
          reused: false,
          run: { id: "run-1", status: "completed", turns: 2, toolCalls: 2 },
        },
        {
          attemptId: 2,
          category: "Web",
          outcome: "wrong",
          settled: true,
          correct: false,
          flagCandidateFound: true,
          submissionAttempts: 1,
          runCount: 1,
          attachmentCount: 0,
          reused: false,
          run: { id: "run-2", status: "completed", turns: 3, toolCalls: 4 },
        },
      ],
    });
    expect(report).toMatchObject({
      targetAttempts: 2,
      evaluatedAttempts: 2,
      correct: 1,
      incorrect: 1,
      accuracy: 0.5,
      accuracyPercent: 50,
      completed: true,
    });
  });
});

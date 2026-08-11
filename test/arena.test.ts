import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArenaClient,
  arenaAttemptToTask,
  arenaSubmissionCorrect,
  extractArenaAnnexes,
  extractFlagCandidate,
  arenaCategoryAllowed,
  normalizeArenaCategory,
  scopeForArenaAttempt,
  type ArenaAttempt,
} from "../src/arena.js";
import type { RunState } from "../src/types.js";
import { buildArenaEvaluationReport, isRetryableModelFailure } from "../src/arena-evaluation.js";
import { solveArenaOnce } from "../src/arena-evaluation.js";
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
  it("normalizes operator category aliases and keeps an empty allowlist unrestricted", () => {
    expect(normalizeArenaCategory("密码学")).toBe("crypto");
    expect(normalizeArenaCategory("Miscellaneous")).toBe("misc");
    expect(arenaCategoryAllowed(undefined, "Web")).toBe(true);
    expect(arenaCategoryAllowed({ enabled: true, baseUrl: "https://arena.invalid", tokenEnv: "TOKEN", timeoutMs: 1, maxResponseBytes: 1, allowedCategories: ["crypto", "misc"] }, "Crypto")).toBe(true);
    expect(arenaCategoryAllowed({ enabled: true, baseUrl: "https://arena.invalid", tokenEnv: "TOKEN", timeoutMs: 1, maxResponseBytes: 1, allowedCategories: ["crypto", "misc"] }, "Web")).toBe(false);
  });

  it("leaves an out-of-scope Arena category active instead of triggering an early-abandon cooldown", async () => {
    const config = testConfig("/tmp/xuan-arena");
    config.arena!.allowedCategories = ["crypto", "misc"];
    const client = {
      next: vi.fn(async () => ({ attempt: { id: 21, problem: { type_label: "Web", annex: { url: "https://arena.invalid/file" } } } })),
      abandon: vi.fn(async () => ({ attempt: { id: 21, state_label: "abandoned" } })),
    } as unknown as ArenaClient;

    const result = await solveArenaOnce(config, client, { autoSubmit: true });
    expect(result.evaluation).toMatchObject({ outcome: "skipped", settled: false, category: "Web", runCount: 0 });
    expect(result.state.status).toBe("blocked");
    expect(result.evaluation.reason).toContain("left open");
    expect(client.abandon).not.toHaveBeenCalled();
  });

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

  it("bounds Arena responses that never finish streaming", async () => {
    process.env.XUANSHU_TEST_ARENA_TOKEN = "nss_agent_test";
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"code":200,"data":{"attempt":');
    });
    const config = testConfig("/tmp/xuan-arena");
    config.arena!.baseUrl = baseUrl;
    config.arena!.timeoutMs = 20;
    const jobController = new AbortController();

    await expect(new ArenaClient(config.arena).next(jobController.signal)).rejects.toThrow(/timed out/i);
    expect(jobController.signal.aborted).toBe(false);
  });

  it("surfaces a platform cooldown instead of sleeping until its retry time", async () => {
    process.env.XUANSHU_TEST_ARENA_TOKEN = "nss_agent_test";
    const retryAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        code: 429,
        message: "arena cooldown",
        data: { reason: "early_abandon", retry_after_seconds: 604800, retry_at: retryAt },
      }));
    });
    const config = testConfig("/tmp/xuan-arena");
    config.arena!.baseUrl = baseUrl;

    await expect(new ArenaClient(config.arena).next()).rejects.toThrow(
      `Arena API rate limited: arena cooldown; retry at ${new Date(retryAt).toISOString()}`,
    );
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

    const continuous = buildArenaEvaluationReport({
      startedAt: "2026-08-04T00:00:00.000Z",
      targetAttempts: null,
      config,
      attempts: [report.attempts[0]!],
    });
    expect(continuous).toMatchObject({ targetAttempts: null, evaluatedAttempts: 1, completed: false });
  });

  it("classifies transient model gateway failures for bounded Arena retry", () => {
    expect(isRetryableModelFailure("Connection error.")).toBe(true);
    expect(isRetryableModelFailure("fetch failed: ECONNRESET")).toBe(true);
    expect(isRetryableModelFailure("Missing model credential")).toBe(false);
    expect(isRetryableModelFailure("Tool-call budget exhausted")).toBe(false);
  });
});

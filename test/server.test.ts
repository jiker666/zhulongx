import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/server.js";
import { ArenaJobManager } from "../src/arena-jobs.js";
import { ManualJobManager } from "../src/manual-jobs.js";
import { QuestionBank } from "../src/question-bank.js";
import { QuestionBankProgressStore } from "../src/question-bank-progress.js";
import type { ArenaClient } from "../src/arena.js";
import type { RunState } from "../src/types.js";
import { AuditChain } from "../src/audit.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.XUANSHU_TEST_SERVER_TOKEN;
  delete process.env.XUANSHU_TEST_API_KEY;
  delete process.env.XUANSHU_TEST_ARENA_TOKEN;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("REST API", () => {
  it("exposes public health and protects run endpoints when configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    process.env.XUANSHU_TEST_SERVER_TOKEN = "test-token";
    const running = await startApiServer(config, { frontendRoot: join(root, "missing-frontend") });
    try {
      const health = await fetch(`${running.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", service: "zhulong-xuanshu" });

      const dashboard = await fetch(`${running.url}/`);
      expect(dashboard.status).toBe(200);
      const dashboardSource = await dashboard.text();
      expect(dashboardSource).toContain("NSS 控制台");
      expect(dashboardSource).toContain("已结算");
      expect(dashboardSource).toContain("jobDisplayStatus");
      expect(dashboardSource).toContain("id=\"continuous\"");
      expect(dashboardSource).toContain("id=\"manual-form\"");
      expect(dashboardSource).toContain("id=\"manual-files\"");
      expect(dashboardSource).toContain("id=\"manual-writeup\"");
      expect(dashboardSource).toContain("id=\"question-bank-start\"");
      expect(dashboardSource).toContain("/v1/question-bank/jobs");
      expect(dashboardSource).toContain("appendManualTaskResult");
      expect(dashboardSource).toContain("manualCopyButton(task.flag,'FLAG')");
      expect(dashboardSource).toContain("/v1/manual/uploads");
      const scriptStart = dashboardSource.lastIndexOf("<script>") + "<script>".length;
      const scriptEnd = dashboardSource.indexOf("</script>", scriptStart);
      expect(() => new Function(dashboardSource.slice(scriptStart, scriptEnd))).not.toThrow();

      const unauthorized = await fetch(`${running.url}/v1/runs/missing`);
      expect(unauthorized.status).toBe(401);
      const unauthorizedUpload = await fetch(`${running.url}/v1/manual/uploads`, {
        method: "POST",
        headers: { "x-file-name": "test.txt" },
        body: "secret",
      });
      expect(unauthorizedUpload.status).toBe(401);
    } finally {
      await running.close();
    }
  });

  it("uploads binary attachments and attaches them to every manual task", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-upload-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    const captured: Array<{ bytes: Buffer[]; paths: string[]; workspaceMode: string | undefined }> = [];
    let nextRun = 0;
    const states = new Map<string, RunState>();
    const manualJobs = new ManualJobManager({
      runManager: {
        start: (task, options) => {
          const id = `00000000-0000-4000-8000-${String(++nextRun).padStart(12, "0")}`;
          const paths = [...(task.attachments ?? [])];
          captured.push({ bytes: paths.map((path) => readFileSync(path)), paths, workspaceMode: options?.workspaceMode });
          states.set(id, {
            ...({} as RunState),
            id,
            status: "completed",
            phase: "done",
            task: { task: task.task, attachments: [], metadata: {} },
            turns: 1,
            toolCalls: 1,
          });
          return id;
        },
        wait: async (id) => states.get(id) as RunState,
        stop: () => true,
      },
    });
    const running = await startApiServer(config, { manualJobs });
    try {
      const firstBytes = Buffer.from([0, 1, 2, 255, 128]);
      const firstResponse = await fetch(`${running.url}/v1/manual/uploads`, {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent("题目.bin") },
        body: firstBytes,
      });
      expect(firstResponse.status).toBe(201);
      const firstBody = await firstResponse.json() as { upload: { id: string } };

      const secondBytes = Buffer.from("supporting text\n", "utf8");
      const secondResponse = await fetch(`${running.url}/v1/manual/uploads`, {
        method: "POST",
        headers: { "x-file-name": "notes.txt", "x-upload-id": firstBody.upload.id },
        body: secondBytes,
      });
      expect(secondResponse.status).toBe(201);

      const unsafe = await fetch(`${running.url}/v1/manual/uploads`, {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent("../escape.txt") },
        body: "x",
      });
      expect(unsafe.status).toBe(400);

      const started = await fetch(`${running.url}/v1/manual/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tasks: ["one", "two"], concurrency: 2, uploadId: firstBody.upload.id }),
      });
      expect(started.status).toBe(202);
      const startedBody = await started.json() as { job: { id: string; tasks: Array<{ attachmentCount: number }> } };
      expect(startedBody.job.tasks.every((task) => task.attachmentCount === 2)).toBe(true);
      await vi.waitFor(() => expect(captured).toHaveLength(2));
      for (const task of captured) {
        expect(task.bytes).toEqual([firstBytes, secondBytes]);
        expect(task.workspaceMode).toBe("attachments-only");
      }
      await vi.waitFor(async () => await expect(access(captured[0]!.paths[0]!)).rejects.toThrow());
    } finally {
      await running.close();
    }
  });

  it("accepts a bounded manual batch and exposes its progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-manual-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    process.env.XUANSHU_TEST_API_KEY = "model-test-key";
    let nextRun = 0;
    const states = new Map<string, RunState>();
    const manualJobs = new ManualJobManager({
      runManager: {
        start: (task) => {
          const id = `00000000-0000-4000-8000-${String(++nextRun).padStart(12, "0")}`;
          states.set(id, {
            ...({} as RunState),
            id,
            status: "completed",
            phase: "done",
            task: { task: task.task, attachments: [], metadata: {} },
            submission: "NSSCTF{server-result}",
            summary: "# WP\n\nVerified deterministically.\nFLAG: NSSCTF{server-result}",
            turns: 1,
            toolCalls: 1,
          });
          return id;
        },
        wait: async (id) => states.get(id) as RunState,
        stop: () => true,
      },
    });
    const running = await startApiServer(config, { manualJobs });
    try {
      const invalid = await fetch(`${running.url}/v1/manual/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tasks: ["one"], concurrency: 9 }),
      });
      expect(invalid.status).toBe(400);

      const started = await fetch(`${running.url}/v1/manual/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tasks: ["one", { task: "two", metadata: { category: "crypto" } }], concurrency: 2, writeup: true }),
      });
      expect(started.status).toBe(202);
      const body = await started.json() as { job: { id: string; total: number } };
      expect(body.job.total).toBe(2);
      await vi.waitFor(async () => {
        const result = await fetch(`${running.url}/v1/manual/jobs/${body.job.id}`);
        const payload = await result.json() as { job: {
          status: string;
          completed: number;
          writeup: boolean;
          tasks: Array<{ flag?: string; writeup?: string }>;
        } };
        expect(payload.job).toMatchObject({ status: "completed", completed: 2, writeup: true });
        expect(payload.job.tasks).toHaveLength(2);
        expect(payload.job.tasks.every((task) => task.flag === "NSSCTF{server-result}" && task.writeup?.includes("# WP"))).toBe(true);
      });
    } finally {
      await running.close();
    }
  });

  it("records successful question-bank work and starts later batches with only pending questions", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-question-bank-"));
    roots.push(root);
    const config = testConfig(root);
    const bankRoot = join(root, "bank");
    const first = join(bankRoot, "benchmark", "crypto", "First");
    const second = join(bankRoot, "benchmark", "misc", "Second");
    await Promise.all([mkdir(config.scope.workspaceRoot, { recursive: true }), mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
    await writeFile(join(bankRoot, "tasks.txt"), "benchmark/crypto/First\nbenchmark/misc/Second\n");
    await writeFile(join(first, "chall.py"), "print('first')\n");
    await writeFile(join(second, "input.txt"), "second\n");
    config.questionBank = { enabled: true, root: bankRoot, listFiles: ["tasks.txt"], maxQuestions: 20 };

    const bank = new QuestionBank(config.questionBank);
    const progress = new QuestionBankProgressStore(config);
    const [firstQuestion] = await bank.load();
    const now = new Date().toISOString();
    await progress.recordCompleted(firstQuestion!, {
      ...({} as RunState),
      id: "existing-question-bank-run",
      status: "completed",
      submission: "existing-answer-not-stored",
      updatedAt: now,
      task: { task: "existing", attachments: [], metadata: { source: "question-bank", questionId: firstQuestion!.id } },
    });

    let nextRun = 0;
    const states = new Map<string, RunState>();
    const manualJobs = new ManualJobManager({
      runManager: {
        start: (task) => {
          const id = `00000000-0000-4000-8000-${String(++nextRun).padStart(12, "0")}`;
          states.set(id, {
            ...({} as RunState),
            id,
            status: "completed",
            phase: "done",
            task: { task: task.task, attachments: [], metadata: task.metadata ?? {} },
            createdAt: now,
            updatedAt: now,
            submission: "new-answer-not-stored",
            turns: 1,
            toolCalls: 1,
          });
          return id;
        },
        wait: async (id) => states.get(id) as RunState,
        stop: () => true,
      },
    });
    const running = await startApiServer(config, { manualJobs, questionBank: bank, questionBankProgress: progress });
    try {
      const listed = await fetch(`${running.url}/v1/question-bank`);
      expect(listed.status).toBe(200);
      const listedBody = await listed.json() as { questionBank: {
        count: number;
        solvedCount: number;
        pendingCount: number;
        questions: Array<{ id: string; status: string }>;
      } };
      expect(listedBody.questionBank).toMatchObject({ count: 2, solvedCount: 1, pendingCount: 1 });
      expect(listedBody.questionBank.questions).toMatchObject([
        { id: "benchmark/crypto/First", status: "solved" },
        { id: "benchmark/misc/Second", status: "pending" },
      ]);

      const started = await fetch(`${running.url}/v1/question-bank/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 1, writeup: false }),
      });
      expect(started.status).toBe(202);
      const body = await started.json() as { job: { id: string; skipBlocked: boolean } };
      expect(body.job).toMatchObject({ total: 1, skipBlocked: true, concurrency: 1, transientRetryLimit: 2 });
      await vi.waitFor(() => {
        expect(manualJobs.get(body.job.id)).toMatchObject({ status: "completed", completed: 1, skipped: 0, failed: 0 });
      });
      expect([...states.values()].map((state) => state.task.metadata.category)).toEqual(["misc"]);

      await vi.waitFor(async () => {
        const refreshed = await fetch(`${running.url}/v1/question-bank`);
        const payload = await refreshed.json() as { questionBank: { solvedCount: number; pendingCount: number } };
        expect(payload.questionBank).toMatchObject({ solvedCount: 2, pendingCount: 0 });
      });
      const repeated = await fetch(`${running.url}/v1/question-bank/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ writeup: false }),
      });
      expect(repeated.status).toBe(400);
    } finally {
      await running.close();
    }
  });

  it("starts and reports a bounded Arena job through the protected API", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-arena-"));
    roots.push(root);
    const config = testConfig(root);
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["*.nssctf.cn:*"];
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    process.env.XUANSHU_TEST_API_KEY = "model-test-key";
    process.env.XUANSHU_TEST_ARENA_TOKEN = "arena-test-token";
    const now = new Date().toISOString();
    const state: RunState = {
      id: "arena-run",
      status: "completed",
      phase: "done",
      task: { task: "test", attachments: [], metadata: { category: "web" } },
      createdAt: now,
      updatedAt: now,
      findings: [],
      lessons: [],
      hypotheses: [],
      strategyRevisions: [],
      strategyRevisionRequired: false,
      sandboxNamespace: "arena-run",
      scratchRoot: join(root, "scratch", "runs", "arena-run"),
      workspaceMode: "configured",
      appliedExperienceIds: [],
      turns: 4,
      toolCalls: 7,
      imageObservations: 0,
      httpRequests: 1,
      tcpSessions: 0,
      actionsSinceCheckpoint: 0,
      repeatedActions: {},
    };
    const arenaJobs = new ArenaJobManager(config, {
      clientFactory: () => ({}) as ArenaClient,
      readAgent: async () => ({ rating: 1000 }),
      ensureSandbox: async () => ({ owned: false, close: async () => {} }),
      writeReport: async () => join(root, "evaluation.json"),
      solveOnce: async () => ({
        attemptId: 7,
        state,
        evaluation: {
          attemptId: 7,
          category: "web",
          outcome: "solved",
          settled: true,
          correct: true,
          flagCandidateFound: true,
          submissionAttempts: 1,
          runCount: 1,
          attachmentCount: 0,
          reused: false,
          run: { id: state.id, status: state.status, turns: state.turns, toolCalls: state.toolCalls },
        },
      }),
    });
    const running = await startApiServer(config, { arenaJobs });
    try {
      const status = await fetch(`${running.url}/v1/arena/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ readiness: { ready: true } });

      const started = await fetch(`${running.url}/v1/arena/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: false }),
      });
      expect(started.status).toBe(202);
      const startedBody = await started.json() as { job: { id: string; options: { continuous: boolean } } };
      expect(startedBody.job.options.continuous).toBe(false);
      await vi.waitFor(async () => {
        const result = await fetch(`${running.url}/v1/arena/jobs/${startedBody.job.id}`);
        expect(await result.json()).toMatchObject({ job: { status: "completed", summary: { solved: 1 } } });
      });
    } finally {
      await running.close();
    }
  });

  it("defaults Arena jobs to continuous mode and validates the stop contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-arena-continuous-"));
    roots.push(root);
    const config = testConfig(root);
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["*.nssctf.cn:*"];
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    process.env.XUANSHU_TEST_API_KEY = "model-test-key";
    process.env.XUANSHU_TEST_ARENA_TOKEN = "arena-test-token";
    const arenaJobs = new ArenaJobManager(config, {
      clientFactory: () => ({}) as ArenaClient,
      readAgent: async () => ({ rating: 1000 }),
      ensureSandbox: async () => ({ owned: false, close: async () => {} }),
      writeReport: async () => join(root, "evaluation.json"),
      solveOnce: async (_config, _client, options) => await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    });
    const running = await startApiServer(config, { arenaJobs });
    try {
      const invalid = await fetch(`${running.url}/v1/arena/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0, continuous: "yes" }),
      });
      expect(invalid.status).toBe(400);

      const started = await fetch(`${running.url}/v1/arena/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxAttempts: 1, autoSubmit: true, idleSeconds: 0 }),
      });
      expect(started.status).toBe(202);
      const startedBody = await started.json() as { job: { id: string; options: { continuous: boolean } } };
      expect(startedBody.job.options.continuous).toBe(true);

      const stopped = await fetch(`${running.url}/v1/arena/jobs/${startedBody.job.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(stopped.status).toBe(202);
      await vi.waitFor(async () => {
        const result = await fetch(`${running.url}/v1/arena/jobs/${startedBody.job.id}`);
        expect(await result.json()).toMatchObject({ job: { status: "aborted", options: { continuous: true } } });
      });
    } finally {
      await running.close();
    }
  });

  it("streams persisted run events in order and resumes after Last-Event-ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-sse-")); roots.push(root); const config = testConfig(root); await mkdir(config.scope.workspaceRoot, { recursive: true });
    const runId = "11111111-1111-4111-8111-111111111111"; const runRoot = join(config.runtime.artifactRoot, runId); await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "state.json"), JSON.stringify({ id: runId, status: "completed" }), "utf8"); const audit = new AuditChain(join(runRoot, "audit.jsonl"), runId); await audit.append("run.started", { status: "running" }); await audit.append("policy.decision", { allowed: false, reason: "OUT_OF_SCOPE" });
    const running = await startApiServer(config);
    try {
      const response = await fetch(`${running.url}/v1/runs/${runId}/events`, { headers: { "Last-Event-ID": `${runId}:1` } });
      expect(response.status).toBe(200); const body = await response.text(); expect(body).toContain(`id: ${runId}:2`); expect(body).toContain("policy.decision"); expect(body).not.toContain("run.started");
    } finally { await running.close(); }
  });

  it("isolates streams by run and returns 404 for unknown runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-sse-isolation-")); roots.push(root); const config = testConfig(root); await mkdir(config.scope.workspaceRoot, { recursive: true }); const ids = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    for (const [index, runId] of ids.entries()) { const runRoot = join(config.runtime.artifactRoot, runId); await mkdir(runRoot, { recursive: true }); await writeFile(join(runRoot, "state.json"), JSON.stringify({ id: runId, status: "completed" }), "utf8"); const audit = new AuditChain(join(runRoot, "audit.jsonl"), runId); await audit.append("fixture.event", { marker: `run-${index}` }); }
    const running = await startApiServer(config);
    try { const response = await fetch(`${running.url}/v1/runs/${ids[0]}/events`); const body = await response.text(); expect(body).toContain("run-0"); expect(body).not.toContain("run-1"); expect((await fetch(`${running.url}/v1/runs/not-a-real-run/events`)).status).toBe(404); } finally { await running.close(); }
  });
});

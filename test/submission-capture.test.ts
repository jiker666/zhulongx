import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit.js";
import type { Executor } from "../src/executor.js";
import { createToolSet } from "../src/tools.js";
import type { RunState, ToolResult } from "../src/types.js";
import { testConfig } from "./helpers.js";

function runState(root: string): RunState {
  const now = new Date().toISOString();
  return {
    id: "submission-capture",
    status: "running",
    phase: "exploration",
    task: { task: "submit the verified flag", attachments: [], metadata: {} },
    createdAt: now,
    updatedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "submission-capture",
    scratchRoot: join(root, "scratch"),
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

// The safety net under test observes only executor outputs, so a canned
// executor stands in for the real sandbox.
function fakeExecutor(stdout: string, stderr = "", exitCode = 0): Executor {
  const timestamp = Date.now();
  return {
    id: "fake",
    kind: "local",
    networkAccess: true,
    exec: async () => ({ exitCode, stdout, stderr, timedOut: false, startedAt: timestamp, finishedAt: timestamp }),
    readFile: async () => { throw new Error("unused"); },
    readFileBytes: async () => { throw new Error("unused"); },
    writeFile: async () => { throw new Error("unused"); },
    listDir: async () => { throw new Error("unused"); },
    stat: async () => { throw new Error("unused"); },
    health: async () => { throw new Error("unused"); },
    dispose: async () => {},
  } as unknown as Executor;
}

async function harness(root: string, executor?: Executor) {
  const config = testConfig(root);
  config.scope = { ...config.scope, mode: "controlled", allowedHosts: [] };
  const audit = new AuditChain(join(root, "audit.jsonl"), "submission-capture");
  const state = runState(root);
  const toolSet = createToolSet({
    state,
    scope: config.scope,
    runtime: config.runtime,
    audit,
    ...(executor ? { executor } : {}),
  });
  return { state, toolSet };
}

const SUBMIT_ARGS = (flag: string) => [
  "-s",
  "-X",
  "POST",
  "https://bench.example/openapi/v1/challenges/submit",
  "-H",
  "BENCHMARK_TOKEN: token",
  "-d",
  JSON.stringify({ unique_code: "b-03", flag }),
];

function toolText(result: ToolResult): string {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
}

describe("submission-verdict capture (run_command)", () => {
  it("banks a VERIFIED_FLAG finding when the platform accepts the submitted value", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root, fakeExecutor('{"unique_code":"b-03","correct":true,"awarded":300,"correct_flag_count":3,"total_flag_count":4}'));
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "run_command");
      const result = await tool!.execute("call-1", { program: "curl", args: SUBMIT_ARGS("flag{c0ffee-deadbeef}") }, new AbortController().signal);
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0]).toMatchObject({ title: "VERIFIED_FLAG: flag{c0ffee-deadbeef}", severity: "info", confidence: 1 });
      expect(state.phase).toBe("verification");
      expect(toolText(result)).toContain("recorded_finding=VERIFIED_FLAG: flag{c0ffee-deadbeef}");
      expect(toolText(result)).toContain("reuse it verbatim in finish_task");
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a duplicate 409 body as already-banked and records it too", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root, fakeExecutor('{"code":"duplicate","message":"flag already submitted and correct"}'));
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "run_command");
      await tool!.execute("call-1", { program: "curl", args: SUBMIT_ARGS("flag{dup-but-correct}") }, new AbortController().signal);
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0]).toMatchObject({ title: "VERIFIED_FLAG: flag{dup-but-correct}" });
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("banks a non-flag-shaped value submitted through an explicit flag field (c-03 numeric flag)", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root, fakeExecutor('{"correct":true,"awarded":100}'));
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "run_command");
      await tool!.execute("call-1", { program: "curl", args: SUBMIT_ARGS("16238303") }, new AbortController().signal);
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0]).toMatchObject({ title: "VERIFIED_FLAG: 16238303" });
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not bank a rejected verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root, fakeExecutor('{"correct":false,"awarded":0}'));
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "run_command");
      const result = await tool!.execute("call-1", { program: "curl", args: SUBMIT_ARGS("flag{rejected-value}") }, new AbortController().signal);
      expect(state.findings).toHaveLength(0);
      expect(toolText(result)).not.toContain("recorded_finding=");
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips ambiguous commands carrying multiple unbanked candidate values", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root, fakeExecutor('{"correct":true,"awarded":300}'));
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "run_command");
      const script = `import requests\nfor flag in ["flag{aaa-bbbb}", "flag{ccc-dddd}"]:\n    requests.post("https://bench.example/submit", json={"flag": flag})\n`;
      await tool!.execute("call-1", { program: "python3", args: ["submit_batch.py"], stdin: script }, new AbortController().signal);
      expect(state.findings).toHaveLength(0);
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores flag-shaped shell tokens in commands that are not submissions (awk guard)", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    // The agent re-reads a saved platform response with awk; the output shows
    // a success verdict and the args contain BEGIN{FS=","} — a word{...} token
    // that must never be banked as a flag.
    const { state, toolSet } = await harness(root, fakeExecutor('{"correct":true,"awarded":300}'));
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "run_command");
      await tool!.execute("call-1", { program: "awk", args: ['BEGIN{FS=","}{print$1}', "resp.json"] }, new AbortController().signal);
      expect(state.findings).toHaveLength(0);
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not double-bank a value the agent already recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root, fakeExecutor('{"correct":true,"awarded":300}'));
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "run_command");
      await tool!.execute("call-1", { program: "curl", args: SUBMIT_ARGS("flag{already-recorded}") }, new AbortController().signal);
      await tool!.execute("call-2", { program: "curl", args: SUBMIT_ARGS("flag{already-recorded}") }, new AbortController().signal);
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0]).toMatchObject({ title: "VERIFIED_FLAG: flag{already-recorded}" });
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("submission-verdict capture (http_request)", () => {
  it("banks the accepted value from a direct HTTP submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"correct":true,"awarded":500,"correct_flag_count":1,"total_flag_count":1}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const { state, toolSet } = await harness(root);
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "http_request");
      const result = await tool!.execute("call-1", {
        method: "POST",
        url: `http://127.0.0.1:${address.port}/openapi/v1/challenges/submit`,
        headers: { "BENCHMARK_TOKEN": "token" },
        body: JSON.stringify({ unique_code: "c-03", flag: "flag{net-verified-42}" }),
      }, new AbortController().signal);
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0]).toMatchObject({ title: "VERIFIED_FLAG: flag{net-verified-42}" });
      expect(toolText(result)).toContain("recorded_finding=VERIFIED_FLAG: flag{net-verified-42}");
    } finally {
      await toolSet.cleanup();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("finish_task verified-value backfill", () => {
  it("fills an absent submission from the most recent VERIFIED_FLAG finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root);
    try {
      state.findings.push({
        id: "finding-1",
        title: "VERIFIED_FLAG: flag{backfill-777}",
        severity: "info",
        confidence: 1,
        description: "platform accepted this exact value",
        evidence: ["submit response correct=true"],
      });
      const tool = toolSet.tools.find((candidate) => candidate.name === "finish_task");
      await tool!.execute("call-f1", {
        status: "completed",
        summary: "flag banked via platform self-submit",
        evidence: [],
        remainingRisks: [],
        nextSteps: [],
        confidence: 1,
        verification: ["submit endpoint returned correct=true"],
        independentlyVerified: true,
      }, new AbortController().signal);
      expect(state.submission).toBe("flag{backfill-777}");
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never overrides an explicit agent submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-submission-capture-"));
    const { state, toolSet } = await harness(root);
    try {
      state.findings.push({
        id: "finding-1",
        title: "VERIFIED_FLAG: flag{stale-value}",
        severity: "info",
        confidence: 1,
        description: "banked earlier in the run",
        evidence: ["submit response correct=true"],
      });
      const tool = toolSet.tools.find((candidate) => candidate.name === "finish_task");
      await tool!.execute("call-f1", {
        status: "completed",
        summary: "done",
        submission: "agent-explicit-choice",
        evidence: [],
        remainingRisks: [],
        nextSteps: [],
        confidence: 1,
        verification: ["verified twice"],
        independentlyVerified: true,
      }, new AbortController().signal);
      expect(state.submission).toBe("agent-explicit-choice");
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});

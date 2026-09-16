import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/executor.js";
import { replayVerdictEligible, replayVerifySubmission, replayableVerificationCommands } from "../src/verifier.js";

const CANDIDATE = "flag{replay-ok}";

function toolResultLine(toolCallId: string, program: string, args: string[], output: string, isError = false): string {
  return JSON.stringify({
    sequence: 1,
    timestamp: new Date().toISOString(),
    runId: "r1",
    type: "tool.result",
    data: {
      toolCallId,
      toolName: "run_command",
      args: { program, args, cwd: "scratch" },
      isError,
      content: [{ type: "text", text: `exitCode=0\nstdout:\n${output}\nstderr:` }],
      details: {},
    },
    previousHash: "0".repeat(64),
    hash: "1".repeat(64),
  });
}

function fakeExecutor(outputs: string[], fail = false): Executor["exec"] {
  let call = 0;
  return async () => {
    if (fail) throw new Error("sandbox unavailable");
    const result: Awaited<ReturnType<Executor["exec"]>> = {
      exitCode: 0,
      signal: null,
      stdout: outputs[Math.min(call, outputs.length - 1)] ?? "",
      stderr: "",
      stdoutBase64: "",
      stderrBase64: "",
      truncated: false,
      timedOut: false,
      durationMs: 1,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    call += 1;
    return result;
  };
}

async function auditFixture(root: string): Promise<string> {
  const path = join(root, "audit.jsonl");
  const lines = [
    JSON.stringify({ type: "run.started", data: {} }),
    toolResultLine("t1", "python3", ["solve.py"], `intermediate noise\n${CANDIDATE}\ndone`),
    toolResultLine("t2", "python3", ["failed.py"], "boom", true),
    toolResultLine("t3", "python3", ["verify.py"], `recheck:\n${CANDIDATE}`),
    JSON.stringify({ type: "run.settled", data: {} }),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

describe("replay verifier", () => {
  it("collects only successful candidate-bearing run_command calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-verifier-"));
    try {
      const path = await auditFixture(root);
      const sources = await replayableVerificationCommands(path, CANDIDATE);
      expect(sources.map((source) => source.program)).toEqual(["python3", "python3"]);
      expect(sources[0]?.args).toEqual(["solve.py"]);
      expect(await replayableVerificationCommands(path, "flag{missing}")).toEqual([]);
      expect(await replayableVerificationCommands(join(root, "absent.jsonl"), CANDIDATE)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports reproduced when a fresh process re-derives the candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-verifier-"));
    try {
      const path = await auditFixture(root);
      const verdict = await replayVerifySubmission({
        auditPath: path,
        candidate: CANDIDATE,
        exec: fakeExecutor([`fresh run output ${CANDIDATE}`]),
        namespace: "r1",
        commandTimeoutMs: 2_000,
        maxOutputBytes: 16_384,
      });
      expect(verdict.verdict).toBe("reproduced");
      expect(verdict.replayed).toBe(2);
      expect(verdict.evidence.some((item) => item.includes("candidate reproduced"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports contradicted when replays no longer contain the candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-verifier-"));
    try {
      const path = await auditFixture(root);
      const verdict = await replayVerifySubmission({
        auditPath: path,
        candidate: CANDIDATE,
        exec: fakeExecutor(["completely different output"]),
        commandTimeoutMs: 2_000,
        maxOutputBytes: 16_384,
      });
      expect(verdict.verdict).toBe("contradicted");
      expect(verdict.replayed).toBe(2);
      expect(verdict.evidence.some((item) => item.includes("candidate absent"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unverifiable without replayable evidence or when the sandbox is down", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-verifier-"));
    try {
      const path = await auditFixture(root);
      const noEvidence = await replayVerifySubmission({
        auditPath: path,
        candidate: "flag{other}",
        exec: fakeExecutor([]),
        commandTimeoutMs: 2_000,
        maxOutputBytes: 16_384,
      });
      expect(noEvidence.verdict).toBe("unverifiable");
      expect(noEvidence.replayed).toBe(0);
      expect(noEvidence.evidence[0]).toContain("nothing deterministic to replay");

      const sandboxDown = await replayVerifySubmission({
        auditPath: path,
        candidate: CANDIDATE,
        exec: fakeExecutor([], true),
        commandTimeoutMs: 2_000,
        maxOutputBytes: 16_384,
      });
      expect(sandboxDown.verdict).toBe("unverifiable");
      expect(sandboxDown.evidence.every((item) => item.includes("replay failed"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gates eligibility on offline categories with metadata override", () => {
    expect(replayVerdictEligible({ metadata: { category: "crypto" } })).toBe(true);
    expect(replayVerdictEligible({ metadata: { category: "Reverse" } })).toBe(true);
    expect(replayVerdictEligible({ metadata: { category: "pwn" } })).toBe(true);
    expect(replayVerdictEligible({ metadata: {} })).toBe(true);
    expect(replayVerdictEligible({ metadata: { category: "web" } })).toBe(false);
    expect(replayVerdictEligible({ metadata: { category: "osint" } })).toBe(false);
    expect(replayVerdictEligible({ metadata: { category: "ai/ml" } })).toBe(false);
    expect(replayVerdictEligible({ metadata: { category: "web", verifier: "replay" } })).toBe(true);
    expect(replayVerdictEligible({ metadata: { category: "crypto", verifier: "off" } })).toBe(false);
  });
});

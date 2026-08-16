import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxExecutor } from "../src/executor.js";
import { startSandboxServer } from "../src/sandbox.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createExecutor() {
  const root = await mkdtemp(join(tmpdir(), "xuan-executor-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const scratchRoot = join(root, "scratch");
  await Promise.all([mkdir(workspaceRoot), mkdir(scratchRoot)]);
  const socketPath = process.platform === "win32" ? "tcp://127.0.0.1:0" : join(root, "sandbox.sock");
  const server = await startSandboxServer({
    socketPath,
    workspaceRoot,
    scratchRoot,
    allowedPrograms: ["node"],
    defaultTimeoutMs: 500,
    maxOutputBytes: 64,
    network: "none",
  });
  closers.push(server.close);
  return {
    executor: new SandboxExecutor({ id: "test-executor", socketPath: server.endpoint, connectTimeoutMs: 1000, workspaceRoot, scratchRoot }),
    workspaceRoot,
  };
}

describe("SandboxExecutor", () => {
  it("normalizes health and bounded command results", async () => {
    const { executor } = await createExecutor();
    expect(await executor.health()).toMatchObject({ status: "online", kind: "sandbox", networkAccess: false, network: "none" });

    const result = await executor.exec({ program: "node", args: ["-e", "process.stdout.write('x'.repeat(200))"] });
    expect(result).toMatchObject({ exitCode: 0, truncated: true, timedOut: false });
    expect(result.stdout).toHaveLength(64);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
  });

  it("provides bounded file operations and rejects path or root escapes", async () => {
    const { executor, workspaceRoot } = await createExecutor();
    await writeFile(join(workspaceRoot, "evidence.txt"), "authorized-evidence");
    expect(await executor.listDir({ root: "workspace", path: "." }, { depth: 1, maxEntries: 10 })).toContainEqual({ path: "evidence.txt", kind: "file" });
    const read = await executor.readFile({ root: "workspace", path: "evidence.txt" }, { offset: 0, maxBytes: 10 });
    expect(Buffer.from(read.bytes).toString()).toBe("authorized");
    expect(read.truncated).toBe(true);
    await expect(executor.readFileBytes({ root: "workspace", path: "../outside" }, 10)).rejects.toThrow();
    await expect(executor.writeFile({ root: "workspace", path: "no.txt" }, Buffer.from("x"), { maxBytes: 10 })).rejects.toThrow("restricted to scratch");

    await executor.writeFile({ root: "scratch", path: "result.txt" }, Buffer.from("ok"), { maxBytes: 4 });
    await expect(executor.writeFile({ root: "scratch", path: "result.txt" }, Buffer.from("toolong"), { append: true, maxBytes: 4 })).rejects.toThrow("budget exceeded");
    expect(Buffer.from((await executor.readFileBytes({ root: "scratch", path: "result.txt" }, 4)).bytes).toString()).toBe("ok");
  });

  it("accepts AbortSignal for blocking operations", async () => {
    const { executor } = await createExecutor();
    const controller = new AbortController();
    const running = executor.exec({ program: "node", args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 5000 }, controller.signal);
    controller.abort(new Error("cancelled by test"));
    await expect(running).rejects.toThrow();
  });
});

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxClient, startSandboxServer } from "../src/sandbox.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sandbox(maxOutputBytes = 256, defaultTimeoutMs = process.platform === "win32" ? 2000 : 500) {
  const root = await mkdtemp(join(tmpdir(), "xuan-sandbox-"));
  roots.push(root);
  const workspaceRoot = join(root, "input");
  const scratchRoot = join(root, "work");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(scratchRoot, { recursive: true });
  const socketPath = process.platform === "win32" ? "tcp://127.0.0.1:0" : join(root, "sandbox.sock");
  const running = await startSandboxServer({
    socketPath,
    workspaceRoot,
    scratchRoot,
    allowedPrograms: ["node"],
    defaultTimeoutMs,
    maxOutputBytes,
    network: "none",
  });
  closers.push(running.close);
  return { client: new SandboxClient(running.endpoint, process.platform === "win32" ? 5000 : 500), workspaceRoot, scratchRoot };
}

describe("CTF sandbox", () => {
  it("supports a loopback TCP control endpoint for a network-isolated local container", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-sandbox-tcp-"));
    roots.push(root);
    const workspaceRoot = join(root, "input");
    const scratchRoot = join(root, "work");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(scratchRoot, { recursive: true });
    const running = await startSandboxServer({
      socketPath: "tcp://127.0.0.1:0",
      workspaceRoot,
      scratchRoot,
      allowedPrograms: ["node"],
      defaultTimeoutMs: 500,
      maxOutputBytes: 256,
      network: "internal-only",
    });
    closers.push(running.close);

    const health = await new SandboxClient(running.endpoint, process.platform === "win32" ? 5000 : 500).health();

    expect(running.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
    expect(health).toMatchObject({ status: "ok", network: "internal-only" });
  });

  it("executes structured argv without shell parsing", async () => {
    const { client } = await sandbox();
    const result = await client.execute({
      program: "node",
      args: ["-e", "console.log(process.argv[1])", "alpha && echo beta"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("alpha && echo beta\n");
  });

  it("allows input reads, rejects absolute path escapes, and reports no-network profile", async () => {
    const { client, workspaceRoot } = await sandbox();
    await writeFile(join(workspaceRoot, "sample.txt"), "workspace-demo\n", "utf8");

    const health = await client.health();
    expect(health.network).toBe("none");

    const read = await client.execute({
      program: "node",
      args: [
        "-e",
        "const fs=require('fs'); process.stdout.write(fs.readFileSync(process.argv[1]))",
        join(workspaceRoot, "sample.txt"),
      ],
    });
    expect(read.stdout).toBe("workspace-demo\n");

    await expect(
      client.execute({
        program: "node",
        args: ["-e", "console.log('nope')", "/etc/passwd"],
      }),
    ).rejects.toThrow("outside sandbox roots");
  });

  it("bounds output and terminates timed-out commands", async () => {
    const { client } = await sandbox(16, process.platform === "win32" ? 1000 : 100);

    const output = await client.execute({
      program: "node",
      args: ["-e", "process.stdout.write('a'.repeat(1000))"],
    });
    expect(output.stdout).toHaveLength(16);
    expect(output.truncated).toBe(true);

    const timeout = await client.execute({
      program: "node",
      args: ["-e", "setTimeout(() => {}, 2000)"],
    });
    expect(timeout.timedOut).toBe(true);
  }, 20_000);

  it("isolates scratch working directories and HOME for every run namespace", async () => {
    const { client } = await sandbox();
    await client.execute({
      namespace: "run-alpha",
      program: "node",
      args: ["-e", "require('fs').writeFileSync('evidence.txt', process.env.HOME)"],
    });

    const alpha = await client.execute({
      namespace: "run-alpha",
      program: "node",
      args: ["-e", "process.stdout.write(require('fs').readFileSync('evidence.txt'))"],
    });
    const beta = await client.execute({
      namespace: "run-beta",
      program: "node",
      args: ["-e", "process.stdout.write(String(require('fs').existsSync('evidence.txt')))"],
    });

    expect(alpha.stdout).toContain("run-alpha");
    expect(beta.stdout).toBe("false");
    await expect(
      client.execute({ namespace: "../escape", program: "node", args: ["-e", "console.log('x')"] }),
    ).rejects.toThrow("namespace");
  }, 20_000);

  it("relies on the read-only challenge mount for workspace writes", async () => {
    const { client, workspaceRoot } = await sandbox();
    if (process.platform === "win32") {
      await expect(
        client.execute({ program: "node", args: ["-e", "console.log('nope')", "C:\\outside\\new.txt"] }),
      ).rejects.toThrow("outside sandbox roots");
      return;
    }
    await chmod(workspaceRoot, 0o555);

    const result = await client.execute({
      program: "node",
      args: [
        "-e",
        "const fs=require('fs'); fs.writeFileSync(process.argv[1], 'x')",
        join(workspaceRoot, "new.txt"),
      ],
    });

    expect(result.exitCode).not.toBe(0);
  });
});

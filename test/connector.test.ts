import { describe, expect, it } from "vitest";
import { ConnectorBroker, ConnectorExecutor } from "../src/connector.js";

function broker() { return new ConnectorBroker([{ id: "lab", capabilities: ["structured-exec", "workspace-read", "scratch-write", "abort"], allowedPrograms: ["file"], networkAccess: false, heartbeatTimeoutMs: 1_000, maxPendingTasks: 4, maxOutputBytes: 8 }]); }

describe("ConnectorBroker", () => {
  it("requires operator configuration and supports reverse registration/heartbeat", () => {
    const value = broker(); expect(() => value.register("unknown", "host-1")).toThrow("operator-configured");
    const connected = value.register("lab", "host-1"); expect(connected).toMatchObject({ status: "online", generation: 1 });
    expect(value.heartbeat("lab", "host-1", 1).status).toBe("online");
    expect(() => value.heartbeat("lab", "old", 1)).toThrow("Stale");
  });

  it("leases bounded tasks and rejects stale results after rebinding", async () => {
    const value = broker(); value.register("lab", "host-1");
    const result = value.dispatch("lab", { type: "exec", input: { program: "file", args: ["sample"], maxOutputBytes: 8 } });
    const task = value.claim("lab", "host-1", 1, 5_000)!; expect(task.operation.type).toBe("exec");
    value.register("lab", "host-2"); await expect(result).rejects.toThrow("rebound");
    expect(() => value.resolve("lab", "host-1", 1, task.id, task.leaseGeneration, { result: {} })).toThrow("Stale connector connection");
  });

  it("bounds outputs, restricts programs and accepts AbortSignal", async () => {
    const value = broker(); value.register("lab", "host-1");
    await expect(value.dispatch("lab", { type: "exec", input: { program: "curl", args: [] } })).rejects.toThrow("operator-allowed");
    const output = value.dispatch("lab", { type: "exec", input: { program: "file", args: [] } }); const task = value.claim("lab", "host-1", 1, 5_000)!;
    value.resolve("lab", "host-1", 1, task.id, task.leaseGeneration, { result: { exitCode: 0, stdout: "123456789", stderr: "secret: no", truncated: false } });
    await expect(output).resolves.toMatchObject({ stdout: "12345678", stderr: "", truncated: true });
    const controller = new AbortController(); const pending = value.dispatch("lab", { type: "stat", path: { root: "workspace", path: "sample" } }, controller.signal); controller.abort(new Error("stop")); await expect(pending).rejects.toThrow("stop");
  });

  it("implements the unified Executor contract", async () => {
    const value = broker(); value.register("lab", "host-1"); const executor = new ConnectorExecutor("lab", value);
    const health = await executor.health(); expect(health).toMatchObject({ kind: "connector", status: "online", networkAccess: false });
    const call = executor.stat({ root: "workspace", path: "sample" }); const task = value.claim("lab", "host-1", 1, 5_000)!;
    value.resolve("lab", "host-1", 1, task.id, task.leaseGeneration, { result: { path: "sample", size: 4, kind: "file", symbolicLink: false } });
    await expect(call).resolves.toMatchObject({ path: "sample", size: 4 });
  });
});

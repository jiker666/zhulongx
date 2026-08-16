import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/permissions.js";

const request = (toolName = "run_command") => ({
  sessionId: "run-1",
  toolCallId: `call-${toolName}`,
  toolName,
  args: { program: "file" },
  risk: { level: "execute" as const, summary: "Execute an allowlisted command", requiresApproval: true },
});

describe("PermissionBroker", () => {
  it("auto-resolves under never policy", async () => {
    const broker = new PermissionBroker("never");
    await expect(broker.authorize(request())).resolves.toMatchObject({ decision: "approve_once", source: "policy" });
    expect(broker.list()).toEqual([]);
  });

  it("waits for an operator and remembers session approval", async () => {
    const broker = new PermissionBroker("on-request", 5_000);
    const pending = broker.authorize(request());
    const [item] = broker.list();
    expect(item).toMatchObject({ sessionId: "run-1", toolName: "run_command", risk: "execute" });
    expect(broker.resolve(item!.id, "approve_session")).toMatchObject({ decision: "approve_session", source: "operator" });
    await expect(pending).resolves.toMatchObject({ decision: "approve_session" });
    await expect(broker.authorize({ ...request(), toolCallId: "call-2" })).resolves.toMatchObject({ decision: "approve_session", source: "session" });
  });

  it("denies and removes pending requests on abort", async () => {
    const broker = new PermissionBroker("always", 5_000);
    const controller = new AbortController();
    const pending = broker.authorize(request(), controller.signal);
    controller.abort(new Error("operator stopped run"));
    await expect(pending).resolves.toMatchObject({ decision: "deny", source: "abort" });
    expect(broker.list()).toEqual([]);
  });

  it("bounds pending requests", async () => {
    const broker = new PermissionBroker("always", 5_000, 1);
    const first = broker.authorize(request("first"));
    await expect(broker.authorize(request("second"))).resolves.toMatchObject({ decision: "deny", source: "policy" });
    broker.cancelSession("run-1");
    await expect(first).resolves.toMatchObject({ decision: "deny", source: "abort" });
  });
});

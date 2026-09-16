import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startApiServer } from "../src/server.js";
import { DisclosureLedger } from "../src/disclosure-ledger.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.XUANSHU_TEST_SERVER_TOKEN;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("disclosure ledger", () => {
  it("classifies, persists, windows, and dedupes contamination disclosures", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-disclosure-"));
    roots.push(root);
    const ledger = new DisclosureLedger(root);

    const record = await ledger.disclose({
      runId: "3b0eec9c",
      taskId: "passkey_vault",
      reason: "hardcoded_solution",
      detail: "Flag uuid minted from the old manual-upload staging filename; exists in no challenge artifact.",
      disclosedBy: "operator",
    });
    expect(record.runId).toBe("3b0eec9c");
    expect(record.reason).toBe("hardcoded_solution");

    // Same record again → deduped, not a second row.
    const again = await ledger.disclose({
      runId: "3b0eec9c",
      taskId: "passkey_vault",
      reason: "hardcoded_solution",
      detail: "Flag uuid minted from the old manual-upload staging filename; exists in no challenge artifact.",
    });
    expect(again.id).toBe(record.id);

    // Reason taxonomy is closed.
    await expect(ledger.disclose({ runId: "r2", reason: "cheating", detail: "made up class" })).rejects.toThrow(/reason must be one of/);
    // A run or task anchor is mandatory.
    await expect(ledger.disclose({ reason: "targeted_method", detail: "no anchor target" })).rejects.toThrow(/runId or taskId/);
    // Detail is mandatory evidence text.
    await expect(ledger.disclose({ runId: "r3", reason: "external_memory", detail: "   " })).rejects.toThrow(/detail/);

    // Fresh instance reads persisted state; window filtering works.
    const reloaded = new DisclosureLedger(root);
    const all = await reloaded.list();
    expect(all.total).toBe(1);
    expect(all.items[0]!.detail).toContain("staging filename");
    const empty = await reloaded.list(0);
    expect(empty.total).toBe(0);
    expect((await reloaded.forRun("3b0eec9c"))).toHaveLength(1);
    expect(await reloaded.forRun("missing")).toHaveLength(0);
  });

  it("serves disclosures over the REST API", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-disclosure-api-"));
    roots.push(root);
    const config = testConfig(root);
    process.env.XUANSHU_TEST_SERVER_TOKEN = "test-token";
    const running = await startApiServer(config, { frontendRoot: join(root, "missing-frontend") });
    try {
      const created = await fetch(`${running.url}/v1/disclosures`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-abc", reason: "targeted_method", detail: "Solver only works for this exact challenge instance." }),
      });
      expect(created.status).toBe(201);

      const unauthenticated = await fetch(`${running.url}/v1/disclosures`);
      expect(unauthenticated.status).toBe(401);

      const listed = await (await fetch(`${running.url}/v1/disclosures`, { headers: { authorization: "Bearer test-token" } })).json() as {
        total: number;
        items: Array<{ runId: string; reason: string }>;
        reasonLabels: Record<string, string>;
      };
      expect(listed.total).toBe(1);
      expect(listed.items[0]!.runId).toBe("run-abc");
      expect(Object.keys(listed.reasonLabels)).toEqual(["hardcoded_solution", "targeted_method", "external_memory"]);

      const rejected = await fetch(`${running.url}/v1/disclosures`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-abc", reason: "nope", detail: "bad reason" }),
      });
      expect(rejected.status).toBe(400);
    } finally {
      await running.close();
    }
  });
});

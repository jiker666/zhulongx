import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit.js";
import { createToolSet } from "../src/tools.js";
import type { RunState } from "../src/types.js";
import { testConfig } from "./helpers.js";

function runState(root: string): RunState {
  const now = new Date().toISOString();
  return {
    id: "web-tools",
    status: "running",
    phase: "exploration",
    task: { task: "collect an authorized baseline", attachments: [], metadata: { category: "Web" } },
    createdAt: now,
    updatedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "web-tools",
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

describe("Web tools", () => {
  it("redacts cookie-bearing response headers from baseline results", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-web-tools-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "session=should-not-leak; HttpOnly",
        "x-public": "visible",
      });
      response.end("bounded body");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const config = testConfig(root);
    config.scope = {
      ...config.scope,
      mode: "controlled",
      allowedHosts: [`127.0.0.1:${address.port}`],
    };
    const toolSet = createToolSet({
      state: runState(root),
      scope: config.scope,
      runtime: config.runtime,
      audit: new AuditChain(join(root, "audit.jsonl"), "web-tools"),
    });
    try {
      const tool = toolSet.tools.find((candidate) => candidate.name === "web_collect_baseline");
      expect(tool).toBeDefined();
      const result = await tool!.execute("baseline", {
        url: `http://127.0.0.1:${address.port}/`,
      }, new AbortController().signal);
      const rendered = JSON.stringify(result);
      expect(rendered).toContain("x-public");
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain("should-not-leak");
    } finally {
      await toolSet.cleanup();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});

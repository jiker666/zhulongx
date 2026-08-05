import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit.js";
import { exportResources } from "../src/resource-export.js";
import { testConfig } from "./helpers.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "resource-export-"));
  const config = testConfig(root);
  config.scope.mode = "controlled";
  config.scope.allowedHosts = ["service.test"];
  config.runtime.maxActionsWithoutCheckpoint = 2;
  config.runtime.maxHttpRequests = 10;
  config.runtime.maxToolCalls = 30;
  const audit = new AuditChain(join(root, "audit.jsonl"), "export-test");
  return { root, config, audit };
}

function response(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resource export", () => {
  it("fetches and validates a token through the configured policy", async () => {
    const { config, audit } = await setup();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return response(200, { data: { token: "TOKEN1234" } });
    };
    const report = await exportResources({
      endpoint: "https://service.test/export",
      appId: "app-fixture",
      authKey: "secret-fixture",
      modelRoutes: { modelA: "routeA" },
      modelName: "modelA",
      resourceIds: ["id1"],
      scope: config.scope,
      runtime: config.runtime,
      audit,
      fetchImpl,
    });
    await audit.flush();
    expect(report.successful).toEqual([{ id: "id1", token: "TOKEN1234" }]);
    expect(report.failed).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("model")).toBe("routeA");
    expect(new URL(calls[0]?.url ?? "").searchParams.get("resource_id")).toBe("id1");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer secret-fixture");
    const auditText = await readFile(audit.path, "utf8");
    expect(auditText).not.toContain("secret-fixture");
  });

  it("retries with the required Accept sequence and stores the last error on failure", async () => {
    const { config, audit } = await setup();
    const accepts: string[] = [];
    let count = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      accepts.push(new Headers(init?.headers).get("accept") ?? "");
      count += 1;
      return count === 3 ? response(200, { data: { token: "ABCD5678" } }) : response(503, { error: "busy" });
    };
    const report = await exportResources({
      endpoint: "https://service.test/export",
      appId: "app-fixture",
      authKey: "secret-fixture",
      modelRoutes: { modelA: "routeA" },
      modelName: "modelA",
      resourceIds: ["id1"],
      scope: config.scope,
      runtime: config.runtime,
      audit,
      fetchImpl,
    });
    expect(accepts).toEqual(["application/json", "text/plain", "application/xml"]);
    expect(report.successful).toEqual([{ id: "id1", token: "ABCD5678" }]);
    expect(report.failed).toEqual([]);
  });

  it("honors the HTTP budget and reports remaining IDs without issuing requests", async () => {
    const { config, audit } = await setup();
    config.runtime.maxHttpRequests = 1;
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return response(503, "busy");
    };
    const report = await exportResources({
      endpoint: "https://service.test/export",
      appId: "app-fixture",
      authKey: "secret-fixture",
      modelRoutes: { modelA: "routeA" },
      modelName: "modelA",
      resourceIds: ["id1", "id2"],
      scope: config.scope,
      runtime: config.runtime,
      audit,
      fetchImpl,
    });
    expect(calls).toBe(1);
    expect(report.successful).toEqual([]);
    expect(report.failed).toHaveLength(2);
    expect(report.failed[0]?.reason).toContain("HTTP request budget exhausted");
    expect(report.warning).toBe("部分资源失败，请检查网络或联系管理员");
  });

  it("waits at least 500ms between request starts", async () => {
    const { config, audit } = await setup();
    const starts: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      starts.push(Date.now());
      return response(200, { data: { token: "TOKEN1234" } });
    };
    const report = await exportResources({
      endpoint: "https://service.test/export",
      appId: "app-fixture",
      authKey: "secret-fixture",
      modelRoutes: { modelA: "routeA" },
      modelName: "modelA",
      resourceIds: ["id1", "id2"],
      scope: config.scope,
      runtime: config.runtime,
      audit,
      fetchImpl,
    });
    expect(report.successful).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(500);
  }, 5_000);
});

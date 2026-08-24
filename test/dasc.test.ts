import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DascClient,
  extractDascExerciseHosts,
  scopeForDascExercise,
} from "../src/dasc.js";
import { PolicyEngine } from "../src/policy.js";
import { testConfig } from "./helpers.js";

const servers: Server[] = [];

afterEach(async () => {
  delete process.env.XUANSHU_TEST_DASC_ACCESS_KEY;
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function config(baseUrl: string) {
  const value = testConfig("/tmp/xuan-dasc");
  value.scope.mode = "controlled";
  value.scope.allowedHosts = ["127.0.0.1:*"];
  value.dasc = {
    enabled: true,
    baseUrl,
    accessKeyEnv: "XUANSHU_TEST_DASC_ACCESS_KEY",
    timeoutMs: 1000,
    maxResponseBytes: 4096,
    maxRequests: 3,
  };
  return value;
}

describe("DASC Agent API integration", () => {
  it("uses X-Agent-AccessKey, the documented prefix, and emits a bounded audit event", async () => {
    process.env.XUANSHU_TEST_DASC_ACCESS_KEY = "dasc-test-key";
    const baseUrl = await listen((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/slab-match/api/v1/agent/ctf/exercise-list");
      expect(request.headers["x-agent-accesskey"]).toBe("dasc-test-key");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "00000", data: [{ id: 1, name: "Web" }] }));
    });
    const events: unknown[] = [];
    const value = config(baseUrl);
    const client = new DascClient(value.dasc, value.scope, { onAudit: (event) => events.push(event) });

    await expect(client.exerciseList()).resolves.toEqual([{ id: 1, name: "Web" }]);
    expect(events).toEqual([expect.objectContaining({ type: "dasc.request", requestNumber: 1, allowed: true })]);
  });

  it("enforces request budget and scope policy before sending", async () => {
    process.env.XUANSHU_TEST_DASC_ACCESS_KEY = "dasc-test-key";
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "00000", data: {} }));
    });
    const value = config(baseUrl);
    const client = new DascClient({ ...value.dasc!, maxRequests: 1 }, value.scope);
    await client.overview();
    await expect(client.overview()).rejects.toThrow("request budget exhausted");
    expect(PolicyEngine.evaluateDascRequest(value.dasc, { ...value.scope, mode: "observe" }, "GET", `${baseUrl}/slab-match/api/v1/agent/answer-panel/overview`)).toMatchObject({
      allowed: false,
      reason: "DASC requests require scope.mode=controlled",
    });
  });

  it("supports abort signals and never expands scope for returned endpoints", async () => {
    process.env.XUANSHU_TEST_DASC_ACCESS_KEY = "dasc-test-key";
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"code":"00000","data":');
    });
    const value = config(baseUrl);
    const controller = new AbortController();
    const pending = new DascClient(value.dasc, value.scope).matchInfo(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");

    const exercise = {
      endpoints: [{ exposeIps: ["challenge.invalid"], ports: ["8080"] }],
    };
    expect(extractDascExerciseHosts(exercise)).toEqual(["challenge.invalid:8080"]);
    expect(() => scopeForDascExercise(value.scope, exercise)).toThrow("outside configured scope");
  });

  it("rejects non-success platform envelopes without exposing the access key", async () => {
    process.env.XUANSHU_TEST_DASC_ACCESS_KEY = "dasc-test-key";
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "A0001", message: "invalid access key dasc-test-key" }));
    });
    const value = config(baseUrl);
    await expect(new DascClient(value.dasc, value.scope).overview()).rejects.toThrow("DASC API code A0001: invalid access key [REDACTED]");
  });
});

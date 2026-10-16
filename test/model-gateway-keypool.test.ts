import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { keyPoolUpstreamsFromConfig, startModelGateway, type ModelGatewayUpstream } from "../src/model-gateway.js";

/**
 * R25 key-pool rotation: one shared endpoint, two account keys. The fake GLM
 * endpoint scripts responses per authorization header, so every test asserts
 * exactly which account served (or refused) each request and how rotation
 * rescued it before the self-funded rescue upstream was touched.
 */
interface CapturedRequest {
  authorization: string;
  body: Record<string, unknown>;
}

type UpstreamScript = (response: ServerResponse) => void;

const healthy: UpstreamScript = (response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, usage: { input_tokens: 10, output_tokens: 5 } }));
};

const quota429: UpstreamScript = (response) => {
  response.writeHead(429, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "insufficient balance" } }));
};

const auth401: UpstreamScript = (response) => {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
};

const KEY_A = "Bearer pool-key-a";
const KEY_B = "Bearer pool-key-b";
const FALLBACK_KEY = "Bearer fallback-secret";

let glmCaptured: CapturedRequest[] = [];
let dpskCaptured: CapturedRequest[] = [];
let glmScripts = new Map<string, UpstreamScript[]>();
let dpskScripts: UpstreamScript[] = [];
let glmServer: Server;
let dpskServer: Server;
let glmBase = "";
let dpskBase = "";

function captureOn(captured: CapturedRequest[]) {
  return (request: import("node:http").IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      captured.push({ authorization: String(request.headers.authorization ?? ""), body: JSON.parse(raw || "{}") as Record<string, unknown> });
      if (captured === glmCaptured) {
        (glmScripts.get(String(request.headers.authorization ?? ""))?.shift() ?? healthy)(response);
      } else {
        (dpskScripts.shift() ?? healthy)(response);
      }
    });
  };
}

beforeAll(async () => {
  glmServer = createServer(captureOn(glmCaptured));
  dpskServer = createServer(captureOn(dpskCaptured));
  for (const server of [glmServer, dpskServer]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  glmBase = `http://127.0.0.1:${(glmServer.address() as AddressInfo).port}`;
  dpskBase = `http://127.0.0.1:${(dpskServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all([glmServer, dpskServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

afterEach(() => {
  // Mutate in place: the capture handlers closed over these arrays at server
  // creation, so rebinding would leave assertions reading a different array.
  glmCaptured.length = 0;
  dpskCaptured.length = 0;
  glmScripts = new Map();
  dpskScripts = [];
});

const poolUpstreams: ModelGatewayUpstream[] = [
  { baseUrl: "", apiKey: "pool-key-a", modelId: "glm-5.3" },
  { baseUrl: "", apiKey: "pool-key-b", modelId: "glm-5.3" },
];

const fallbackUpstream: ModelGatewayUpstream = { baseUrl: "", apiKey: "fallback-secret", modelId: "dpsk-4.1" };

const minimalBody = { model: "leaked-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

type FailoverEvent = { type: string; data: Record<string, unknown> };

describe("ModelGateway key pool (R25)", () => {
  it("round-robins across the two accounts on success", async () => {
    const gateway = await startModelGateway({ keyPool: poolUpstreams.map((upstream) => ({ ...upstream, baseUrl: glmBase })) });
    try {
      gateway.setRoute("pool-rr", { upstream: { ...poolUpstreams[0]!, baseUrl: glmBase }, useKeyPool: true });
      expect((await postJson(gateway.routeUrl("pool-rr"), minimalBody)).status).toBe(200);
      expect((await postJson(gateway.routeUrl("pool-rr"), minimalBody)).status).toBe(200);
      expect(glmCaptured).toHaveLength(2);
      expect(new Set(glmCaptured.map((request) => request.authorization))).toEqual(new Set([KEY_A, KEY_B]));
      expect(dpskCaptured).toHaveLength(0);
    } finally {
      await gateway.stop();
    }
  });

  it("rotates to the sibling account inside the same request on a quota 429, before any rescue spend", async () => {
    glmScripts.set(KEY_B, [quota429]);
    const gateway = await startModelGateway({
      keyPool: poolUpstreams.map((upstream) => ({ ...upstream, baseUrl: glmBase })),
      fallbackUpstream: { ...fallbackUpstream, baseUrl: dpskBase },
    });
    try {
      gateway.setRoute("pool-rotate", { upstream: { ...poolUpstreams[0]!, baseUrl: glmBase }, useKeyPool: true });
      const response = await postJson(gateway.routeUrl("pool-rotate"), minimalBody);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      expect(glmCaptured.map((request) => request.authorization)).toEqual([KEY_B, KEY_A]);
      expect(dpskCaptured).toHaveLength(0);
    } finally {
      await gateway.stop();
    }
  });

  it("spends rescue quota only after the whole pool fails, bypasses the pool during cooldown, and probes it again after", async () => {
    const events: FailoverEvent[] = [];
    const gateway = await startModelGateway({
      keyPool: poolUpstreams.map((upstream) => ({ ...upstream, baseUrl: glmBase })),
      fallbackUpstream: { ...fallbackUpstream, baseUrl: dpskBase },
      failureThreshold: 2,
      cooldownMs: 200,
    });
    try {
      gateway.setRoute("pool-exhaust", {
        upstream: { ...poolUpstreams[0]!, baseUrl: glmBase },
        useKeyPool: true,
        emit: (event) => { events.push(event as FailoverEvent); },
      });
      const url = gateway.routeUrl("pool-exhaust");
      // Two requests, both accounts 429 each: rescue answers transparently.
      glmScripts.set(KEY_B, [quota429, quota429]);
      glmScripts.set(KEY_A, [quota429, quota429]);
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(glmCaptured).toHaveLength(4);
      expect(dpskCaptured).toHaveLength(2);
      expect(dpskCaptured.every((request) => request.authorization === FALLBACK_KEY)).toBe(true);
      expect(events.filter((event) => event.type === "model.failover").map((event) => event.data)).toEqual([
        expect.objectContaining({ reason: "pool exhausted", poolSize: 2, consecutiveFailures: 1 }),
        expect.objectContaining({ reason: "pool exhausted", poolSize: 2, consecutiveFailures: 2 }),
      ]);

      // Threshold reached: the very next request must skip the pool entirely.
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(glmCaptured).toHaveLength(4);
      expect(dpskCaptured).toHaveLength(3);

      // Cooldown expires: a refilled window is probed and traffic returns to GLM.
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(glmCaptured).toHaveLength(5);
      expect(dpskCaptured).toHaveLength(3);
    } finally {
      await gateway.stop();
    }
  });

  it("a dead credential (401) disables that account only; the sibling carries on alone", async () => {
    glmScripts.set(KEY_B, [auth401, auth401]);
    const gateway = await startModelGateway({
      keyPool: poolUpstreams.map((upstream) => ({ ...upstream, baseUrl: glmBase })),
      fallbackUpstream: { ...fallbackUpstream, baseUrl: dpskBase },
    });
    try {
      gateway.setRoute("pool-auth", { upstream: { ...poolUpstreams[0]!, baseUrl: glmBase }, useKeyPool: true });
      const url = gateway.routeUrl("pool-auth");
      // First request: B refuses with 401 (disabled), A answers.
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(glmCaptured.map((request) => request.authorization)).toEqual([KEY_B, KEY_A]);
      // Second request: B is skipped entirely — only A is tried.
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(glmCaptured.map((request) => request.authorization)).toEqual([KEY_B, KEY_A, KEY_A]);
      expect(dpskCaptured).toHaveLength(0);
    } finally {
      await gateway.stop();
    }
  });

  it("without a rescue upstream the pool's own 429 passes through for the SDK retry ladder", async () => {
    glmScripts.set(KEY_B, [quota429]);
    glmScripts.set(KEY_A, [quota429]);
    const gateway = await startModelGateway({ keyPool: poolUpstreams.map((upstream) => ({ ...upstream, baseUrl: glmBase })) });
    try {
      gateway.setRoute("pool-passthrough", { upstream: { ...poolUpstreams[0]!, baseUrl: glmBase }, useKeyPool: true });
      const response = await postJson(gateway.routeUrl("pool-passthrough"), minimalBody);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { type: "rate_limit_error" } });
      expect(glmCaptured).toHaveLength(2);
      expect(dpskCaptured).toHaveLength(0);
    } finally {
      await gateway.stop();
    }
  });

  it("routes without useKeyPool keep single-key behaviour even when a pool exists", async () => {
    glmScripts.set(KEY_B, [quota429]);
    const gateway = await startModelGateway({
      keyPool: poolUpstreams.map((upstream) => ({ ...upstream, baseUrl: glmBase })),
      fallbackUpstream: { ...fallbackUpstream, baseUrl: dpskBase },
    });
    try {
      gateway.setRoute("pool-optout", { upstream: { ...poolUpstreams[0]!, baseUrl: glmBase } });
      const response = await postJson(gateway.routeUrl("pool-optout"), minimalBody);
      expect(response.status).toBe(200);
      // The route's own template key (A) served; the pool never rotated to B.
      expect(glmCaptured.map((request) => request.authorization)).toEqual([KEY_A]);
      expect(dpskCaptured).toHaveLength(0);
    } finally {
      await gateway.stop();
    }
  });
});

describe("keyPoolUpstreamsFromConfig", () => {
  const envName = "XUANSHU_TEST_POOL_KEYS";
  const previous = process.env[envName];

  afterEach(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });

  it("stays inert without the pool env or with an empty list", () => {
    expect(keyPoolUpstreamsFromConfig(undefined)).toBeUndefined();
    expect(keyPoolUpstreamsFromConfig({ baseUrl: "https://glm.example", id: "glm-5.3", apiKeyPoolEnv: undefined })).toBeUndefined();
    delete process.env[envName];
    expect(keyPoolUpstreamsFromConfig({ baseUrl: "https://glm.example", id: "glm-5.3", apiKeyPoolEnv: envName })).toBeUndefined();
    process.env[envName] = " , ";
    expect(keyPoolUpstreamsFromConfig({ baseUrl: "https://glm.example", id: "glm-5.3", apiKeyPoolEnv: envName })).toBeUndefined();
  });

  it("splits, trims and dedupes the comma list onto the primary endpoint", () => {
    process.env[envName] = " key-a , key-b ,,key-a";
    expect(keyPoolUpstreamsFromConfig({ baseUrl: "https://glm.example/", id: "glm-5.3", apiKeyPoolEnv: envName })).toEqual([
      { baseUrl: "https://glm.example/", apiKey: "key-a", modelId: "glm-5.3" },
      { baseUrl: "https://glm.example/", apiKey: "key-b", modelId: "glm-5.3" },
    ]);
    process.env[envName] = "key-a";
    expect(keyPoolUpstreamsFromConfig({ baseUrl: "https://glm.example", id: "glm-5.3", apiKeyPoolEnv: envName, authScheme: "api-key" })).toEqual([
      { baseUrl: "https://glm.example", apiKey: "key-a", authScheme: "api-key", modelId: "glm-5.3" },
    ]);
  });
});

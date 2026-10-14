import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fallbackUpstreamFromConfig, startModelGateway } from "../src/model-gateway.js";

/**
 * Failover ladder for the rescue model (model.fallback / DPSK). Each upstream
 * is its own scriptable server so tests can assert exactly which upstream a
 * request reached, with what credentials and model id.
 */
interface CapturedRequest {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type UpstreamScript = (response: ServerResponse) => void;

const healthy: UpstreamScript = (response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, usage: { input_tokens: 10, output_tokens: 5 } }));
};

const upstream503: UpstreamScript = (response) => {
  response.writeHead(503, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream exploded" } }));
};

/** Kill the socket before writing anything — the fetch itself throws. */
const networkDrop: UpstreamScript = (response) => {
  response.socket?.destroy();
};

function fakeUpstream(name: string) {
  const captured: CapturedRequest[] = [];
  const scripts: UpstreamScript[] = [];
  const state = {
    captured,
    /** Queue the script for the next request; unqueued requests stay healthy. */
    next: (script: UpstreamScript) => { scripts.push(script); },
    port: 0,
    baseUrl: "",
  };
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      captured.push({ headers: request.headers as Record<string, string>, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      (scripts.shift() ?? healthy)(response);
    });
  });
  return { name, server, state };
}

let primary: ReturnType<typeof fakeUpstream>;
let fallback: ReturnType<typeof fakeUpstream>;

beforeAll(async () => {
  primary = fakeUpstream("primary");
  fallback = fakeUpstream("fallback");
  for (const upstream of [primary, fallback]) {
    await new Promise<void>((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
    upstream.state.port = (upstream.server.address() as AddressInfo).port;
    upstream.state.baseUrl = `http://127.0.0.1:${upstream.state.port}`;
  }
  fallbackUpstream.baseUrl = fallback.state.baseUrl;
  routeUpstream.baseUrl = primary.state.baseUrl;
});

afterAll(async () => {
  await Promise.all([primary, fallback].map((upstream) => new Promise<void>((resolve) => upstream.server.close(() => resolve()))));
});

afterEach(() => {
  primary.state.captured.length = 0;
  fallback.state.captured.length = 0;
});

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-leak", "x-api-key": "client-leak" },
    body: JSON.stringify(body),
  });
}

const minimalBody = { model: "leaked-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

const fallbackUpstream = {
  baseUrl: "",
  apiKey: "fallback-secret",
  modelId: "dpsk-4.1",
};

const routeUpstream = {
  baseUrl: "",
  apiKey: "primary-secret",
  modelId: "glm-4.7",
};

type FailoverEvent = { type: string; data: Record<string, unknown> };

function routeEvents(events: FailoverEvent[]): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === "model.failover").map((event) => event.data);
}

describe("ModelGateway failover", () => {
  it("transparently answers from the rescue upstream on a primary 5xx, with its own credentials and model id", async () => {
    const events: FailoverEvent[] = [];
    primary.state.next(upstream503);
    const gateway = await startModelGateway({ fallbackUpstream });
    try {
      gateway.setRoute("run-5xx", { upstream: routeUpstream, emit: (event) => { events.push(event as FailoverEvent); } });
      const response = await postJson(`${gateway.routeUrl("run-5xx")}/v1/messages?beta=true`, minimalBody);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });

      expect(primary.state.captured).toHaveLength(1);
      expect(primary.state.captured[0]!.body.model).toBe("glm-4.7");
      expect(fallback.state.captured).toHaveLength(1);
      const seen = fallback.state.captured[0]!;
      expect(seen.body.model).toBe("dpsk-4.1");
      expect(seen.headers.authorization).toBe("Bearer fallback-secret");
      expect(seen.headers["x-api-key"]).toBeUndefined();

      expect(routeEvents(events)).toEqual([expect.objectContaining({ reason: "HTTP 503", consecutiveFailures: 1 })]);
    } finally {
      await gateway.stop();
    }
  });

  it("fails over on a network-level primary failure (socket drop)", async () => {
    const events: FailoverEvent[] = [];
    primary.state.next(networkDrop);
    const gateway = await startModelGateway({ fallbackUpstream });
    try {
      gateway.setRoute("run-drop", { upstream: routeUpstream, emit: (event) => { events.push(event as FailoverEvent); } });
      const response = await postJson(gateway.routeUrl("run-drop"), minimalBody);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      expect(fallback.state.captured).toHaveLength(1);
      expect(routeEvents(events)).toEqual([expect.objectContaining({ reason: "network", consecutiveFailures: 1 })]);
    } finally {
      await gateway.stop();
    }
  });

  it("passes 4xx through untouched without ever touching the rescue upstream", async () => {
    const events: FailoverEvent[] = [];
    primary.state.next((response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
    });
    const gateway = await startModelGateway({ fallbackUpstream });
    try {
      gateway.setRoute("run-4xx", { upstream: routeUpstream, emit: (event) => { events.push(event as FailoverEvent); } });
      const response = await postJson(gateway.routeUrl("run-4xx"), minimalBody);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { type: "authentication_error" } });
      expect(fallback.state.captured).toHaveLength(0);
      expect(routeEvents(events)).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  it("bypasses the primary after the failure threshold, probes it again after cooldown, and a success resets the ladder", async () => {
    const events: FailoverEvent[] = [];
    const gateway = await startModelGateway({ fallbackUpstream, failureThreshold: 2, cooldownMs: 200 });
    try {
      gateway.setRoute("run-threshold", { upstream: routeUpstream, emit: (event) => { events.push(event as FailoverEvent); } });
      const url = gateway.routeUrl("run-threshold");

      // Two failing requests: transparent rescue both times, primary hit both times.
      primary.state.next(upstream503);
      primary.state.next(upstream503);
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(primary.state.captured).toHaveLength(2);
      expect(fallback.state.captured).toHaveLength(2);
      expect(routeEvents(events).at(-1)).toMatchObject({ reason: "HTTP 503", consecutiveFailures: 2 });

      // Threshold reached → the very next request must skip the primary entirely.
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(primary.state.captured).toHaveLength(2);
      expect(fallback.state.captured).toHaveLength(3);

      // Cooldown expires → the primary is probed again, succeeds, and the failure ladder resets.
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(primary.state.captured).toHaveLength(3);
      expect(primary.state.captured[2]!.body.model).toBe("glm-4.7");

      primary.state.next(upstream503);
      expect((await postJson(url, minimalBody)).status).toBe(200);
      expect(routeEvents(events).at(-1)).toMatchObject({ reason: "HTTP 503", consecutiveFailures: 1 });
    } finally {
      await gateway.stop();
    }
  });

  it("without a rescue upstream, keeps the pre-R19 behaviour: 502 on network drop, raw 5xx passthrough", async () => {
    primary.state.next(networkDrop);
    primary.state.next(upstream503);
    const gateway = await startModelGateway();
    try {
      gateway.setRoute("run-alone", { upstream: routeUpstream });
      const dropped = await postJson(gateway.routeUrl("run-alone"), minimalBody);
      expect(dropped.status).toBe(502);
      expect(await dropped.json()).toMatchObject({ error: { type: "api_error", message: "Upstream model request failed" } });

      const degraded = await postJson(gateway.routeUrl("run-alone"), minimalBody);
      expect(degraded.status).toBe(503);
      expect(fallback.state.captured).toHaveLength(0);
    } finally {
      await gateway.stop();
    }
  });

  it("returns 502 when both the primary and the rescue upstream fail", async () => {
    primary.state.next(networkDrop);
    fallback.state.next(networkDrop);
    const gateway = await startModelGateway({ fallbackUpstream });
    try {
      gateway.setRoute("run-both-dead", { upstream: routeUpstream });
      const response = await postJson(gateway.routeUrl("run-both-dead"), minimalBody);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { type: "api_error", message: "Upstream model request failed (primary and fallback)" } });
    } finally {
      await gateway.stop();
    }
  });
});

describe("fallbackUpstreamFromConfig", () => {
  const envName = "XUANSHU_TEST_FALLBACK_KEY";
  const previous = process.env[envName];

  afterEach(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });

  it("stays inert without config or without a provisioned key", () => {
    expect(fallbackUpstreamFromConfig(undefined)).toBeUndefined();
    delete process.env[envName];
    expect(fallbackUpstreamFromConfig({ baseUrl: "https://api.deepseek.com/anthropic/", id: "dpsk-4.1", apiKeyEnv: envName })).toBeUndefined();
  });

  it("builds the rescue upstream once the key lands in the environment", () => {
    process.env[envName] = "sk-fallback";
    expect(fallbackUpstreamFromConfig({ baseUrl: "https://api.deepseek.com/anthropic/", id: "dpsk-4.1", apiKeyEnv: envName })).toEqual({
      baseUrl: "https://api.deepseek.com/anthropic/",
      apiKey: "sk-fallback",
      modelId: "dpsk-4.1",
    });
    expect(fallbackUpstreamFromConfig({ baseUrl: "https://example.com", id: "m2", apiKeyEnv: envName, authScheme: "api-key" })).toEqual({
      baseUrl: "https://example.com",
      apiKey: "sk-fallback",
      authScheme: "api-key",
      modelId: "m2",
    });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelGateway, startModelGateway } from "../src/model-gateway.js";
import { ModelRequestGate } from "../src/model-rate-limit.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function auditSink() {
  const records: Array<{ type: string; data: Record<string, unknown>; metadata: Record<string, unknown>; sequence: number }> = [];
  let sequence = 0;
  return {
    records,
    append: async (type: string, data: unknown, metadata: Record<string, unknown> = {}) => {
      sequence += 1;
      records.push({ type, data: data as Record<string, unknown>, metadata, sequence });
      return { sequence };
    },
  };
}

function gateWithClock() {
  let now = 0;
  const sleeps: number[] = [];
  const gate = new ModelRequestGate({
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  return { gate, sleeps, advance: (milliseconds: number) => { now += milliseconds; } };
}

function sseBody(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

let upstreamServer: Server;
let upstreamPort = 0;
const captured: CapturedRequest[] = [];
let respondWith: (response: ServerResponse) => void = (response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, usage: { input_tokens: 10, output_tokens: 5 } }));
};

beforeAll(async () => {
  upstreamServer = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      try {
        captured.push({
          url: request.url ?? "",
          headers: request.headers as Record<string, string>,
          body: JSON.parse(raw || "{}") as Record<string, unknown>,
        });
      } catch {
        captured.push({ url: request.url ?? "", headers: request.headers as Record<string, string>, body: {} });
      }
      respondWith(response);
    });
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstreamServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

afterEach(() => {
  captured.length = 0;
  respondWith = (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, usage: { input_tokens: 10, output_tokens: 5 } }));
  };
});

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const minimalBody = { model: "leaked-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

describe("ModelGateway", () => {
  it("refuses route URLs before the gateway is started", () => {
    const gateway = new ModelGateway();
    expect(() => gateway.routeUrl("run-1")).toThrow("not been started");
  });

  it("answers the CLI startup probe on /api/hello", async () => {
    const gateway = await startModelGateway();
    try {
      const head = await fetch(`${gateway.routeUrl("x").split("/run")[0]}/api/hello`, { method: "HEAD" });
      expect(head.status).toBe(200);
    } finally {
      await gateway.stop();
    }
  });

  it("injects upstream credentials, strips client credentials, and forces the route model id", async () => {
    const gateway = await startModelGateway();
    try {
      gateway.setRoute("run-creds", {
        upstream: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: "upstream-secret",
          modelId: "claude-opus-5",
          headers: { "X-App-Key": "app-key-value" },
        },
      });
      const response = await postJson(`${gateway.routeUrl("run-creds")}/v1/messages?beta=true`, minimalBody, {
        authorization: "Bearer client-leak",
        "x-api-key": "client-leak",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "context-1m-2025-08-07",
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(captured).toHaveLength(1);
      const seen = captured[0]!;
      expect(seen.url).toBe("/v1/messages?beta=true");
      expect(seen.headers.authorization).toBe("Bearer upstream-secret");
      expect(seen.headers["x-api-key"]).toBeUndefined();
      expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
      expect(seen.headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
      expect(seen.headers["x-app-key"]).toBe("app-key-value");
      expect(seen.body.model).toBe("claude-opus-5");
    } finally {
      await gateway.stop();
    }
  });

  it("supports api-key style credentials for anthropic-native endpoints", async () => {
    const gateway = await startModelGateway();
    try {
      gateway.setRoute("run-apikey", {
        upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "sk-test", authScheme: "api-key" },
      });
      const response = await postJson(gateway.routeUrl("run-apikey"), minimalBody, { authorization: "Bearer client-leak" });
      expect(response.status).toBe(200);
      await response.text();
      expect(captured[0]!.headers["x-api-key"]).toBe("sk-test");
      expect(captured[0]!.headers.authorization).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });

  it("passes upstream status codes and bodies through", async () => {
    respondWith = (response) => {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "12" });
      response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    };
    const gateway = await startModelGateway();
    try {
      gateway.setRoute("run-pass", { upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}` } });
      const response = await postJson(gateway.routeUrl("run-pass"), minimalBody);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("12");
      expect(await response.json()).toMatchObject({ error: { type: "rate_limit_error" } });
    } finally {
      await gateway.stop();
    }
  });

  it("rejects unknown routes and non-POST methods", async () => {
    const gateway = await startModelGateway();
    try {
      const origin = gateway.routeUrl("x").split("/run")[0]!;
      const missing = await postJson(`${origin}/run/nope/v1/messages`, minimalBody);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { type: "not_found_error" } });
      const wrongMethod = await fetch(`${origin}/run/other`);
      expect(wrongMethod.status).toBe(404);
    } finally {
      await gateway.stop();
    }
  });

  it("audits model.context and model.request_reserved with parent linkage", async () => {
    const audit = auditSink();
    const gateway = await startModelGateway();
    try {
      gateway.setRoute("run-audit", {
        upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
        audit,
        contextMeta: () => ({ turn: 3, model: { provider: "anthropic", id: "claude-opus-5" }, thinkingLevel: "high" }),
      });
      const response = await postJson(gateway.routeUrl("run-audit"), {
        ...minimalBody,
        system: [{ type: "text", text: "be safe" }],
        tools: [{ name: "run_command", description: "bounded", input_schema: { type: "object", properties: {} } }],
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(audit.records.map((record) => record.type)).toEqual(["model.context", "model.request_reserved"]);
      const context = audit.records[0]!;
      expect(context.data.requestId).toBe("run-audit:request:1");
      expect(context.data.turn).toBe(3);
      expect(context.data.thinkingLevel).toBe("high");
      expect(context.metadata).toMatchObject({ source: "context", actor: "primary-agent", correlationId: "run-audit:request:1" });
      expect((context.data.tools as Array<{ name: string; parameters: unknown }>)[0]).toMatchObject({
        name: "run_command",
        parameters: { type: "object" },
      });
      expect(String(context.data.digest)).toMatch(/^[0-9a-f]{64}$/);
      const reserved = audit.records[1]!;
      expect(reserved.data).toMatchObject({ requestId: "run-audit:request:1", attempt: 1, waitedMs: 0 });
      expect(reserved.metadata.parentSequence).toBe(context.sequence);
    } finally {
      await gateway.stop();
    }
  });

  it("enforces the shared gate between requests and emits throttle events", async () => {
    const { gate, sleeps } = gateWithClock();
    const events: Array<{ type: string; data: unknown }> = [];
    const gateway = await startModelGateway({ gate });
    try {
      gateway.setRoute("run-throttle", {
        upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
        limits: { minimumIntervalMs: 5_000, requestsPerMinute: 0, tokensPerMinute: 0 },
        emit: (event) => { events.push(event); },
      });
      const first = await postJson(gateway.routeUrl("run-throttle"), minimalBody);
      expect(first.status).toBe(200);
      await first.text();
      const second = await postJson(gateway.routeUrl("run-throttle"), minimalBody);
      expect(second.status).toBe(200);
      await second.text();

      expect(sleeps).toEqual([5_000]);
      expect(events).toEqual([
        { type: "model.request_throttled", data: { estimatedTokens: 100, waitedMs: 5_000 } },
      ]);
    } finally {
      await gateway.stop();
    }
  });

  it("answers 429 when the estimate can never fit the configured TPM budget", async () => {
    const gateway = await startModelGateway();
    try {
      gateway.setRoute("run-oversize", {
        upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
        limits: { minimumIntervalMs: 0, requestsPerMinute: 0, tokensPerMinute: 10 },
      });
      const response = await postJson(gateway.routeUrl("run-oversize"), minimalBody);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { type: "rate_limit_error" } });
      expect(captured).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  it("true-ups the token window from SSE usage while streaming bytes through", async () => {
    respondWith = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseBody([
        { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 20 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
        { type: "message_stop" },
      ]));
      response.end();
    };
    const { gate, sleeps } = gateWithClock();
    const gateway = await startModelGateway({ gate });
    try {
      gateway.setRoute("run-sse", {
        upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
        limits: { minimumIntervalMs: 0, requestsPerMinute: 0, tokensPerMinute: 170 },
      });
      const first = await postJson(gateway.routeUrl("run-sse"), { ...minimalBody, max_tokens: 1 });
      expect(first.status).toBe(200);
      const text = await first.text();
      expect(text).toContain("message_start");
      expect(text).toContain("message_stop");

      // The SSE stream reported 170 actual tokens; the estimate was only 1.
      // A follow-up request now has to wait for the trued-up window to expire.
      const second = await postJson(gateway.routeUrl("run-sse"), { ...minimalBody, max_tokens: 1 });
      expect(second.status).toBe(200);
      await second.text();
      expect(sleeps).toEqual([60_000]);
    } finally {
      await gateway.stop();
    }
  });

  it("true-ups the token window from non-streaming JSON usage", async () => {
    const { gate, sleeps } = gateWithClock();
    const gateway = await startModelGateway({ gate });
    try {
      gateway.setRoute("run-json-usage", {
        upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
        limits: { minimumIntervalMs: 0, requestsPerMinute: 0, tokensPerMinute: 15 },
      });
      const first = await postJson(gateway.routeUrl("run-json-usage"), { ...minimalBody, max_tokens: 1 });
      expect(first.status).toBe(200);
      await first.text();
      const second = await postJson(gateway.routeUrl("run-json-usage"), { ...minimalBody, max_tokens: 1 });
      expect(second.status).toBe(200);
      await second.text();
      // Default upstream reports usage { input_tokens: 10, output_tokens: 5 } = 15.
      expect(sleeps).toEqual([60_000]);
    } finally {
      await gateway.stop();
    }
  });

  it("routes upstream fetch through XUANSHU_MODEL_PROXY when configured", async () => {
    const previousProxy = process.env.XUANSHU_MODEL_PROXY;
    process.env.XUANSHU_MODEL_PROXY = "http://127.0.0.1:1";
    const gateway = new ModelGateway();
    await gateway.start();
    try {
      gateway.setRoute("run-proxy", { upstream: { baseUrl: "https://model.example.test" } });
      const response = await postJson(gateway.routeUrl("run-proxy"), minimalBody);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { type: "api_error", message: "Upstream model request failed" } });
      expect(captured).toEqual([]);
    } finally {
      await gateway.stop();
      if (previousProxy === undefined) delete process.env.XUANSHU_MODEL_PROXY;
      else process.env.XUANSHU_MODEL_PROXY = previousProxy;
    }
  });

  it("releases routes so their run key stops resolving", async () => {
    const gateway = await startModelGateway();
    try {
      gateway.setRoute("run-release", { upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}` } });
      const origin = gateway.routeUrl("run-release").split("/run")[0]!;
      gateway.releaseRoute("run-release");
      const response = await postJson(`${origin}/run/run-release/v1/messages`, minimalBody);
      expect(response.status).toBe(404);
    } finally {
      await gateway.stop();
    }
  });
});

describe("ModelGateway usage attribution", () => {
  it("accumulates the per-field usage split across JSON and SSE responses", async () => {
    const gateway = await startModelGateway();
    try {
      let call = 0;
      respondWith = (response) => {
        call += 1;
        if (call === 1) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60 },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sseBody([
          { type: "message_start", message: { usage: { input_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 30 } } },
          { type: "message_delta", usage: { output_tokens: 75 } },
        ]));
      };
      gateway.setRoute("usage-run", { upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "up-key" } });
      await postJson(gateway.routeUrl("usage-run"), minimalBody);
      await postJson(gateway.routeUrl("usage-run"), minimalBody);

      const usage = gateway.routeUsage("usage-run");
      expect(usage).toBeDefined();
      expect(usage).toMatchObject({
        requests: 2,
        inputTokens: 300,
        outputTokens: 115,
        cacheReadTokens: 5900,
        cacheCreationTokens: 90,
      });
      gateway.releaseRoute("usage-run");
      expect(gateway.routeUsage("usage-run")).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });
});

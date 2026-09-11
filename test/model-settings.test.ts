import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { startModelGateway, type GatewayFetch } from "../src/model-gateway.js";
import { XuanShuRuntime } from "../src/runtime.js";
import { assistantStep, registerFauxCli, successResult, textBlock } from "./faux-cli.js";
import { testConfig } from "./helpers.js";

describe("runtime model session settings", () => {
  it("keeps session credentials out of the public model status", () => {
    const config = testConfig("/tmp/xuan-model-settings");
    config.model.apiKeyEnv = "__XUANSHU_MODEL_SETTINGS_TEST_KEY__";
    const runtime = new XuanShuRuntime(config);
    expect(runtime.modelStatus()).toMatchObject({ configured: false, source: "missing" });
    runtime.configureModel({
      model: {
        provider: "wanqing",
        id: "ep-test",
        name: "DeepSeek test",
        baseUrl: "https://example.invalid",
        apiKeyEnv: "XUANSHU_SESSION_MODEL_KEY",
        contextWindow: 128_000,
      },
      apiKey: "secret-api-key",
      headers: { "X-App-Key": "secret-app-key" },
    });
    expect(runtime.modelStatus()).toMatchObject({ configured: true, source: "session", provider: "wanqing", id: "ep-test", appKeyHeaderConfigured: true });
    expect(JSON.stringify(runtime.modelStatus())).not.toContain("secret");
    runtime.clearConfiguredModel();
    expect(runtime.modelStatus().source).toBe("missing");
  });

  it("clearing the session restores the environment-configured model", () => {
    const config = testConfig("/tmp/xuan-model-settings-env");
    process.env.XUANSHU_TEST_API_KEY = "env-key";
    try {
      const runtime = new XuanShuRuntime(config);
      expect(runtime.modelStatus()).toMatchObject({ configured: true, source: "environment", id: "faux-1" });
      runtime.configureModel({
        model: { provider: "wanqing", id: "ep-test", name: "DeepSeek test", baseUrl: "https://example.invalid", apiKeyEnv: "XUANSHU_SESSION_MODEL_KEY" },
        apiKey: "secret-api-key",
      });
      expect(runtime.modelStatus()).toMatchObject({ source: "session", id: "ep-test" });
      runtime.clearConfiguredModel();
      expect(runtime.modelStatus()).toMatchObject({ source: "environment", id: "faux-1" });
    } finally {
      delete process.env.XUANSHU_TEST_API_KEY;
    }
  });
});

describe("runtime model session routing", () => {
  it("routes session-configured runs to the session upstream with injected credentials", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-model-session-route-"));
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    config.runtime.maxRuntimeMs = 30_000;
    const upstreamCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetcher: GatewayFetch = async (url, init) => {
      upstreamCalls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "stub upstream" } }), { status: 502 });
    };
    // The faux CLI's gateway probe makes the session route real: the gateway
    // must forward to the SESSION endpoint with the SESSION credential, and
    // rewrite the request model so a leaked default id can never reach it.
    const gateway = await startModelGateway({ fetch: fetcher });
    const faux = await registerFauxCli([
      assistantStep([textBlock("session route probe")]),
      successResult("done"),
    ], { gateway: true });
    try {
      const runtime = new XuanShuRuntime(config, {
        gateway,
        sdk: { pathToClaudeCodeExecutable: faux.executablePath, env: faux.env },
      });
      runtime.configureModel({
        model: {
          provider: "session-provider",
          id: "session-model",
          name: "Session Model",
          baseUrl: "https://session.example.invalid/anthropic",
          apiKeyEnv: "XUANSHU_SESSION_MODEL_KEY",
        },
        apiKey: "session-secret-key",
        headers: { "X-App-Key": "session-app-key" },
      });
      await runtime.run({ task: "Route through the configured session model" });

      expect(upstreamCalls.length).toBeGreaterThan(0);
      for (const call of upstreamCalls) {
        expect(call.url).toBe("https://session.example.invalid/anthropic/v1/messages");
        expect(call.headers.authorization).toBe("Bearer session-secret-key");
        expect(call.headers["x-api-key"]).toBeUndefined();
        expect(call.headers["X-App-Key"]).toBe("session-app-key");
        expect(call.body.model).toBe("session-model");
      }
    } finally {
      await faux.cleanup();
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

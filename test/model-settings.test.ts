import { describe, expect, it } from "vitest";
import { createModel, XuanShuRuntime } from "../src/runtime.js";
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
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        apiKeyEnv: "XUANSHU_SESSION_MODEL_KEY",
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      apiKey: "secret-api-key",
      headers: { "X-App-Key": "secret-app-key" },
    });
    expect(runtime.modelStatus()).toMatchObject({ configured: true, source: "session", provider: "wanqing", id: "ep-test", appKeyHeaderConfigured: true });
    expect(JSON.stringify(runtime.modelStatus())).not.toContain("secret");
    runtime.clearConfiguredModel();
    expect(runtime.modelStatus().source).toBe("missing");
  });

  it("merges ephemeral headers into the provider model", () => {
    const model = createModel({
      provider: "wanqing",
      id: "ep-test",
      name: "DeepSeek test",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      apiKeyEnv: "XUANSHU_SESSION_MODEL_KEY",
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 8_192,
    }, { "X-App-Key": "ephemeral" });
    expect(model.headers).toEqual({ "X-App-Key": "ephemeral" });
  });
});

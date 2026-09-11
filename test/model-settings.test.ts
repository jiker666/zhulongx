import { describe, expect, it } from "vitest";
import { XuanShuRuntime } from "../src/runtime.js";
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

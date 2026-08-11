import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig, mergeScope } from "../src/config.js";
import { testConfig } from "./helpers.js";

describe("model configuration", () => {
  it("loads the public OpenAI Responses endpoint without embedding credentials", async () => {
    const config = await loadConfig("config/default.yaml");

    expect(config.model).toMatchObject({
      provider: "openai",
      id: "gpt-5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      contextWindow: 400_000,
    });
    expect(config.model).not.toHaveProperty("apiKey");
    expect(JSON.stringify(config.model)).not.toContain("Bearer ");
    expect(config.runtime).toMatchObject({
      modelMinIntervalMs: 7_500,
      modelRequestsPerMinute: 48,
      modelTokensPerMinute: 480_000,
    });
  });

  it("loads the dedicated Arena configuration without embedding credentials", async () => {
    const configPath = "config/arena.yaml";
    const [config, source] = await Promise.all([loadConfig(configPath), readFile(configPath, "utf8")]);

    expect(config.model).toMatchObject({
      provider: "openai",
      id: "gpt-5",
      name: "GPT-5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(config.scope.mode).toBe("controlled");
    expect(config.arena).toMatchObject({ allowedCategories: ["crypto", "misc"], maxCategorySkips: 10 });
    expect(config.questionBank).toMatchObject({
      enabled: true,
      rootEnv: "XUANSHU_QUESTION_BANK_ROOT",
      listFiles: ["task_list_crypto.txt", "task_list_misc.txt"],
      maxQuestions: 20,
    });
    expect(config.model).not.toHaveProperty("apiKey");
    expect(source).not.toMatch(/^\s*apiKey\s*:/m);
    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
  });

  it("loads the Wanqing NSS configuration with environment-only credentials", async () => {
    const configPath = "config/nss-wanqing.yaml";
    const [config, source] = await Promise.all([loadConfig(configPath), readFile(configPath, "utf8")]);

    expect(config.model).toMatchObject({
      provider: "wanqing-corp",
      id: "ep-spmlx5-1786072758181058776",
      api: "openai-completions",
      baseUrl: "https://wanqing-api.corp.kuaishou.com/api/gateway/v1/endpoints",
      apiKeyEnv: "WQ_API_KEY",
    });
    expect(config.scope).toMatchObject({ mode: "controlled" });
    expect(config.arena).toMatchObject({
      enabled: true,
      tokenEnv: "NSSCTF_AGENT_TOKEN",
      allowedCategories: ["crypto", "misc"],
      maxCategorySkips: 10,
    });
    expect(config.questionBank).toMatchObject({ enabled: true, rootEnv: "XUANSHU_QUESTION_BANK_ROOT", raceAgents: 3 });
    expect(config.runtime).toMatchObject({
      modelMinIntervalMs: 7_500,
      modelRequestsPerMinute: 48,
      modelTokensPerMinute: 480_000,
    });
    expect(source).not.toMatch(/^\s*apiKey\s*:/m);
    expect(source).not.toMatch(/Bearer\s+[A-Za-z0-9._~-]+/i);
  });

  it("operator-owned CTF profiles explicitly allow the offline Crypto/Misc toolset", async () => {
    const [configs, manifestSource] = await Promise.all([
      Promise.all([
      loadConfig("config/default.yaml"),
      loadConfig("config/container.yaml"),
      loadConfig("config/arena.yaml"),
      loadConfig("config/nss-wanqing.yaml"),
      ]),
      readFile("tools/ctf/capabilities.json", "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      profiles: {
        core: { commands: { crypto: string[]; misc: string[] } };
        heavy: { commands: string[] };
      };
    };
    const requiredPrograms = [
      ...manifest.profiles.core.commands.crypto,
      ...manifest.profiles.core.commands.misc,
      ...manifest.profiles.heavy.commands,
    ];

    for (const config of configs) {
      expect(config.scope.allowedPrograms).toEqual(expect.arrayContaining(requiredPrograms));
      expect(config.arena).toMatchObject({ allowedCategories: ["crypto", "misc"], maxCategorySkips: 10 });
    }
    expect(configs[3]?.questionBank?.instanceRunner).toMatchObject({
      enabled: true,
      networkName: "shared_net",
      startupTimeoutMs: 300000,
    });
  });
});

describe("scope merging", () => {
  it("allows narrowing but rejects per-run scope expansion", () => {
    const base = testConfig("/tmp/xuan-config").scope;
    base.mode = "controlled";
    base.allowedHosts = ["lab.example.invalid"];
    base.allowedPrograms = ["file", "rg"];

    expect(
      mergeScope(base, {
        mode: "observe",
        workspaceRoot: `${base.workspaceRoot}/case-1`,
        allowedHosts: [],
        allowedPrograms: ["file"],
      }),
    ).toMatchObject({ mode: "observe", allowedHosts: [], allowedPrograms: ["file"] });
    expect(() => mergeScope(base, { allowedHosts: ["outside.invalid"] })).toThrow("cannot add hosts");
    expect(() => mergeScope(base, { workspaceRoot: "/tmp/outside" })).toThrow("cannot expand workspaceRoot");
  });

  it("does not allow observe mode to become controlled", () => {
    const base = testConfig("/tmp/xuan-config").scope;
    expect(() => mergeScope(base, { mode: "controlled" })).toThrow("cannot elevate");
  });

  it("allows per-run hosts that narrow an operator-owned wildcard host pattern", () => {
    const base = testConfig("/tmp/xuan-config").scope;
    base.mode = "controlled";
    base.allowedHosts = ["*.sandbox.invalid:*"];

    expect(mergeScope(base, { allowedHosts: ["case.sandbox.invalid:31001"] }).allowedHosts).toEqual([
      "case.sandbox.invalid:31001",
    ]);
    expect(() => mergeScope(base, { allowedHosts: ["outside.invalid:31001"] })).toThrow("cannot add hosts");
  });
});

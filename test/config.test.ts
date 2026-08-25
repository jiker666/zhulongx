import { readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig, mergeScope } from "../src/config.js";
import { testConfig } from "./helpers.js";

describe("generic configuration", () => {
  it("loads the public default without embedded credentials or platform adapters", async () => {
    const source = await readFile("config/default.yaml", "utf8");
    const config = await loadConfig("config/default.yaml");
    expect(config.model).toMatchObject({ provider: "openai", api: "openai-responses", apiKeyEnv: "OPENAI_API_KEY" });
    expect(Object.keys(config).sort()).toEqual(["connectors", "model", "profile", "runtime", "scope", "server"]);
    expect(source).not.toMatch(/Bearer\s+[A-Za-z0-9._~-]+/i);
  });

  it("rejects executor kinds without an operator-provided adapter", async () => {
    const source = await readFile("config/default.yaml", "utf8");
    const path = `/tmp/xuan-config-${process.pid}-${Date.now()}.yaml`;
    await writeFile(path, source.replace("preferredExecutor: sandbox", "preferredExecutor: ssh"));
    try { await expect(loadConfig(path)).rejects.toThrow("operator-provided executor adapter"); }
    finally { await rm(path, { force: true }); }
  });
});

describe("scope merging", () => {
  it("allows narrowing but rejects per-run scope expansion", () => {
    const base = testConfig("/tmp/xuan-config").scope;
    base.mode = "controlled";
    base.allowedHosts = ["lab.example.invalid"];
    base.allowedPrograms = ["file", "rg"];
    expect(mergeScope(base, { mode: "observe", workspaceRoot: `${base.workspaceRoot}/case-1`, allowedHosts: [], allowedPrograms: ["file"] })).toMatchObject({ mode: "observe", allowedHosts: [], allowedPrograms: ["file"] });
    expect(() => mergeScope(base, { allowedHosts: ["outside.invalid"] })).toThrow("cannot add hosts");
    expect(() => mergeScope(base, { workspaceRoot: "/tmp/outside" })).toThrow("cannot expand workspaceRoot");
  });

  it("does not allow observe mode to become controlled", () => {
    expect(() => mergeScope(testConfig("/tmp/xuan-config").scope, { mode: "controlled" })).toThrow("cannot elevate");
  });

  it("allows a narrowed host under an operator wildcard", () => {
    const base = testConfig("/tmp/xuan-config").scope;
    base.mode = "controlled";
    base.allowedHosts = ["*.sandbox.invalid:*"];
    expect(mergeScope(base, { allowedHosts: ["case.sandbox.invalid:31001"] }).allowedHosts).toEqual(["case.sandbox.invalid:31001"]);
    expect(() => mergeScope(base, { allowedHosts: ["outside.invalid:31001"] })).toThrow("cannot add hosts");
  });
});

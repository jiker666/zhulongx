import { describe, expect, it } from "vitest";
import { defaultAgentProfile, filterProfileTools, narrowToolsForCategory, resolveAgentProfile, validateProfileCapabilities } from "../src/profiles.js";
import { testConfig } from "./helpers.js";

describe("agent profiles", () => {
  it("provides a machine-verifiable default profile", () => {
    const config = testConfig("/tmp/xuan-profile");
    const profile = defaultAgentProfile(config);
    expect(profile).toMatchObject({ id: "general", preferredExecutor: "sandbox", requiredCapabilities: ["workspace-read"] });
    expect(profile.toolAllowlist).toEqual(expect.arrayContaining(["submit_plan", "checkpoint", "finish_task", "run_command"]));
  });

  it("rejects unknown or incomplete operator profiles", () => {
    const config = testConfig("/tmp/xuan-profile");
    config.profile = { id: "bad", preferredExecutor: "sandbox", requiredCapabilities: [], toolAllowlist: ["submit_plan", "checkpoint", "missing_tool"] };
    expect(() => resolveAgentProfile(config)).toThrow("unknown builtin tools");
    config.profile.toolAllowlist = ["submit_plan", "checkpoint"];
    expect(() => resolveAgentProfile(config)).toThrow("must allow finish_task");
  });

  it("validates executor capabilities and narrows the active tool set", () => {
    const config = testConfig("/tmp/xuan-profile");
    config.profile = { id: "readonly", preferredExecutor: "sandbox", requiredCapabilities: ["workspace-read"], toolAllowlist: ["submit_plan", "checkpoint", "finish_task", "read_file"] };
    const profile = resolveAgentProfile(config);
    expect(() => validateProfileCapabilities(profile, { status: "online", kind: "sandbox", networkAccess: false, network: "none", capabilities: ["scratch-read"], allowedPrograms: [], missingPrograms: [] })).toThrow("workspace-read");
    expect(filterProfileTools(profile, [{ name: "read_file" }, { name: "run_command" }])).toEqual([{ name: "read_file" }]);
  });

  it("narrows offline CTF runs without expanding the operator allowlist", () => {
    const tools = [
      { name: "submit_plan" }, { name: "inspect_artifact" }, { name: "run_command" },
      { name: "http_request" }, { name: "browser" }, { name: "finish_task" },
    ];
    expect(narrowToolsForCategory("reverse", tools).map((tool) => tool.name)).toEqual([
      "submit_plan", "inspect_artifact", "run_command", "finish_task",
    ]);
    expect(narrowToolsForCategory(undefined, tools)).toEqual(tools);
  });
});

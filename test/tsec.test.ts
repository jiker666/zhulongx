import { describe, expect, it } from "vitest";
import { tsecScope } from "../src/tsec.js";
import type { AppConfig } from "../src/types.js";

function config(mode: "controlled" | "observe"): AppConfig {
  return { scope: { mode, allowedHosts: ["10.0.*.*", "10.0.*.*:*"], allowedPrograms: [] } } as unknown as AppConfig;
}

describe("TSec scope adapter", () => {
  it("narrows an operator-owned VPN range to the returned host and port", () => {
    expect(tsecScope(config("controlled"), "10.0.178.80", 80, ["10.0.*.*"])).toEqual({
      mode: "controlled",
      allowedHosts: ["10.0.178.80", "10.0.178.80:80"],
    });

    expect(tsecScope(config("controlled"), "10.0.162.64", 8000, ["10.0.*.*:*"])).toEqual({
      mode: "controlled",
      allowedHosts: ["10.0.162.64:8000"],
    });
  });

  it("rejects observe mode and hosts outside the configured range", () => {
    expect(() => tsecScope(config("observe"), "10.0.178.80", 80, ["10.0.*.*"])).toThrow("controlled");
    expect(() => tsecScope(config("controlled"), "192.0.2.10", 80, ["10.0.*.*"])).toThrow("outside");
    expect(() => tsecScope(config("controlled"), "10.0.162.64", 8000, ["10.0.*.*"])).toThrow("outside");
  });
});

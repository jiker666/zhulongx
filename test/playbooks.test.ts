import { describe, expect, it } from "vitest";
import { renderCapabilityPlaybook } from "../src/playbooks.js";

describe("category capability playbooks", () => {
  it("routes categories to generic evidence workflows without fixed answers", () => {
    const crypto = renderCapabilityPlaybook("Crypto");
    expect(crypto).toContain("Re-encrypt");
    expect(crypto).toContain("infer any wrapper only from direct evidence");
    expect(crypto).not.toMatch(/NSSCTF\{|0x[0-9a-f]+/i);

    expect(renderCapabilityPlaybook("Pwn")).toContain("never use guessed offsets");
    expect(renderCapabilityPlaybook("unknown")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { renderCapabilityPlaybook } from "../src/playbooks.js";

describe("category capability playbooks", () => {
  it("routes categories to generic evidence workflows without fixed answers", () => {
    const crypto = renderCapabilityPlaybook("Crypto");
    expect(crypto).toContain("Re-encrypt");
    expect(crypto).toContain("low-cost triage");
    expect(crypto).toContain("allowlisted ecm program");
    expect(crypto).toContain("fpylll, GP, Z3, or OR-Tools");
    expect(crypto).toContain("timeout alone is not evidence");
    expect(crypto).toContain("infer any wrapper only from direct evidence");
    expect(crypto).toContain("CURATED CTF SKILL INDEX (ctf-crypto)");
    expect(crypto).toContain("PolicyEngine scope/budgets");
    expect(crypto).not.toMatch(/[A-Za-z][A-Za-z0-9_-]{1,63}\{[^{}]+\}|0x[0-9a-f]+/i);

    expect(renderCapabilityPlaybook("Pwn")).toContain("never use guessed offsets");
    expect(renderCapabilityPlaybook("Reverse")).toContain("preserve every xor/add/sub/rotate");
    expect(renderCapabilityPlaybook("Reverse")).toContain("image-base + RVA");
    expect(renderCapabilityPlaybook("Reverse")).toContain("full check independently");
    expect(renderCapabilityPlaybook("Misc")).toContain("pickora");
    expect(renderCapabilityPlaybook("Misc")).toContain("bounded derivative in scratch");
    expect(renderCapabilityPlaybook("unknown")).toBe("");
  });
});

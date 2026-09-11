import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { adaptExternalTool } from "../src/external-tools.js";
import { PolicyEngine } from "../src/policy.js";
import type { ToolDescriptor } from "../src/tool-catalog.js";
import type { RunState } from "../src/types.js";
import { testConfig } from "./helpers.js";

function descriptor(effect: ToolDescriptor["effect"] = "network"): ToolDescriptor {
  return { name: "mcp.lookup", source: "mcp", kind: "search", effect, executionMode: "parallel", capabilityRequirements: [], sideEffects: ["Issues one read-only lookup"], networkTargetFields: ["url"], riskEvaluator: () => ({ level: "network", summary: "External lookup", requiresApproval: true }) };
}

function state(): RunState {
  const now = new Date().toISOString();
  return { id: "run", status: "running", phase: "exploration", task: { task: "test", attachments: [], metadata: {} }, createdAt: now, updatedAt: now, startedAt: now, plan: { goal: "test", assumptions: [], hypotheses: [], steps: [{ id: "1", objective: "lookup", successCriteria: [], tools: ["mcp.lookup"] }] }, findings: [], lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false, sandboxNamespace: "run", scratchRoot: "/tmp/scratch", workspaceMode: "configured", appliedExperienceIds: [], turns: 1, toolCalls: 0, imageObservations: 0, httpRequests: 0, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {} };
}

describe("external tool adapter", () => {
  it("rejects direct write or execute registrations", () => {
    expect(() => adaptExternalTool({ descriptor: descriptor("execute"), tool: { name: "mcp.lookup", label: "lookup", description: "test", parameters: Type.Object({}), execute: vi.fn() } }, 100)).toThrow("cannot be registered directly");
  });

  it("bounds and sanitizes external output", async () => {
    const registration = adaptExternalTool({ descriptor: descriptor(), tool: { name: "mcp.lookup", label: "lookup", description: "test", parameters: Type.Object({ url: Type.String() }), async execute() { return { content: [{ type: "text" as const, text: `Authorization: Bearer secret-value ${"x".repeat(200)}` }], details: { token: "secret-value" } }; } } }, 64);
    const result = await registration.tool.execute("call", { url: "https://lab.invalid" });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("[truncated]") });
    expect(JSON.stringify(result.details)).not.toContain("secret-value");
  });

  it("routes external network tools through configured scope and budget", () => {
    const config = testConfig("/tmp/xuan-external");
    config.scope.mode = "controlled";
    config.scope.allowedHosts = ["lab.invalid"];
    const policy = new PolicyEngine(config.scope, config.runtime, [descriptor()]);
    const run = state();
    expect(policy.evaluate("mcp.lookup", { url: "https://outside.invalid" }, run).allowed).toBe(false);
    const allowed = policy.evaluate("mcp.lookup", { url: "https://lab.invalid/evidence" }, run);
    expect(allowed.allowed).toBe(true);
    policy.recordAllowed("mcp.lookup", allowed, run);
    expect(run).toMatchObject({ toolCalls: 1, httpRequests: 1, actionsSinceCheckpoint: 1 });
  });
});

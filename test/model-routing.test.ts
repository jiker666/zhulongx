import { describe, expect, it } from "vitest";
import { HeavyThinkCoordinator, StepModelRouter, type ModelRoute } from "../src/model-routing.js";

const cheap: ModelRoute = { id: "cheap", provider: "faux", model: "small", maxDifficulty: "medium", capabilities: ["text"], allowedEffects: ["pure_readonly", "workspace_read"], maxTokens: 100, maxCostMicros: 10, priority: 1 };
const strong: ModelRoute = { id: "strong", provider: "faux", model: "large", maxDifficulty: "high", capabilities: ["text", "code"], allowedEffects: ["pure_readonly", "workspace_read", "network"], maxTokens: 300, maxCostMicros: 50, priority: 2 };

describe("step model routing", () => {
  it("selects by step difficulty, effect, capabilities and budget", () => {
    const router = new StepModelRouter([strong, cheap]);
    expect(router.select({ kind: "work", difficulty: "low", effect: "pure_readonly", requiredCapabilities: ["text"], maxTokens: 500, maxCostMicros: 100 }).route.id).toBe("cheap");
    expect(router.select({ kind: "controller", difficulty: "high", effect: "network", requiredCapabilities: ["code"], maxTokens: 500, maxCostMicros: 100 }).route.id).toBe("strong");
    expect(() => router.select({ kind: "work", difficulty: "high", effect: "network", requiredCapabilities: ["code"], maxTokens: 100, maxCostMicros: 20 })).toThrow("No model route");
  });

  it("runs independent HeavyThink branches and a bounded aggregator", async () => {
    const coordinator = new HeavyThinkCoordinator({
      branch: async ({ branchId }) => ({ branchId, summary: `${branchId} proposal`, confidence: 0.6, tokensUsed: 10, costMicros: 5 }),
      aggregate: async ({ branches }) => ({ selectedBranchIds: [branches[1]!.branchId], summary: "selected", confidence: 0.9, tokensUsed: 20, costMicros: 10 }),
    });
    const result = await coordinator.run({ prompt: "hard step", branchRoutes: [strong, strong], aggregateRoute: strong, budget: { maxBranches: 2, maxRuntimeMs: 1_000, maxTokens: 400, maxCostMicros: 100 } });
    expect(result).toMatchObject({ selectedBranchIds: ["branch-2"], tokensUsed: 40, costMicros: 20, branches: [{ branchId: "branch-1" }, { branchId: "branch-2" }] });
  });

  it("refuses HeavyThink when branch or aggregation budgets do not fit", async () => {
    const coordinator = new HeavyThinkCoordinator({ branch: async ({ branchId }) => ({ branchId, summary: "x", confidence: 0.5, tokensUsed: 60, costMicros: 5 }), aggregate: async () => ({ selectedBranchIds: ["branch-1"], summary: "x", confidence: 0.5, tokensUsed: 1, costMicros: 1 }) });
    await expect(coordinator.run({ prompt: "hard", branchRoutes: [strong, strong], aggregateRoute: strong, budget: { maxBranches: 2, maxRuntimeMs: 1_000, maxTokens: 100, maxCostMicros: 100 } })).rejects.toThrow("branch budget");
  });
});

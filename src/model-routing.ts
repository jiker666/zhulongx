import { sanitizeSensitiveText } from "./sanitize.js";
import type { WorkflowEffect, WorkflowNodeKind } from "./workflow.js";

export type StepDifficulty = "low" | "medium" | "high";

export interface ModelRoute {
  id: string;
  provider: string;
  model: string;
  maxDifficulty: StepDifficulty;
  capabilities: string[];
  allowedEffects: WorkflowEffect[];
  maxTokens: number;
  maxCostMicros: number;
  priority: number;
}

export interface StepRoutingRequest {
  kind: WorkflowNodeKind;
  difficulty: StepDifficulty;
  effect: WorkflowEffect;
  requiredCapabilities: string[];
  maxTokens: number;
  maxCostMicros: number;
}

export interface ModelRoutingDecision {
  route: ModelRoute;
  reason: string;
}

const DIFFICULTY = { low: 0, medium: 1, high: 2 } as const;

export class StepModelRouter {
  private readonly routes: ModelRoute[];

  constructor(routes: ModelRoute[]) {
    if (routes.length < 1 || routes.length > 32) throw new Error("Model router requires between 1 and 32 routes");
    const ids = new Set<string>();
    this.routes = routes.map((route) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(route.id) || ids.has(route.id)) throw new Error("Model route ids must be unique and safe"); ids.add(route.id);
      if (!route.provider.trim() || !route.model.trim()) throw new Error(`Model route ${route.id} requires provider and model`);
      if (!Number.isSafeInteger(route.maxTokens) || route.maxTokens <= 0 || !Number.isSafeInteger(route.maxCostMicros) || route.maxCostMicros <= 0) throw new Error(`Model route ${route.id} budgets must be positive integers`);
      return { ...route, provider: sanitizeSensitiveText(route.provider).slice(0, 100), model: sanitizeSensitiveText(route.model).slice(0, 200), capabilities: [...new Set(route.capabilities)].slice(0, 32), allowedEffects: [...new Set(route.allowedEffects)], priority: Number.isFinite(route.priority) ? route.priority : 0 };
    });
  }

  select(request: StepRoutingRequest): ModelRoutingDecision {
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0 || !Number.isSafeInteger(request.maxCostMicros) || request.maxCostMicros <= 0) throw new Error("Step routing budgets must be positive integers");
    const required = new Set(request.requiredCapabilities);
    const candidates = this.routes.filter((route) =>
      DIFFICULTY[route.maxDifficulty] >= DIFFICULTY[request.difficulty] &&
      route.allowedEffects.includes(request.effect) &&
      route.maxTokens <= request.maxTokens &&
      route.maxCostMicros <= request.maxCostMicros &&
      [...required].every((capability) => route.capabilities.includes(capability)),
    ).sort((left, right) => left.priority - right.priority || left.maxCostMicros - right.maxCostMicros || left.id.localeCompare(right.id));
    const route = candidates[0];
    if (!route) throw new Error("No model route satisfies the step capability, effect, difficulty, and budget constraints");
    return { route, reason: `Selected ${route.id} for ${request.kind}/${request.difficulty}/${request.effect}; all required capabilities fit within the per-step token and cost budget.` };
  }
}

export interface HeavyThinkBranchResult {
  branchId: string;
  summary: string;
  confidence: number;
  tokensUsed: number;
  costMicros: number;
  artifacts?: string[];
}

export interface HeavyThinkResult {
  selectedBranchIds: string[];
  summary: string;
  confidence: number;
  tokensUsed: number;
  costMicros: number;
  branches: HeavyThinkBranchResult[];
}

export interface HeavyThinkRunner {
  branch(input: { branchId: string; prompt: string; route: ModelRoute; signal: AbortSignal }): Promise<HeavyThinkBranchResult>;
  aggregate(input: { prompt: string; branches: HeavyThinkBranchResult[]; route: ModelRoute; signal: AbortSignal }): Promise<Omit<HeavyThinkResult, "tokensUsed" | "costMicros" | "branches"> & { tokensUsed: number; costMicros: number }>;
}

export interface HeavyThinkBudget { maxBranches: number; maxRuntimeMs: number; maxTokens: number; maxCostMicros: number; }

export class HeavyThinkCoordinator {
  constructor(private readonly runner: HeavyThinkRunner) {}

  async run(input: { prompt: string; branchRoutes: ModelRoute[]; aggregateRoute: ModelRoute; budget: HeavyThinkBudget; signal?: AbortSignal }): Promise<HeavyThinkResult> {
    if (!input.prompt.trim()) throw new Error("HeavyThink prompt must not be empty");
    if (!Number.isSafeInteger(input.budget.maxBranches) || input.budget.maxBranches < 2 || input.budget.maxBranches > 8) throw new Error("HeavyThink maxBranches must be between 2 and 8");
    const routes = input.branchRoutes.slice(0, input.budget.maxBranches); if (routes.length < 2) throw new Error("HeavyThink requires at least two independent branch routes");
    const controller = new AbortController(); const relay = () => controller.abort(input.signal?.reason); input.signal?.addEventListener("abort", relay, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("HeavyThink runtime budget exceeded")), input.budget.maxRuntimeMs);
    try {
      const branches = await Promise.all(routes.map((route, index) => this.runner.branch({ branchId: `branch-${index + 1}`, prompt: input.prompt, route, signal: controller.signal })));
      const branchTokens = branches.reduce((sum, branch) => sum + branch.tokensUsed, 0); const branchCost = branches.reduce((sum, branch) => sum + branch.costMicros, 0);
      if (branchTokens > input.budget.maxTokens || branchCost > input.budget.maxCostMicros) throw new Error("HeavyThink branch budget exceeded");
      const remainingTokens = input.budget.maxTokens - branchTokens; const remainingCost = input.budget.maxCostMicros - branchCost;
      if (input.aggregateRoute.maxTokens > remainingTokens || input.aggregateRoute.maxCostMicros > remainingCost) throw new Error("HeavyThink aggregation budget unavailable");
      const aggregate = await this.runner.aggregate({ prompt: input.prompt, branches, route: input.aggregateRoute, signal: controller.signal });
      const tokensUsed = branchTokens + aggregate.tokensUsed; const costMicros = branchCost + aggregate.costMicros;
      if (tokensUsed > input.budget.maxTokens || costMicros > input.budget.maxCostMicros) throw new Error("HeavyThink aggregate budget exceeded");
      const branchIds = new Set(branches.map((branch) => branch.branchId)); if (aggregate.selectedBranchIds.length === 0 || aggregate.selectedBranchIds.some((id) => !branchIds.has(id))) throw new Error("HeavyThink aggregator selected an unknown branch");
      return { ...aggregate, summary: sanitizeSensitiveText(aggregate.summary).slice(0, 12_000), tokensUsed, costMicros, branches: branches.map((branch) => ({ ...branch, summary: sanitizeSensitiveText(branch.summary).slice(0, 8_000), artifacts: (branch.artifacts ?? []).slice(0, 16).map((item) => sanitizeSensitiveText(item).slice(0, 500)) })) };
    } finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", relay); }
  }
}

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit.js";
import { renderRunHandoff } from "../src/handoff.js";
import { planHasStepActivity, planUnmetDependencies, renderPlanStatus } from "../src/plan-status.js";
import { createToolSet } from "../src/tools.js";
import type { RunPlan, RunState } from "../src/types.js";
import { testConfig } from "./helpers.js";

function runState(root: string): RunState {
  const now = new Date().toISOString();
  return {
    id: "plan-store",
    status: "running",
    phase: "planning",
    task: { task: "solve the attached challenge", attachments: [], metadata: {} },
    createdAt: now,
    updatedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "plan-store",
    scratchRoot: join(root, "scratch"),
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

function chainPlan(): RunPlan {
  return {
    goal: "recover the vault key",
    assumptions: [],
    hypotheses: ["the generator is deterministic"],
    steps: [
      { id: "map", objective: "inventory the container", successCriteria: [], tools: [] },
      { id: "derive", objective: "derive candidate key material", successCriteria: [], tools: [], dependsOn: ["map"] },
    ],
  };
}

describe("plan store", () => {
  it("rejects step updates before a plan exists and for unknown ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-plan-store-"));
    const state = runState(root);
    const toolSet = createToolSet({
      state,
      scope: testConfig(root).scope,
      runtime: testConfig(root).runtime,
      audit: new AuditChain(join(root, "audit.jsonl"), "plan-store"),
    });
    try {
      const update = toolSet.tools.find((tool) => tool.name === "update_plan_steps");
      expect(update).toBeDefined();
      await expect(update!.execute("t1", { updates: [{ id: "map", status: "in_progress" }] }))
        .rejects.toThrow(/Submit a plan with submit_plan/);

      const submit = toolSet.tools.find((tool) => tool.name === "submit_plan");
      await submit!.execute("t2", chainPlan());
      await expect(update!.execute("t3", { updates: [{ id: "missing", status: "in_progress" }] }))
        .rejects.toThrow(/Unknown plan step id: missing/);
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags dependency gates when a step starts before its dependency completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-plan-store-"));
    const state = runState(root);
    const auditPath = join(root, "audit.jsonl");
    const toolSet = createToolSet({
      state,
      scope: testConfig(root).scope,
      runtime: testConfig(root).runtime,
      audit: new AuditChain(auditPath, "plan-store"),
    });
    try {
      const submit = toolSet.tools.find((tool) => tool.name === "submit_plan");
      const update = toolSet.tools.find((tool) => tool.name === "update_plan_steps");
      await submit!.execute("t1", chainPlan());
      const gated = await update!.execute("t2", { updates: [{ id: "derive", status: "in_progress" }] });
      const text = (gated.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("▶ derive");
      expect(text).toContain("derive waits on map (pending)");
      expect(gated.details).toMatchObject({ unmetDependencies: ["derive waits on map (pending)"] });

      await update!.execute("t3", { updates: [{ id: "map", status: "completed" }] });
      const clear = await update!.execute("t4", { updates: [{ id: "derive", status: "in_progress", note: "replaying generation" }] });
      expect((clear.details as { unmetDependencies?: string[] }).unmetDependencies ?? []).toEqual([]);
      const clearText = (clear.content[0] as { type: "text"; text: string }).text;
      expect(clearText).toContain("Plan state (1/2 completed)");
      expect(clearText).toContain("replaying generation");

      const auditText = await readFile(auditPath, "utf8");
      expect(auditText).toContain("plan.steps_updated");
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-injects gated plan state on checkpoints only after the run adopts step statuses", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-plan-store-"));
    const state = runState(root);
    const toolSet = createToolSet({
      state,
      scope: testConfig(root).scope,
      runtime: testConfig(root).runtime,
      audit: new AuditChain(join(root, "audit.jsonl"), "plan-store"),
    });
    try {
      const submit = toolSet.tools.find((tool) => tool.name === "submit_plan");
      const update = toolSet.tools.find((tool) => tool.name === "update_plan_steps");
      const checkpoint = toolSet.tools.find((tool) => tool.name === "checkpoint");
      await submit!.execute("t1", chainPlan());

      const before = await checkpoint!.execute("t2", {
        observations: ["container mapped"],
        assessment: "inventory complete",
        planChanges: [],
        nextAction: "derive candidates",
      });
      const beforeText = (before.content[0] as { type: "text"; text: string }).text;
      expect(beforeText).not.toContain("Plan state (");

      // A plan submitted with statuses already declared also counts as adoption.
      await submit!.execute("t2b", {
        goal: "recover the vault key",
        assumptions: [],
        hypotheses: [],
        steps: chainPlan().steps.map((step) => ({ ...step, status: "pending" as const })),
      });
      const declared = await checkpoint!.execute("t2c", {
        observations: ["restarted"],
        assessment: "re-planning",
        planChanges: [],
        nextAction: "map",
      });
      expect((declared.content[0] as { type: "text"; text: string }).text).toContain("Plan state (0/2 completed)");

      await update!.execute("t3", { updates: [{ id: "map", status: "in_progress" }] });
      const after = await checkpoint!.execute("t4", {
        observations: ["started mapping"],
        assessment: "in progress",
        planChanges: [],
        nextAction: "finish mapping",
      });
      const afterText = (after.content[0] as { type: "text"; text: string }).text;
      expect(afterText).toContain("Checkpoint recorded");
      expect(afterText).toContain("Plan state (0/2 completed)");
      expect(afterText).toContain("▶ map");
      // map has no dependencies and derive is not running: no gate warning fires.
      expect(afterText).not.toContain("waits on");
    } finally {
      await toolSet.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders statuses in handoff and pure renderPlanStatus helpers", () => {
    const plan = chainPlan();
    plan.steps[0]!.status = "completed";
    plan.steps[1]!.status = "blocked";
    plan.steps[1]!.note = "generator unavailable offline";
    expect(planHasStepActivity(plan)).toBe(true);
    expect(planUnmetDependencies(plan)).toEqual([]);
    const rendered = renderPlanStatus(plan);
    expect(rendered).toContain("Plan state (1/2 completed)");
    expect(rendered).toContain("✔ map");
    expect(rendered).toContain("⊘ derive");
    expect(rendered).toContain("generator unavailable offline");

    const state = runState("/tmp");
    state.plan = plan;
    const handoff = renderRunHandoff(state);
    expect(handoff).toContain("[✔completed] map");
    expect(handoff).toContain("[⊘blocked] derive");

    const bare = chainPlan();
    bare.steps.forEach((step) => { delete step.status; });
    expect(planHasStepActivity({ ...bare, steps: bare.steps.map(({ note: _note, ...step }) => step) })).toBe(false);
  });
});

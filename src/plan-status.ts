import type { PlanStep, RunPlan } from "./types.js";

/**
 * ARTEX-style todolist semantics, adapted to zhulongx run state: a serial
 * dependency chain is recorded once via submit_plan (dependsOn), then
 * dispatched stepwise with update_plan_steps. Because the plan and its
 * statuses live in run state rather than the conversation, compaction and
 * resumes re-render the same chain instead of losing it.
 */

export function planStepMark(status: PlanStep["status"] | undefined): string {
  if (status === "completed") return "✔";
  if (status === "in_progress") return "▶";
  if (status === "blocked") return "⊘";
  return "☐";
}

/** Fact gates: steps running while their dependencies are not completed. */
export function planUnmetDependencies(plan: RunPlan): string[] {
  const unmet: string[] = [];
  for (const step of plan.steps) {
    if (step.status !== "in_progress") continue;
    for (const dependency of step.dependsOn ?? []) {
      const parent = plan.steps.find((item) => item.id === dependency);
      if (!parent) unmet.push(`${step.id}: unknown dependency ${dependency}`);
      else if (parent.status !== "completed") unmet.push(`${step.id} waits on ${dependency} (${parent.status ?? "pending"})`);
    }
  }
  return unmet;
}

/** True when the run actually adopted todolist semantics (statuses or notes). */
export function planHasStepActivity(plan: RunPlan | undefined): boolean {
  return Boolean(plan && plan.steps.some((step) => step.status !== undefined || step.note !== undefined));
}

export function renderPlanStatus(plan: RunPlan): string {
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const lines = [`Plan state (${completed}/${plan.steps.length} completed):`];
  for (const step of plan.steps) {
    const deps = step.dependsOn?.length ? ` [depends on ${step.dependsOn.join(",")}]` : "";
    const note = step.note ? ` — ${step.note}` : "";
    lines.push(`${planStepMark(step.status)} ${step.id}: ${step.objective.slice(0, 120)}${deps}${note}`);
  }
  const unmet = planUnmetDependencies(plan);
  if (unmet.length > 0) {
    lines.push("Dependency gates not satisfied — these steps started before their dependencies completed; verify the missing facts exist before continuing:");
    lines.push(...unmet.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

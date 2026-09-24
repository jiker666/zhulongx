import { describe, expect, it } from "vitest";
import { OBSERVER_ESCALATION_THRESHOLDS, observerEscalations } from "../src/tool-adapter.js";

describe("observer escalation thresholds", () => {
  it("escalates repeated_action at the threshold", () => {
    const escalations = observerEscalations(
      [{ kind: "repeated_action", detail: "identical run_command call", occurrences: OBSERVER_ESCALATION_THRESHOLDS.repeated_action }],
      new Set(),
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.kind).toBe("repeated_action");
    expect(escalations[0]?.text).toContain("change the approach");
  });

  it("stays silent below the threshold", () => {
    expect(observerEscalations(
      [{ kind: "repeated_action", detail: "identical call", occurrences: OBSERVER_ESCALATION_THRESHOLDS.repeated_action - 1 }],
      new Set(),
    )).toHaveLength(0);
  });

  it("escalates each kind at most once", () => {
    const escalated = new Set(["repeated_action"]);
    expect(observerEscalations(
      [{ kind: "repeated_action", detail: "identical call", occurrences: 99 }],
      escalated,
    )).toHaveLength(0);
    const fresh = observerEscalations(
      [{ kind: "checkpoint_gap", detail: "many actions elapsed", occurrences: OBSERVER_ESCALATION_THRESHOLDS.checkpoint_gap }],
      escalated,
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.kind).toBe("checkpoint_gap");
    expect(fresh[0]?.text).toContain("Persist a checkpoint");
  });

  it("ignores kinds without a threshold", () => {
    expect(observerEscalations(
      [{ kind: "budget_spend", detail: "anything", occurrences: 1000 }],
      new Set(),
    )).toHaveLength(0);
  });
});

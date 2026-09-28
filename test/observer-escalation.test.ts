import { describe, expect, it } from "vitest";
import { OBSERVER_ESCALATION_THRESHOLDS, observerEscalations, observerEscalationTier } from "../src/tool-adapter.js";

const emptyTiers = new Map<string, number>();

describe("observer escalation thresholds", () => {
  it("escalates repeated_action at the threshold", () => {
    const escalations = observerEscalations(
      [{ kind: "repeated_action", detail: "identical run_command call", occurrences: OBSERVER_ESCALATION_THRESHOLDS.repeated_action! }],
      emptyTiers,
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.kind).toBe("repeated_action");
    expect(escalations[0]?.text).toContain("change the approach");
  });

  it("stays silent below the threshold", () => {
    expect(observerEscalations(
      [{ kind: "repeated_action", detail: "identical call", occurrences: OBSERVER_ESCALATION_THRESHOLDS.repeated_action! - 1 }],
      emptyTiers,
    )).toHaveLength(0);
  });

  it("does not re-escalate the same tier", () => {
    const escalated = new Map<string, number>([["repeated_action", 1]]);
    expect(observerEscalations(
      [{ kind: "repeated_action", detail: "identical call", occurrences: OBSERVER_ESCALATION_THRESHOLDS.repeated_action! }],
      escalated,
    )).toHaveLength(0);
    const fresh = observerEscalations(
      [{ kind: "checkpoint_gap", detail: "many actions elapsed", occurrences: OBSERVER_ESCALATION_THRESHOLDS.checkpoint_gap! }],
      escalated,
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.kind).toBe("checkpoint_gap");
    expect(fresh[0]?.tier).toBe(1);
    expect(fresh[0]?.text).toContain("Persist a checkpoint");
  });

  it("re-escalates at higher tiers as the loop persists (9837)", () => {
    const tier1 = new Map<string, number>([["repeated_action", 1]]);
    const t2 = observerEscalations(
      [{ kind: "repeated_action", detail: "identical run_command call", occurrences: OBSERVER_ESCALATION_THRESHOLDS.repeated_action! * 4 }],
      tier1,
    );
    expect(t2).toHaveLength(1);
    expect(t2[0]?.tier).toBe(2);
    expect(t2[0]?.text).toContain("exhausted");
    const tier2 = new Map<string, number>([["repeated_action", 2]]);
    const t3 = observerEscalations(
      [{ kind: "repeated_action", detail: "identical run_command call", occurrences: OBSERVER_ESCALATION_THRESHOLDS.repeated_action! * 16 }],
      tier2,
    );
    expect(t3).toHaveLength(1);
    expect(t3[0]?.tier).toBe(3);
    expect(t3[0]?.text).toContain("Abandon this approach");
    // tier 3 already escalated: silent even at 1280 occurrences
    expect(observerEscalations(
      [{ kind: "repeated_action", detail: "identical run_command call", occurrences: 1280 }],
      new Map<string, number>([["repeated_action", 3]]),
    )).toHaveLength(0);
  });

  it("computes tiers from occurrences", () => {
    expect(observerEscalationTier("repeated_action", 4)).toBe(0);
    expect(observerEscalationTier("repeated_action", 5)).toBe(1);
    expect(observerEscalationTier("repeated_action", 20)).toBe(2);
    expect(observerEscalationTier("repeated_action", 80)).toBe(3);
    expect(observerEscalationTier("budget_spend", 1000)).toBe(0);
  });

  it("ignores kinds without a threshold", () => {
    expect(observerEscalations(
      [{ kind: "budget_spend", detail: "anything", occurrences: 1000 }],
      emptyTiers,
    )).toHaveLength(0);
  });
});

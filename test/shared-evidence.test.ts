import { describe, expect, it } from "vitest";
import { SharedEvidenceBoard } from "../src/shared-evidence.js";

describe("SharedEvidenceBoard", () => {
  it("deduplicates corroboration, redacts credential text, and evicts old entries within bounds", () => {
    const board = new SharedEvidenceBoard(2, 4096);
    const first = board.publish("run-a", {
      kind: "fact",
      claim: "Authorization: Bearer example-sensitive-value",
      evidence: ["Cookie: session=example-sensitive-cookie"],
      confidence: 0.7,
    });
    const duplicate = board.publish("run-b", {
      kind: "fact",
      claim: "authorization: bearer another-sensitive-value",
      evidence: ["access_token=another-sensitive-value"],
      confidence: 0.9,
    });

    expect(first.entry.claim).toBe("Authorization: [redacted]");
    expect(first.entry.evidence).toEqual(["Cookie: [redacted]"]);
    expect(duplicate).toMatchObject({ deduplicated: true, entry: { confidence: 0.9 } });
    expect(duplicate.entry.sourceRunIds).toEqual(["run-a", "run-b"]);
    expect(JSON.stringify(duplicate.entry)).not.toContain("sensitive-value");

    board.publish("run-c", {
      kind: "candidate",
      claim: "A bounded candidate",
      evidence: ["derived from artifact bytes 10-20"],
      confidence: 0.6,
    });
    board.publish("run-d", {
      kind: "dead-end",
      claim: "The first parser branch contradicts the file magic",
      evidence: ["magic was ELF while the branch assumed ZIP"],
      confidence: 0.8,
    });

    const snapshot = board.snapshot();
    expect(snapshot.totalEntries).toBe(2);
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual(["candidate", "dead-end"]);
    expect(snapshot.truncated).toBe(false);
  });

  it("returns cloned bounded snapshots", () => {
    const board = new SharedEvidenceBoard();
    board.publish("run-a", {
      kind: "fact",
      claim: "Observed deterministic output",
      evidence: ["tool returned exitCode=0"],
      confidence: 1,
    });

    const first = board.snapshot(1);
    first.entries[0]?.evidence.push("mutated by caller");

    expect(board.snapshot(1).entries[0]?.evidence).toEqual(["tool returned exitCode=0"]);
  });
});

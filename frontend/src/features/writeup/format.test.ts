import { describe, expect, it } from "vitest";
import { renderWriteup } from "./format";

describe("writeup formatter", () => {
  it("renders the submission template and keeps the exact structured flag", () => {
    const output = renderWriteup({
      task: "Solve the [Very Easy] Primary Knowledge challenge",
      report: "The modulus is prime.\n\n## Verification\n\nRound trip passed.\nFLAG: HTB{verified}",
      submission: "HTB{verified}",
      metadata: { category: "crypto", source: "hackthebox", difficulty: "easy", points: "100" },
      finishedAt: "2026-08-24T10:00:00.000Z",
    });

    expect(output).toContain('title: "[Very Easy] Primary Knowledge challenge"');
    expect(output).toContain("category: crypto");
    expect(output).toContain("## Summary");
    expect(output).toContain("## Solution");
    expect(output).toContain("### Step 1:");
    expect(output).toContain("The modulus is prime.");
    expect(output).toContain("## Flag\n\n```\nHTB{verified}\n```");
    expect(output).not.toContain("FLAG: HTB{verified}");
  });

  it("does not invent a solving script when the report did not persist one", () => {
    const output = renderWriteup({ task: "A challenge", report: "Observed a verified result.", submission: "flag{result}" });
    expect(output).toContain("No complete solving script was persisted");
    expect(output).toContain("flag{result}");
  });
});

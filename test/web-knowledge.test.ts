import { describe, expect, it } from "vitest";
import { searchWebKnowledge } from "../src/agents/web/web-knowledge.js";

describe("Web knowledge base", () => {
  it("returns evidence-oriented records without payload spraying instructions", () => {
    const matches = searchWebKnowledge("upload extension MIME verification");
    expect(matches[0]?.name).toBe("file_upload");
    expect(matches[0]?.verification.length).toBeGreaterThan(0);
    expect(matches[0]?.tests.join(" ")).not.toMatch(/reverse shell|dropper/i);
  });
});


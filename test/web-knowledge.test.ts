import { describe, expect, it } from "vitest";
import { listWebKnowledge, searchWebKnowledge } from "../src/agents/web/web-knowledge.js";

describe("Web knowledge base", () => {
  it("returns evidence-oriented records without payload spraying instructions", () => {
    const matches = searchWebKnowledge("upload extension MIME verification");
    expect(matches[0]?.name).toBe("file_upload");
    expect(matches[0]?.verification.length).toBeGreaterThan(0);
    expect(matches[0]?.tests.join(" ")).not.toMatch(/reverse shell|dropper/i);
  });

  it("does not embed target-specific paths, answer templates, hosts, or local operator files", () => {
    const rendered = JSON.stringify(listWebKnowledge());
    expect(rendered).not.toMatch(/[A-Za-z][A-Za-z0-9_-]{1,63}\{[^{}]+\}|http:\/\/target|\/Users\/|\/proc\/self|\.git\/HEAD/i);
    expect(rendered).not.toMatch(/cat \/|\/challenge\/|internal-svc/i);
  });
});

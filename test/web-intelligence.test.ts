import { describe, expect, it } from "vitest";
import { createJavaScriptInput } from "../src/web-reasoning/javascript/intake.js";
import { StaticJavaScriptAnalyzer } from "../src/web-reasoning/javascript/adapter.js";
import { createResponseSnapshot, compareResponseSnapshots, compareTiming, normalizeResponseBody } from "../src/web-reasoning/response-diff.js";
import { WebActionGuard } from "../src/web-reasoning/action-guard.js";
import { createInitialWebReasoningState } from "../src/web-reasoning/state.js";

describe("JavaScript static intelligence", () => {
  it("extracts resolved and partial network calls, routes, storage metadata, dependencies, and source maps", async () => {
    const content = `const base = "/api"; const path = base + "/user";\nfetch(path, { headers: { Authorization: "Bearer real-token", "X-CSRF": "x" }, body: { username: "demo", token: "hidden" } });\naxios.get("/api/items"); router.push("/admin"); localStorage.setItem("access_token", "secret"); import("./chunk.js"); //# sourceMappingURL=app.js.map`;
    const input = createJavaScriptInput({ id: "script-1", source: "artifact", content, sourceUrl: "app.js", evidenceIds: ["ev-1"], maxBytes: 16_384 });
    const result = await new StaticJavaScriptAnalyzer().analyze(input);
    expect(result.status).toBe("completed");
    expect(result.networkCalls.some((call) => call.url.status === "resolved" && call.url.value === "/api/user")).toBe(true);
    expect(result.networkCalls.some((call) => call.headerNames.includes("Authorization"))).toBe(true);
    expect(result.routes.some((route) => route.path.status === "resolved" && route.path.value === "/admin")).toBe(true);
    expect(result.storageFindings.some((finding) => finding.name === "access_token")).toBe(true);
    expect(result.scriptDependencies.some((item) => item.source === "./chunk.js")).toBe(true);
    expect(result.sourceMapFindings[0]?.url).toBe("app.js.map");
    expect(JSON.stringify(result)).not.toContain("real-token");
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("supports TypeScript/JSX/CommonJS, partial parsing, size limits, and AbortSignal", async () => {
    const analyzer = new StaticJavaScriptAnalyzer();
    const tsResult = await analyzer.analyze(createJavaScriptInput({ id: "ts", source: "artifact", content: "const value: string = '/x'; export default value;", sourceUrl: "page.ts", evidenceIds: [], maxBytes: 1000 }));
    expect(tsResult.language).toBe("typescript");
    const jsxResult = await analyzer.analyze(createJavaScriptInput({ id: "jsx", source: "artifact", content: "export const View = () => <div />;", sourceUrl: "page.jsx", evidenceIds: [], maxBytes: 1000 }));
    expect(jsxResult.language).toBe("jsx");
    const cjsResult = await analyzer.analyze(createJavaScriptInput({ id: "cjs", source: "artifact", content: "const fs = require('fs');", sourceUrl: "page.cjs", evidenceIds: [], maxBytes: 1000 }));
    expect(cjsResult.moduleKind).toBe("commonjs");
    const limited = await analyzer.analyze({ id: "large", source: "artifact", content: "x".repeat(20), contentHash: "hash", evidenceIds: [], maxBytes: 10 });
    expect(limited.status).toBe("size_limited");
    const abort = new AbortController(); abort.abort();
    expect((await analyzer.analyze(createJavaScriptInput({ id: "abort", source: "artifact", content: "fetch('/x')", evidenceIds: [], maxBytes: 1000 }), abort.signal)).status).toBe("aborted");
  });
});

describe("semantic Response Diff", () => {
  it("normalizes dynamic values and compares JSON, headers, status, and reflection", () => {
    expect(normalizeResponseBody('{"b":2,"a":1,"nonce":"nonce-123"}', "application/json")).toBe('{"a":1,"b":2,"nonce":"nonce=<dynamic>"}');
    const left = createResponseSnapshot({ source: "tool", status: 200, headers: { "content-type": "application/json", "x-a": "1" }, contentType: "application/json", bodyPreview: '{"ok":true,"id":"12345678901"}' });
    const right = createResponseSnapshot({ source: "tool", status: 302, headers: { "content-type": "text/html", "x-b": "1" }, contentType: "text/html", bodyPreview: "<html> marker </html>", inputMarkers: ["marker"] });
    const diff = compareResponseSnapshots(left, right, { evidenceIds: ["ev-diff"] });
    expect(diff.signals.map((signal) => signal.kind)).toEqual(expect.arrayContaining(["status_change", "header_change", "content_type_change", "text_change", "input_reflection"]));
    expect(diff.signals.every((signal) => signal.evidenceIds.length > 0)).toBe(true);
  });

  it("requires repeated stable timing samples and marks noisy samples", () => {
    const stable = compareTiming([100, 101, 99], [150, 151, 149], 3);
    expect(stable.sampleSufficient).toBe(true);
    expect(stable.varianceWarning).toBe(false);
    const noisy = compareTiming([10, 1000, 20], [30, 900, 40], 3);
    expect(noisy.varianceWarning).toBe(true);
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const guard = new WebActionGuard();
    expect(guard.validate(undefined, { toolName: "run_command", args: { program: "node" } }, state, ["run_command"]).decision).toBe("reject_phase_mismatch");
  });
});

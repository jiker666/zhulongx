import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createInitialWebReasoningState } from "../src/web-reasoning/state.js";
import { ControlledBrowserRuntime } from "../src/web-reasoning/browser/runtime.js";

function startFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/api/data") {
      response.writeHead(200, { "content-type": "application/json", "x-fixture": "local" });
      response.end(JSON.stringify({ ok: true, nonce: "fixture-nonce" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Local Browser Fixture</title><script>" +
      "fetch('/api/data').then(() => document.body.dataset.loaded = 'true');" +
      "function changeState() { document.querySelector('#status').textContent = 'changed'; }" +
      "</script></head><body><h1>Controlled fixture</h1>" +
      "<button aria-label='Change state' onclick='changeState()'>Change</button>" +
      "<p id='status'>initial</p><form action='/submit' method='post'>" +
      "<label>Name<input name='name' placeholder='Name'></label></form></body></html>");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Fixture did not receive a TCP port"));
      resolve({ server, port: address.port });
    });
  });
}

describe("live local controlled Browser Session", () => {
  it("creates a real Chromium session, captures DOM/network, interacts, transitions, and closes", async () => {
    const fixture = await startFixture();
    const state = createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
    const scope = { mode: "controlled" as const, workspaceRoot: process.cwd(), allowedHosts: ["127.0.0.1:" + fixture.port], allowedPrograms: [] };
    const runtime = new ControlledBrowserRuntime({ runId: "live-browser-test", scope, state: state.browser!, config: { maxSessionsPerRun: 1, maxPagesPerSession: 1, maxActionsPerRun: 10, maxNavigationsPerRun: 3 } });
    try {
      expect(runtime.capability.available).toBe(true);
      const session = await runtime.execute({ action: "create_session" });
      const sessionId = String(session.details.sessionId);
      const page = await runtime.execute({ action: "open_page", sessionId, url: "http://127.0.0.1:" + fixture.port + "/" });
      const pageId = String(page.details.pageId);
      const initialDom = await runtime.execute({ action: "capture_dom", sessionId, pageId });
      expect(Number(initialDom.details.elementCount)).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(state.browser?.networkEventSummaries.some((event) => event.kind === "response" && event.url.endsWith("/api/data"))).toBe(true);
      const clicked = await runtime.execute({ action: "click", sessionId, pageId, target: { type: "semantic", role: "button", name: "Change state" } });
      expect(clicked.details.visibleTextChanged).toBe(true);
      const assertion = await runtime.execute({ action: "assert_state", sessionId, pageId, expectedText: "changed" });
      expect(Number(assertion.details.elementCount)).toBeGreaterThan(0);
      const network = await runtime.execute({ action: "capture_network_summary", sessionId, pageId });
      expect(Array.isArray(network.details.events)).toBe(true);
      expect(state.browser?.stateTransitions.length).toBeGreaterThan(0);
      await runtime.execute({ action: "close_session", sessionId });
      expect(state.browser?.sessions.find((item) => item.id === sessionId)?.status).toBe("closed");
    } finally {
      await runtime.cleanup();
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  }, 30_000);
});

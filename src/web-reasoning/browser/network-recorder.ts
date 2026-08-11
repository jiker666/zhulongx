import { createHash } from "node:crypto";
import { newId } from "../state.js";
import type { Page, Request, Response } from "playwright";
import type { BrowserNetworkEvent } from "./types.js";
import type { JsonSafeValue } from "../types.js";
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function headerNames(headers: Record<string, string>): string[] { return Object.keys(headers).map((key) => key.toLowerCase()).sort(); }
function bodyShape(value: string | null): Record<string, JsonSafeValue> | undefined { if (!value) return undefined; try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { keys: Object.keys(parsed).filter((key) => !/password|token|secret|cookie|authorization|csrf/i.test(key)).sort(), hash: hash(value), length: value.length }; } catch { /* bounded fingerprint only */ } return { hash: hash(value), length: value.length }; }
export class BrowserNetworkRecorder {
  readonly events: BrowserNetworkEvent[] = [];
  constructor(private readonly maxEvents = 500) {}
  attach(page: Page, sessionId: string, pageId: string): () => void {
    const onRequest = (request: Request) => { this.push({ id: newId("net"), sessionId, pageId, kind: "request", url: request.url(), origin: new URL(request.url()).origin, method: request.method(), resourceType: request.resourceType(), requestHeaderNames: headerNames(request.headers()), responseHeaderNames: [], requestBodyShape: bodyShape(request.postData()), timestamp: new Date().toISOString() }); };
    const onResponse = (response: Response) => { this.push({ id: newId("net"), sessionId, pageId, kind: "response", url: response.url(), origin: new URL(response.url()).origin, status: response.status(), resourceType: response.request().resourceType(), requestHeaderNames: headerNames(response.request().headers()), responseHeaderNames: headerNames(response.headers()), responseSummary: { status: response.status(), contentType: response.headers()["content-type"]?.split(";", 1)[0] ?? "", bodyAvailable: response.request().resourceType() !== "media" }, timestamp: new Date().toISOString() }); };
    const onFailed = (request: Request) => { this.push({ id: newId("net"), sessionId, pageId, kind: "failure", url: request.url(), origin: new URL(request.url()).origin, method: request.method(), resourceType: request.resourceType(), requestHeaderNames: headerNames(request.headers()), responseHeaderNames: [], responseSummary: { failure: request.failure()?.errorText ?? "request_failed" }, timestamp: new Date().toISOString() }); };
    page.on("request", onRequest); page.on("response", onResponse); page.on("requestfailed", onFailed); return () => { page.off("request", onRequest); page.off("response", onResponse); page.off("requestfailed", onFailed); };
  }
  recordBlocked(sessionId: string, pageId: string, url: string, reason: string): void { this.push({ id: newId("net"), sessionId, pageId, kind: "failure", url, origin: (() => { try { return new URL(url).origin; } catch { return "[invalid]"; } })(), requestHeaderNames: [], responseHeaderNames: [], responseSummary: { blocked: true, reason }, timestamp: new Date().toISOString() }); }
  private push(event: BrowserNetworkEvent): void { this.events.push(event); if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents); }
}

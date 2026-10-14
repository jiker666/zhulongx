import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionGate, PermissionRequest, PermissionResolution } from "../permissions.js";
import type { ToolRisk } from "../tool-catalog.js";

/**
 * Enterprise guard (ARTEX Intercept): operator-authored allow/ask/deny rules
 * evaluated BEFORE the existing permission broker on EVERY risk-carrying tool
 * call. "deny" blocks immediately with the rule message; "ask" holds the call
 * for operator resolution through this store (independent of the broker's own
 * approval policy, which may be "never" in autonomous arenas); "allow" and
 * no-match delegate to the wrapped broker unchanged. Audited + persisted.
 */

export interface GuardRule {
  id: string; name: string; enabled: boolean; priority: number;
  matchTarget: "tool_name" | "tool_input"; matchType: "string" | "regex";
  pattern: string; action: "allow" | "deny" | "ask";
  message: string; createdAt: string; updatedAt: string;
}
export interface GuardPending {
  id: string; ruleId?: string; sessionId: string; toolName: string;
  toolInputSummary: string; createdAt: string; expiresAt: string;
}
interface GuardDocument {
  schemaVersion: 1;
  rules: GuardRule[];
  audit: Array<{ id: string; at: string; ruleId?: string; action: string; toolName: string; sessionId: string; message: string }>;
  updatedAt: string;
}

const RULES_BOUND = 128;
const AUDIT_BOUND = 500;

function nowIso(): string { return new Date().toISOString(); }

export class GuardStore {
  private doc: GuardDocument = { schemaVersion: 1, rules: [], audit: [], updatedAt: nowIso() };
  private ready = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, { request: GuardPending; resolve: (decision: "approve" | "deny") => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly file: string, private readonly askTimeoutMs = 300_000) {}

  private async load(): Promise<GuardDocument> {
    if (this.ready) return this.doc;
    try { this.doc = { ...this.doc, ...(JSON.parse(await readFile(this.file, "utf8")) as Partial<GuardDocument>) }; } catch { /* fresh store */ }
    this.ready = true;
    return this.doc;
  }

  private persist(): void {
    this.doc.updatedAt = nowIso();
    const snapshot = this.doc;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(join(this.file, ".."), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
        await rename(tmp, this.file);
      } catch { /* persistence failures must never fail the gate */ }
    });
  }

  async listRules(): Promise<GuardRule[]> { return (await this.load()).rules; }

  async addRule(input: Omit<GuardRule, "id" | "createdAt" | "updatedAt">): Promise<GuardRule> {
    if (input.matchType === "regex") { try { new RegExp(input.pattern); } catch (error) { throw new Error(`invalid regex: ${error instanceof Error ? error.message : String(error)}`); } }
    const rule: GuardRule = { ...input, name: input.name.slice(0, 120), message: (input.message ?? "").slice(0, 400), id: `gr_${randomUUID().slice(0, 8)}`, createdAt: nowIso(), updatedAt: nowIso() };
    const doc = await this.load();
    doc.rules.push(rule);
    doc.rules = doc.rules.sort((left, right) => right.priority - left.priority).slice(0, RULES_BOUND);
    this.persist();
    return rule;
  }

  async updateRule(id: string, patch: Partial<Omit<GuardRule, "id" | "createdAt">>): Promise<GuardRule | undefined> {
    const doc = await this.load();
    const rule = doc.rules.find((item) => item.id === id);
    if (!rule) return undefined;
    Object.assign(rule, { ...patch, updatedAt: nowIso() });
    doc.rules = doc.rules.sort((left, right) => right.priority - left.priority);
    this.persist();
    return rule;
  }

  async removeRule(id: string): Promise<boolean> {
    const doc = await this.load();
    const index = doc.rules.findIndex((item) => item.id === id);
    if (index === -1) return false;
    doc.rules.splice(index, 1);
    this.persist();
    return true;
  }

  listPending(): GuardPending[] {
    return [...this.pending.values()].map((item) => item.request).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  resolvePending(id: string, decision: "approve" | "deny"): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }

  private audit(entry: GuardDocument["audit"][number]): void {
    this.doc.audit.push(entry);
    this.doc.audit = this.doc.audit.slice(-AUDIT_BOUND);
    this.persist();
  }

  /** First match wins, priority desc (ARTEX intercept semantics); compiled once per call. */
  private match(toolName: string, args: unknown): GuardRule | undefined {
    const inputText = JSON.stringify(args ?? {});
    for (const rule of this.doc.rules) {
      if (!rule.enabled) continue;
      const haystack = rule.matchTarget === "tool_name" ? toolName : inputText;
      const hit = rule.matchType === "regex"
        ? new RegExp(rule.pattern).test(haystack)
        : haystack.includes(rule.pattern);
      if (hit) return rule;
    }
    return undefined;
  }

  /** Wraps any PermissionGate; rules short-circuit, everything else delegates. */
  wrap(inner: PermissionGate): PermissionGate {
    const store = this;
    return {
      authorize: async (input: { sessionId: string; toolCallId: string; toolName: string; args: unknown; risk: ToolRisk }, signal?: AbortSignal): Promise<PermissionResolution> => {
        await store.load();
        const rule = store.match(input.toolName, input.args);
        if (!rule || rule.action === "allow") {
          if (rule) store.audit({ id: `ga_${randomUUID().slice(0, 8)}`, at: nowIso(), ruleId: rule?.id, action: "allow", toolName: input.toolName, sessionId: input.sessionId, message: "" });
          return await inner.authorize(input, signal);
        }
        if (rule.action === "deny") {
          store.audit({ id: `ga_${randomUUID().slice(0, 8)}`, at: nowIso(), ruleId: rule.id, action: "deny", toolName: input.toolName, sessionId: input.sessionId, message: rule.message });
          const request: PermissionRequest = { id: `gp_${randomUUID().slice(0, 8)}`, sessionId: input.sessionId, toolCallId: input.toolCallId, toolName: input.toolName, summary: rule.message || `Blocked by guard rule ${rule.name}`, risk: input.risk.level, args: input.args, createdAt: nowIso(), expiresAt: nowIso() };
          return { request, decision: "deny", resolvedAt: nowIso(), source: "policy" };
        }
        // ask: hold independently of the broker policy; the UI resolves it.
        const request: GuardPending = {
          id: `gp_${randomUUID().slice(0, 8)}`, ruleId: rule.id, sessionId: input.sessionId, toolName: input.toolName,
          toolInputSummary: JSON.stringify(input.args ?? {}).slice(0, 400), createdAt: nowIso(), expiresAt: new Date(Date.now() + store.askTimeoutMs).toISOString(),
        };
        store.audit({ id: `ga_${randomUUID().slice(0, 8)}`, at: nowIso(), ruleId: rule.id, action: "ask", toolName: input.toolName, sessionId: input.sessionId, message: rule.message });
        const decision = await new Promise<"approve" | "deny">((resolveAsk) => {
          const timer = setTimeout(() => { store.pending.delete(request.id); resolveAsk("deny"); }, store.askTimeoutMs);
          store.pending.set(request.id, { request, resolve: resolveAsk, timer });
          signal?.addEventListener("abort", () => { clearTimeout(timer); store.pending.delete(request.id); resolveAsk("deny"); }, { once: true });
          if (signal?.aborted) { clearTimeout(timer); store.pending.delete(request.id); resolveAsk("deny"); }
        });
        store.audit({ id: `ga_${randomUUID().slice(0, 8)}`, at: nowIso(), ruleId: rule.id, action: decision === "approve" ? "ask-approved" : "ask-denied", toolName: input.toolName, sessionId: input.sessionId, message: rule.message });
        const permissionRequest: PermissionRequest = { id: request.id, sessionId: input.sessionId, toolCallId: input.toolCallId, toolName: input.toolName, summary: rule.message || `Guard rule ${rule.name} requested approval`, risk: input.risk.level, args: input.args, createdAt: request.createdAt, expiresAt: request.expiresAt };
        return { request: permissionRequest, decision: decision === "approve" ? "approve_once" : "deny", resolvedAt: nowIso(), source: "operator" };
      },
      ...(inner.cancelSession ? { cancelSession: (sessionId: string, reason?: string) => inner.cancelSession!(sessionId, reason) } : {}),
    };
  }

  async auditTrail(limit = 100) {
    const doc = await this.load();
    return doc.audit.slice(-limit).reverse();
  }

  async snapshot(): Promise<GuardDocument> { return await this.load(); }
}

import { randomUUID } from "node:crypto";
import type { ToolRisk } from "./tool-catalog.js";

export type ApprovalPolicy = "always" | "on-request" | "never";
export type PermissionDecision = "deny" | "approve_once" | "approve_session";

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  risk: ToolRisk["level"];
  args: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface PermissionResolution {
  request: PermissionRequest;
  decision: PermissionDecision;
  resolvedAt: string;
  source: "operator" | "policy" | "session" | "abort" | "timeout";
}

export interface PermissionGate {
  authorize(input: { sessionId: string; toolCallId: string; toolName: string; args: unknown; risk: ToolRisk }, signal?: AbortSignal): Promise<PermissionResolution>;
  cancelSession?(sessionId: string, reason?: string): void;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (resolution: PermissionResolution) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

export class PermissionBroker implements PermissionGate {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly sessionApprovals = new Map<string, Set<string>>();

  constructor(readonly policy: ApprovalPolicy, readonly timeoutMs = 120_000, readonly maxPending = 100) {}

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((item) => item.request).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async authorize(input: { sessionId: string; toolCallId: string; toolName: string; args: unknown; risk: ToolRisk }, signal?: AbortSignal): Promise<PermissionResolution> {
    const request = this.request(input);
    if (this.sessionApprovals.get(input.sessionId)?.has(input.toolName)) return this.resolution(request, "approve_session", "session");
    if (this.policy === "never" || (this.policy === "on-request" && !input.risk.requiresApproval)) {
      return this.resolution(request, "approve_once", "policy");
    }
    if (this.pending.size >= this.maxPending) return this.resolution(request, "deny", "policy");
    return await new Promise<PermissionResolution>((resolvePermission) => {
      const finish = (resolution: PermissionResolution) => {
        const pending = this.pending.get(request.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (pending.abort) signal?.removeEventListener("abort", pending.abort);
        this.pending.delete(request.id);
        if (resolution.decision === "approve_session") {
          const approvals = this.sessionApprovals.get(request.sessionId) ?? new Set<string>();
          approvals.add(request.toolName);
          this.sessionApprovals.set(request.sessionId, approvals);
        }
        resolvePermission(resolution);
      };
      const timer = setTimeout(() => finish(this.resolution(request, "deny", "timeout")), this.timeoutMs);
      const abort = () => finish(this.resolution(request, "deny", "abort"));
      this.pending.set(request.id, { request, resolve: finish, timer, ...(signal ? { abort } : {}) });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  resolve(id: string, decision: PermissionDecision): PermissionResolution | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    const resolution = this.resolution(pending.request, decision, "operator");
    pending.resolve(resolution);
    return resolution;
  }

  cancelSession(sessionId: string): void {
    for (const item of [...this.pending.values()]) {
      if (item.request.sessionId === sessionId) item.resolve(this.resolution(item.request, "deny", "abort"));
    }
    this.sessionApprovals.delete(sessionId);
  }

  private request(input: { sessionId: string; toolCallId: string; toolName: string; args: unknown; risk: ToolRisk }): PermissionRequest {
    const created = Date.now();
    return { id: randomUUID(), sessionId: input.sessionId, toolCallId: input.toolCallId, toolName: input.toolName, summary: input.risk.summary.slice(0, 500), risk: input.risk.level, args: input.args, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + this.timeoutMs).toISOString() };
  }

  private resolution(request: PermissionRequest, decision: PermissionDecision, source: PermissionResolution["source"]): PermissionResolution {
    return { request, decision, source, resolvedAt: new Date().toISOString() };
  }
}

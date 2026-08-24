import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isActionDescriptor, toolDescriptorMap, type ToolDescriptor } from "./tool-catalog.js";
import type { ArenaConfig, DascConfig, RuntimeConfig, RunState, ScopeConfig } from "./types.js";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  signature: string;
}

const META_TOOLS = new Set(["submit_plan", "checkpoint", "record_finding", "record_lesson", "finish_task"]);
const ACTION_TOOLS = new Set([
  "list_files",
  "read_file",
  "inspect_artifact",
  "extract_archive",
  "search_artifact",
  "observe_image",
  "list_scratch_files",
  "read_scratch_file",
  "write_scratch_file",
  "run_command",
  "http_request",
  "web_collect_baseline",
  "web_knowledge_lookup",
  "web_compare_responses",
  "web_timing_stats",
  "browser",
  "tcp_open",
  "tcp_send",
  "tcp_receive",
  "tcp_close",
  "read_shared_evidence",
  "publish_shared_evidence",
]);

function signature(toolName: string, args: unknown): string {
  return createHash("sha256").update(`${toolName}:${JSON.stringify(args)}`).digest("hex").slice(0, 16);
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveWorkspacePath(root: string, input: string): string {
  const candidate = resolve(root, input);
  if (!isPathInside(root, candidate)) throw new Error(`Path escapes workspace: ${input}`);
  return candidate;
}

export function hostMatches(host: string, allowed: string): boolean {
  const pattern = splitAuthority(allowed.toLowerCase());
  const value = splitAuthority(host.toLowerCase());
  if (pattern.port !== undefined) {
    if (pattern.port !== "*" && value.port !== pattern.port) return false;
    if (value.port === undefined) return false;
  } else if (value.port !== undefined) {
    return false;
  }
  if (pattern.host.includes("*")) {
    const escaped = pattern.host.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(value.host);
  }
  return value.host === pattern.host;
}

function splitAuthority(authority: string): { host: string; port?: string } {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end > 0) {
      const host = authority.slice(0, end + 1);
      const suffix = authority.slice(end + 1);
      return suffix.startsWith(":") ? { host, port: suffix.slice(1) } : { host };
    }
  }
  const colon = authority.lastIndexOf(":");
  if (colon > 0) {
    const port = authority.slice(colon + 1);
    if (port === "*" || /^\d+$/.test(port)) return { host: authority.slice(0, colon), port };
  }
  return { host: authority };
}

function isRelativeSafePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.includes("\0") && !value.split(/[\\/]/).includes("..");
}

function isAllowedAbsolutePath(runtime: RuntimeConfig, scope: ScopeConfig, value: string): boolean {
  return isPathInside(scope.workspaceRoot, value) || isPathInside(runtime.scratchRoot, value);
}

function tcpAuthority(host: string, port: number): string {
  return `${host}:${port}`;
}

export class PolicyEngine {
  private readonly descriptors: Map<string, ToolDescriptor>;

  constructor(
    readonly scope: ScopeConfig,
    readonly runtime: RuntimeConfig,
    externalDescriptors: ToolDescriptor[] = [],
  ) {
    this.descriptors = toolDescriptorMap(externalDescriptors);
  }

  evaluate(toolName: string, args: unknown, state: RunState): PolicyDecision {
    const actionSignature = signature(toolName, args);
    const descriptor = this.descriptors.get(toolName);
    if (!descriptor || (!META_TOOLS.has(toolName) && !ACTION_TOOLS.has(toolName) && descriptor.source === "builtin")) {
      return { allowed: false, reason: `Unknown tool: ${toolName}`, signature: actionSignature };
    }
    const action = ACTION_TOOLS.has(toolName) || (descriptor.source !== "builtin" && isActionDescriptor(descriptor));
    if (state.toolCalls >= this.runtime.maxToolCalls) {
      return { allowed: false, reason: "Tool-call budget exhausted", signature: actionSignature };
    }
    if (!state.plan && toolName !== "submit_plan" && toolName !== "finish_task") {
      return { allowed: false, reason: "A plan must be submitted before actions", signature: actionSignature };
    }
    // Permissive mode: drop flow-control gates that only slow exploration down.
    // Budget and host/program allowlists still apply.
    const permissive = this.runtime.policyPermissive === true;
    if (!permissive && state.plan && state.strategyRevisionRequired && toolName !== "checkpoint") {
      return {
        allowed: false,
        reason: "A strategy-revision checkpoint is required after the previous failure or denial",
        signature: actionSignature,
      };
    }
    if (toolName === "checkpoint" && state.strategyRevisionRequired && !permissive) {
      const checkpoint = args as {
        failureClassification?: unknown;
        planChanges?: unknown;
        nextActionRationale?: unknown;
      };
      if (
        typeof checkpoint.failureClassification !== "string" ||
        checkpoint.failureClassification === "none"
      ) {
        return { allowed: false, reason: "Failure recovery requires a non-none failure classification", signature: actionSignature };
      }
      if (!Array.isArray(checkpoint.planChanges) || checkpoint.planChanges.length === 0) {
        return { allowed: false, reason: "Failure recovery requires at least one concrete plan change", signature: actionSignature };
      }
      if (typeof checkpoint.nextActionRationale !== "string" || checkpoint.nextActionRationale.trim().length === 0) {
        return { allowed: false, reason: "Failure recovery requires a next-action rationale", signature: actionSignature };
      }
    }
    if (
      toolName === "finish_task" &&
      (args as { status?: unknown })?.status === "completed" &&
      state.task.metadata.source === "nssctf-agent-arena"
    ) {
      const finish = args as {
        submission?: unknown;
        confidence?: unknown;
        verification?: unknown;
        independentlyVerified?: unknown;
      };
      if (typeof finish.submission !== "string" || !finish.submission.trim()) {
        return { allowed: false, reason: "Arena completion requires a machine-readable submission", signature: actionSignature };
      }
      // Relaxed per operator request: CTF flags are usually verified by the remote
      // service itself, so we keep only one independent verification + one finding.
      if (!Array.isArray(finish.verification) || finish.verification.length === 0) {
        return {
          allowed: false,
          reason: "Arena completion requires at least one verification record",
          signature: actionSignature,
        };
      }
      const candidate = finish.submission.trim();
      const candidateVerification = finish.verification.some(
        (item): boolean => typeof item === "string" && item.includes(candidate),
      );
      if (!candidateVerification) {
        return {
          allowed: false,
          reason: "Arena completion requires the exact candidate in at least one verification record",
          signature: actionSignature,
        };
      }
      const candidateFinding = state.findings.some((finding) => {
        const text = [finding.title, finding.description, ...finding.evidence].join("\n");
        return finding.confidence >= 0.8 && text.includes(candidate);
      });
      if (!candidateFinding) {
        return {
          allowed: false,
          reason: "Arena completion requires a high-confidence finding tied to the submitted candidate",
          signature: actionSignature,
        };
      }
    }
    const reserveStartsAt = this.runtime.maxRuntimeMs - this.runtime.finalizationReserveMs;
    const startedAt = Date.parse(state.startedAt ?? state.createdAt);
    if (
      action &&
      Number.isFinite(startedAt) &&
      Date.now() - startedAt >= reserveStartsAt
    ) {
      return {
        allowed: false,
        reason: "Finalization reserve is active; investigative actions are closed",
        signature: actionSignature,
      };
    }
    if (action && !permissive && state.actionsSinceCheckpoint >= this.runtime.maxActionsWithoutCheckpoint) {
      return { allowed: false, reason: "Checkpoint required before more actions", signature: actionSignature };
    }
    const repeats = state.repeatedActions[actionSignature] ?? 0;
    if (action && !permissive && repeats >= this.runtime.maxRepeatedAction) {
      return { allowed: false, reason: "Repeated-action limit reached; revise the strategy", signature: actionSignature };
    }
    if (toolName === "run_command") {
      const program = String((args as { program?: unknown })?.program ?? "");
      const programName = basename(program);
      if (!permissive && !this.scope.allowedPrograms.includes(programName)) {
        return { allowed: false, reason: `Program is outside the allowlist: ${program}`, signature: actionSignature };
      }
      const commandArgs = (args as { args?: unknown })?.args;
      if (Array.isArray(commandArgs)) {
        for (const value of commandArgs) {
          if (typeof value !== "string") continue;
          if (value.includes("\0") || (!isAbsolute(value) && value.split(/[\\/]/).includes(".."))) {
            return { allowed: false, reason: "Command argument contains an unsafe path", signature: actionSignature };
          }
          if (isAbsolute(value) && !permissive && !isAllowedAbsolutePath(this.runtime, this.scope, value)) {
            return { allowed: false, reason: "Command argument points outside the workspace", signature: actionSignature };
          }
        }
      }
    }
    if (toolName === "list_scratch_files" || toolName === "read_scratch_file" || toolName === "write_scratch_file") {
      const path = String((args as { path?: unknown })?.path ?? ".");
      if (!isRelativeSafePath(path)) {
        return { allowed: false, reason: "Scratch path must be relative and stay inside scratchRoot", signature: actionSignature };
      }
    }
    if (toolName === "inspect_artifact") {
      const path = String((args as { path?: unknown })?.path ?? "");
      const source = String((args as { source?: unknown })?.source ?? "workspace");
      if ((source !== "workspace" && source !== "scratch") || !isRelativeSafePath(path)) {
        return {
          allowed: false,
          reason: "Artifact inspection requires a safe relative workspace or scratch path",
          signature: actionSignature,
        };
      }
    }
    if (toolName === "search_artifact") {
      const path = String((args as { path?: unknown })?.path ?? "");
      const source = String((args as { source?: unknown })?.source ?? "workspace");
      if ((source !== "workspace" && source !== "scratch") || !isRelativeSafePath(path)) {
        return {
          allowed: false,
          reason: "Artifact search requires a safe relative workspace or scratch path",
          signature: actionSignature,
        };
      }
    }
    if (toolName === "extract_archive") {
      const path = String((args as { path?: unknown })?.path ?? "");
      const destination = String((args as { destination?: unknown })?.destination ?? "");
      const source = String((args as { source?: unknown })?.source ?? "workspace");
      if (
        (source !== "workspace" && source !== "scratch") ||
        !isRelativeSafePath(path) ||
        !isRelativeSafePath(destination)
      ) {
        return {
          allowed: false,
          reason: "Archive extraction requires safe relative source and scratch destination paths",
          signature: actionSignature,
        };
      }
    }
    if (toolName === "observe_image") {
      const path = String((args as { path?: unknown })?.path ?? "");
      const source = String((args as { source?: unknown })?.source ?? "workspace");
      if ((source !== "workspace" && source !== "scratch") || !isRelativeSafePath(path)) {
        return {
          allowed: false,
          reason: "Image observation requires a safe relative workspace or scratch path",
          signature: actionSignature,
        };
      }
      if ((state.imageObservations ?? 0) >= this.runtime.maxImageObservations) {
        return {
          allowed: false,
          reason: "Image observation budget exhausted",
          signature: actionSignature,
        };
      }
    }
    // Removed per operator request: CTF attachment challenges often need to run
    // file/strings/python/gdb in the workspace right after extracting. The sandbox
    // still restricts writes; reads and commands over attachments are allowed.
    // (attachments-only workspace command gate intentionally disabled)
    if (toolName === "http_request" || toolName === "web_collect_baseline") {
      if (this.scope.mode !== "controlled") {
        return { allowed: false, reason: "Network actions require scope.mode=controlled", signature: actionSignature };
      }
      if (state.httpRequests >= this.runtime.maxHttpRequests) {
        return { allowed: false, reason: "HTTP request budget exhausted", signature: actionSignature };
      }
      try {
        const url = new URL(String((args as { url?: unknown })?.url ?? ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
        if (!this.scope.allowedHosts.some((allowed) => hostMatches(url.host, allowed))) {
          return { allowed: false, reason: `Host is outside the authorized scope: ${url.host}`, signature: actionSignature };
        }
      } catch (error) {
        return { allowed: false, reason: `Invalid target URL: ${String(error)}`, signature: actionSignature };
      }
    }
    if (toolName === "tcp_open") {
      if (this.scope.mode !== "controlled") {
        return { allowed: false, reason: "TCP actions require scope.mode=controlled", signature: actionSignature };
      }
      if (state.tcpSessions >= this.runtime.maxTcpSessions) {
        return { allowed: false, reason: "TCP session budget exhausted", signature: actionSignature };
      }
      const host = String((args as { host?: unknown })?.host ?? "");
      const port = Number((args as { port?: unknown })?.port ?? 0);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { allowed: false, reason: "Invalid TCP host or port", signature: actionSignature };
      }
      const authority = tcpAuthority(host, port);
      if (!this.scope.allowedHosts.some((allowed) => hostMatches(authority, allowed))) {
        return { allowed: false, reason: `TCP host is outside the authorized scope: ${authority}`, signature: actionSignature };
      }
    }
    if (toolName === "browser") {
      if (this.scope.mode !== "controlled") return { allowed: false, reason: "Browser actions require scope.mode=controlled", signature: actionSignature };
      const action = String((args as { action?: unknown })?.action ?? "");
      // Per user request, most browser actions are enabled for CTF work. Only popup
      // remains disabled (it bridges into host browser privileges).
      if (["popup"].includes(action)) return { allowed: false, reason: "This browser action is disabled by default", signature: actionSignature };
      if (!["create_session", "open_page", "navigate", "reload", "go_back", "capture_dom", "capture_network_summary", "assert_state", "click", "fill", "select", "check", "uncheck", "submit_form", "wait_for", "close_page", "close_session", "capture_screenshot", "upload", "download", "evaluate"].includes(action)) return { allowed: false, reason: "Unknown browser action", signature: actionSignature };
    }
    if (descriptor.source !== "builtin" && descriptor.effect === "network") {
      if (this.scope.mode !== "controlled") return { allowed: false, reason: "External network tools require scope.mode=controlled", signature: actionSignature };
      if (state.httpRequests >= this.runtime.maxHttpRequests) return { allowed: false, reason: "Network request budget exhausted", signature: actionSignature };
      const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
      if (descriptor.networkTargetFields?.includes("url")) {
        try {
          const url = new URL(String(input.url ?? ""));
          if (!["http:", "https:"].includes(url.protocol) || !this.scope.allowedHosts.some((allowed) => hostMatches(url.host, allowed))) {
            return { allowed: false, reason: `External tool host is outside the authorized scope: ${url.host}`, signature: actionSignature };
          }
        } catch (error) {
          return { allowed: false, reason: `Invalid external tool URL: ${String(error)}`, signature: actionSignature };
        }
      }
      if (descriptor.networkTargetFields?.includes("host-port")) {
        const authority = tcpAuthority(String(input.host ?? ""), Number(input.port ?? 0));
        if (!this.scope.allowedHosts.some((allowed) => hostMatches(authority, allowed))) {
          return { allowed: false, reason: `External tool host is outside the authorized scope: ${authority}`, signature: actionSignature };
        }
      }
    }
    return { allowed: true, reason: "Allowed by configured scope and runtime budget", signature: actionSignature };
  }

  recordAllowed(toolName: string, decision: PolicyDecision, state: RunState): void {
    state.toolCalls += 1;
    const descriptor = this.descriptors.get(toolName);
    if (ACTION_TOOLS.has(toolName) || (descriptor?.source !== "builtin" && descriptor !== undefined && isActionDescriptor(descriptor))) {
      state.actionsSinceCheckpoint += 1;
      state.repeatedActions[decision.signature] = (state.repeatedActions[decision.signature] ?? 0) + 1;
    }
    if (toolName === "http_request" || toolName === "web_collect_baseline") state.httpRequests += 1;
    if (descriptor?.source !== "builtin" && descriptor?.effect === "network") state.httpRequests += 1;
    if (toolName === "tcp_open") state.tcpSessions += 1;
    if (toolName === "observe_image") state.imageObservations = (state.imageObservations ?? 0) + 1;
    if (toolName === "checkpoint") state.actionsSinceCheckpoint = 0;
  }

  static evaluateArenaRequest(arena: ArenaConfig | undefined, method: string, targetUrl: string): PolicyDecision {
    const actionSignature = signature("arena_request", { method, url: targetUrl });
    if (!arena?.enabled) return { allowed: false, reason: "Arena integration is disabled", signature: actionSignature };
    if (method !== "GET" && method !== "POST") {
      return { allowed: false, reason: `Arena method is not allowed: ${method}`, signature: actionSignature };
    }
    try {
      const base = new URL(arena.baseUrl);
      const target = new URL(targetUrl);
      if (target.protocol !== base.protocol || target.host !== base.host) {
        return { allowed: false, reason: `Arena host is outside configured baseUrl: ${target.host}`, signature: actionSignature };
      }
      if (!target.pathname.startsWith("/api/skill/agent/arena/")) {
        return { allowed: false, reason: `Arena path is outside the allowed API prefix: ${target.pathname}`, signature: actionSignature };
      }
      return { allowed: true, reason: "Allowed by configured Arena control-plane scope", signature: actionSignature };
    } catch (error) {
      return { allowed: false, reason: `Invalid Arena URL: ${String(error)}`, signature: actionSignature };
    }
  }

  static evaluateScopedTcpTarget(scope: ScopeConfig, host: string, port: number): PolicyDecision {
    const actionSignature = signature("scoped_tcp_target", { host, port });
    if (scope.mode !== "controlled") {
      return { allowed: false, reason: "TCP actions require scope.mode=controlled", signature: actionSignature };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { allowed: false, reason: `Invalid TCP port: ${port}`, signature: actionSignature };
    }
    const authority = tcpAuthority(host, port);
    if (!scope.allowedHosts.some((allowed) => hostMatches(authority, allowed))) {
      return { allowed: false, reason: `TCP host is outside the authorized scope: ${authority}`, signature: actionSignature };
    }
    return { allowed: true, reason: "Allowed by configured scope", signature: actionSignature };
  }

  static evaluateArenaAnnexRequest(
    arena: ArenaConfig | undefined,
    scope: ScopeConfig,
    targetUrl: string,
  ): PolicyDecision {
    const actionSignature = signature("arena_annex_request", { url: targetUrl });
    if (!arena?.enabled) return { allowed: false, reason: "Arena integration is disabled", signature: actionSignature };
    try {
      const base = new URL(arena.baseUrl);
      const target = new URL(targetUrl);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return { allowed: false, reason: `Arena annex protocol is not allowed: ${target.protocol}`, signature: actionSignature };
      }
      const sameArenaOrigin = target.protocol === base.protocol && target.host === base.host;
      if (sameArenaOrigin) {
        return { allowed: true, reason: "Allowed Arena-origin annex URL", signature: actionSignature };
      }
      if (scope.mode !== "controlled" || !scope.allowedHosts.some((allowed) => hostMatches(target.host, allowed))) {
        return {
          allowed: false,
          reason: `Arena annex host is outside the authorized scope: ${target.host}`,
          signature: actionSignature,
        };
      }
      return { allowed: true, reason: "Allowed scoped Arena annex URL", signature: actionSignature };
    } catch (error) {
      return { allowed: false, reason: `Invalid Arena annex URL: ${String(error)}`, signature: actionSignature };
    }
  }

  static evaluateDascRequest(
    dasc: DascConfig | undefined,
    scope: ScopeConfig,
    method: string,
    targetUrl: string,
    requestCount = 0,
  ): PolicyDecision {
    const actionSignature = signature("dasc_request", { method, url: targetUrl });
    if (!dasc?.enabled) return { allowed: false, reason: "DASC integration is disabled", signature: actionSignature };
    if (scope.mode !== "controlled") {
      return { allowed: false, reason: "DASC requests require scope.mode=controlled", signature: actionSignature };
    }
    if (requestCount >= dasc.maxRequests) {
      return { allowed: false, reason: "DASC request budget exhausted", signature: actionSignature };
    }
    if (method !== "GET" && method !== "POST") {
      return { allowed: false, reason: `DASC method is not allowed: ${method}`, signature: actionSignature };
    }
    try {
      const base = new URL(dasc.baseUrl);
      const target = new URL(targetUrl);
      if (target.protocol !== base.protocol || target.host !== base.host) {
        return { allowed: false, reason: `DASC host is outside configured baseUrl: ${target.host}`, signature: actionSignature };
      }
      if (!scope.allowedHosts.some((allowed) => hostMatches(target.host, allowed))) {
        return { allowed: false, reason: `DASC host is outside the authorized scope: ${target.host}`, signature: actionSignature };
      }
      if (!target.pathname.startsWith("/slab-match/api/v1/agent/")) {
        return { allowed: false, reason: `DASC path is outside the allowed API prefix: ${target.pathname}`, signature: actionSignature };
      }
      return { allowed: true, reason: "Allowed by configured DASC control-plane scope", signature: actionSignature };
    } catch (error) {
      return { allowed: false, reason: `Invalid DASC URL: ${String(error)}`, signature: actionSignature };
    }
  }
}

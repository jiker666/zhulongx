import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isActionDescriptor, toolDescriptorMap, type ToolDescriptor } from "./tool-catalog.js";
import type { RuntimeConfig, RunState, ScopeConfig } from "./types.js";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  signature: string;
}

// R10 (run 29070): update_plan_steps lives in the catalog and profiles but was
// missing from both META_TOOLS and ACTION_TOOLS, so policy.evaluate returned
// "Unknown tool" for it — the model saw it in the system prompt, called it,
// and lost the turn.
const META_TOOLS = new Set(["submit_plan", "update_plan_steps", "checkpoint", "record_finding", "record_lesson", "finish_task"]);
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

const BROWSER_ACTIONS = [
  "create_session", "open_page", "navigate", "reload", "go_back", "capture_dom", "capture_network_summary",
  "assert_state", "click", "fill", "select", "check", "uncheck", "submit_form", "wait_for", "close_page",
  "close_session", "capture_screenshot", "upload", "download", "evaluate", "popup",
];

export class PolicyEngine {
  private readonly descriptors: Map<string, ToolDescriptor>;

  constructor(
    readonly scope: ScopeConfig,
    readonly runtime: RuntimeConfig,
    externalDescriptors: ToolDescriptor[] = [],
  ) {
    this.descriptors = toolDescriptorMap(externalDescriptors);
  }

  /**
   * Permissive mode: scope, host/program allowlists, budgets, plan/checkpoint
   * ordering, finalization reserve, and repeated-action guards no longer deny
   * anything — only malformed arguments are rejected so tools receive usable
   * input. Every decision is still recorded for the audit chain.
   */
  evaluate(toolName: string, args: unknown, _state: RunState): PolicyDecision {
    const actionSignature = signature(toolName, args);
    const descriptor = this.descriptors.get(toolName);
    if (!descriptor || (!META_TOOLS.has(toolName) && !ACTION_TOOLS.has(toolName) && descriptor.source === "builtin")) {
      return { allowed: false, reason: `Unknown tool: ${toolName}`, signature: actionSignature };
    }
    if (toolName === "http_request" || toolName === "web_collect_baseline") {
      try {
        const url = new URL(String((args as { url?: unknown })?.url ?? ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
      } catch (error) {
        return { allowed: false, reason: `Invalid target URL: ${String(error)}`, signature: actionSignature };
      }
    }
    if (toolName === "tcp_open") {
      const host = String((args as { host?: unknown })?.host ?? "");
      const port = Number((args as { port?: unknown })?.port ?? 0);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { allowed: false, reason: "Invalid TCP host or port", signature: actionSignature };
    }
    if (toolName === "browser") {
      const browserAction = String((args as { action?: unknown })?.action ?? "");
      if (!BROWSER_ACTIONS.includes(browserAction)) return { allowed: false, reason: "Unknown browser action", signature: actionSignature };
    }
    if (toolName === "run_command") {
      const commandArgs = (args as { args?: unknown })?.args;
      if (Array.isArray(commandArgs)) {
        for (const value of commandArgs) {
          if (typeof value === "string" && value.includes("\0")) {
            return { allowed: false, reason: "Command argument contains a null byte", signature: actionSignature };
          }
        }
      }
    }
    if (descriptor.source !== "builtin" && descriptor.effect === "network" && descriptor.networkTargetFields?.includes("url")) {
      try {
        const url = new URL(String((args as { url?: unknown })?.url ?? ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
      } catch (error) {
        return { allowed: false, reason: `Invalid external tool URL: ${String(error)}`, signature: actionSignature };
      }
    }
    return { allowed: true, reason: "Allowed; policy enforcement is disabled", signature: actionSignature };
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

  static evaluateScopedTcpTarget(scope: ScopeConfig, host: string, port: number): PolicyDecision {
    const actionSignature = signature("scoped_tcp_target", { host, port });
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { allowed: false, reason: `Invalid TCP port: ${port}`, signature: actionSignature };
    return { allowed: true, reason: "Allowed; policy enforcement is disabled", signature: actionSignature };
  }
}

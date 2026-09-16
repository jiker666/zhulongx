import type { ExecutorHealth } from "./executor.js";
import { getBuiltinToolDescriptor } from "./tool-catalog.js";
import type { CtfSkillCategory } from "./skill-catalog.js";
import type { AgentProfileConfig, AppConfig } from "./types.js";

export interface ResolvedAgentProfile extends AgentProfileConfig {
  systemPrompt: string;
}

export function defaultAgentProfile(config: AppConfig): ResolvedAgentProfile {
  return {
    id: "general",
    systemPrompt: "",
    preferredExecutor: "sandbox",
    requiredCapabilities: ["workspace-read"],
    toolAllowlist: [...new Set([
      "submit_plan", "update_plan_steps", "checkpoint", "record_finding", "record_lesson", "finish_task",
      "list_files", "read_file", "inspect_artifact", "extract_archive", "search_artifact", "observe_image",
      "list_scratch_files", "read_scratch_file", "write_scratch_file", "run_command",
      "web_collect_baseline", "web_knowledge_lookup", "web_compare_responses", "web_timing_stats",
      "http_request", "browser", "tcp_open", "tcp_send", "tcp_receive", "tcp_close",
      "read_shared_evidence", "publish_shared_evidence",
    ])],
  };
}

export function resolveAgentProfile(config: AppConfig, externalToolNames: string[] = []): ResolvedAgentProfile {
  const fallback = defaultAgentProfile(config);
  const profile = config.profile;
  if (!profile) return { ...fallback, toolAllowlist: [...new Set([...fallback.toolAllowlist, ...externalToolNames])] };
  const external = new Set(externalToolNames);
  const unknownTools = profile.toolAllowlist.filter((name) => !getBuiltinToolDescriptor(name) && !external.has(name));
  if (unknownTools.length > 0) throw new Error(`Profile ${profile.id} references unknown builtin tools: ${unknownTools.join(", ")}`);
  for (const required of ["submit_plan", "checkpoint", "finish_task"]) {
    if (!profile.toolAllowlist.includes(required)) throw new Error(`Profile ${profile.id} must allow ${required}`);
  }
  return { ...profile, systemPrompt: profile.systemPrompt ?? "" };
}

export function validateProfileCapabilities(profile: ResolvedAgentProfile, health: ExecutorHealth): void {
  if (profile.preferredExecutor !== health.kind) {
    throw new Error(`Profile ${profile.id} requires executor kind ${profile.preferredExecutor}, received ${health.kind}`);
  }
  const capabilities = new Set(health.capabilities);
  const missing = profile.requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) throw new Error(`Profile ${profile.id} is missing executor capabilities: ${missing.join(", ")}`);
}

export function filterProfileTools<T extends { name: string }>(profile: ResolvedAgentProfile, tools: T[]): T[] {
  const allowed = new Set(profile.toolAllowlist);
  return tools.filter((tool) => allowed.has(tool.name));
}

/** Narrow a broad operator profile to the tools relevant to a known offline CTF category.
 * This is a per-run reduction only; it never expands the configured allowlist or bypasses PolicyEngine. */
export function narrowToolsForCategory<T extends { name: string }>(category: CtfSkillCategory | undefined, tools: T[]): T[] {
  if (!category || category === "web" || category === "osint" || category === "ai/ml") return tools;
  const common = new Set([
    "submit_plan", "update_plan_steps", "checkpoint", "record_finding", "record_lesson", "finish_task",
    "list_files", "read_file", "inspect_artifact", "extract_archive", "search_artifact",
    "list_scratch_files", "read_scratch_file", "write_scratch_file", "run_command",
    "read_shared_evidence", "publish_shared_evidence",
  ]);
  if (category === "reverse" || category === "pwn" || category === "malware" || category === "forensics" || category === "crypto" || category === "misc") {
    return tools.filter((tool) => common.has(tool.name));
  }
  return tools;
}

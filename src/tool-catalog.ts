export type ToolSource = "builtin" | "mcp" | "plugin";
export type ToolKind = "read" | "write" | "shell" | "search" | "browser" | "delegate" | "control" | "other";
export type ToolEffect = "pure_readonly" | "workspace_read" | "workspace_write" | "network" | "execute" | "delegate" | "unknown";
export type ToolRiskLevel = "read" | "write" | "network" | "execute" | "delegate";

export interface ToolRisk {
  level: ToolRiskLevel;
  summary: string;
  requiresApproval: boolean;
}

export interface ToolDescriptor {
  name: string;
  source: ToolSource;
  kind: ToolKind;
  effect: ToolEffect;
  executionMode: "serial" | "parallel";
  capabilityRequirements: string[];
  sideEffects: string[];
  networkTargetFields?: Array<"url" | "host-port">;
  riskEvaluator(args: unknown): ToolRisk;
}

function descriptor(
  name: string,
  kind: ToolKind,
  effect: ToolEffect,
  executionMode: ToolDescriptor["executionMode"],
  options: Partial<Omit<ToolDescriptor, "name" | "source" | "kind" | "effect" | "executionMode" | "riskEvaluator">> = {},
): ToolDescriptor {
  const level: ToolRiskLevel = effect === "network" ? "network" : effect === "execute" ? "execute" : effect === "delegate" ? "delegate" : effect === "workspace_write" ? "write" : "read";
  return {
    name,
    source: "builtin",
    kind,
    effect,
    executionMode,
    capabilityRequirements: options.capabilityRequirements ?? [],
    sideEffects: options.sideEffects ?? [],
    ...(options.networkTargetFields ? { networkTargetFields: options.networkTargetFields } : {}),
    riskEvaluator: () => ({
      level,
      summary: `${name} performs ${effect.replaceAll("_", " ")}`,
      requiresApproval: ["network", "execute", "write", "delegate"].includes(level),
    }),
  };
}

const BUILTIN_DESCRIPTORS = [
  descriptor("submit_plan", "control", "pure_readonly", "serial", { sideEffects: ["Updates the run plan and hypothesis ledger"] }),
  descriptor("checkpoint", "control", "pure_readonly", "serial", { sideEffects: ["Updates run strategy and hypothesis state"] }),
  descriptor("record_finding", "control", "pure_readonly", "serial", { sideEffects: ["Persists a structured finding"] }),
  descriptor("record_lesson", "control", "pure_readonly", "serial", { sideEffects: ["Persists a bounded experience candidate"] }),
  descriptor("finish_task", "control", "pure_readonly", "serial", { sideEffects: ["Transitions the run to a terminal state"] }),
  descriptor("list_files", "read", "workspace_read", "parallel", { capabilityRequirements: ["workspace-read"], sideEffects: ["Reads bounded directory metadata from the authorized workspace"] }),
  descriptor("read_file", "read", "workspace_read", "parallel", { capabilityRequirements: ["workspace-read"], sideEffects: ["Reads bounded bytes from one authorized workspace file"] }),
  descriptor("inspect_artifact", "read", "workspace_read", "parallel", { capabilityRequirements: ["workspace-read"], sideEffects: ["Reads bounded artifact bytes and computes local metadata"] }),
  descriptor("extract_archive", "write", "workspace_write", "serial", { capabilityRequirements: ["workspace-read", "scratch-write", "abort"], sideEffects: ["Reads one authorized ZIP archive and writes bounded extracted files only under the current run scratch root"] }),
  descriptor("search_artifact", "search", "workspace_read", "parallel", { capabilityRequirements: ["workspace-read", "scratch-read", "abort"], sideEffects: ["Reads a bounded prefix of one authorized artifact and returns local byte-pattern matches"] }),
  descriptor("observe_image", "read", "workspace_read", "parallel", { capabilityRequirements: ["workspace-read"], sideEffects: ["Reads one bounded image and exposes it only to the current model context"] }),
  descriptor("list_scratch_files", "read", "workspace_read", "parallel", { capabilityRequirements: ["scratch-read"], sideEffects: ["Reads bounded directory metadata from the current run scratch root"] }),
  descriptor("read_scratch_file", "read", "workspace_read", "parallel", { capabilityRequirements: ["scratch-read"], sideEffects: ["Reads bounded bytes from one current-run scratch file"] }),
  descriptor("write_scratch_file", "write", "workspace_write", "serial", { capabilityRequirements: ["scratch-write"], sideEffects: ["Creates or modifies one bounded file under the run scratch root"] }),
  descriptor("run_command", "shell", "execute", "serial", { capabilityRequirements: ["structured-exec", "abort"], sideEffects: ["Executes one allowlisted argv command in the isolated executor", "May create files under the run scratch root"] }),
  descriptor("web_collect_baseline", "search", "network", "parallel", { networkTargetFields: ["url"], sideEffects: ["Issues one bounded HTTP request to an authorized host"] }),
  descriptor("web_knowledge_lookup", "search", "pure_readonly", "parallel", { sideEffects: ["Reads the bounded built-in web knowledge index without network access"] }),
  descriptor("web_compare_responses", "read", "pure_readonly", "parallel", { sideEffects: ["Computes a bounded in-memory comparison of supplied response evidence"] }),
  descriptor("web_timing_stats", "read", "pure_readonly", "parallel", { sideEffects: ["Computes bounded timing statistics from supplied observations"] }),
  descriptor("http_request", "search", "network", "parallel", { networkTargetFields: ["url"], sideEffects: ["Issues one bounded HTTP request to an authorized host", "May mutate remote state for non-read methods"] }),
  descriptor("browser", "browser", "network", "serial", { networkTargetFields: ["url"], sideEffects: ["May navigate or interact with an authorized web application"] }),
  descriptor("tcp_open", "search", "network", "serial", { networkTargetFields: ["host-port"], sideEffects: ["Opens one TCP connection to an authorized host and port"] }),
  descriptor("tcp_send", "search", "network", "serial", { sideEffects: ["Sends bounded bytes on an existing authorized TCP session"] }),
  descriptor("tcp_receive", "read", "network", "serial", { sideEffects: ["Reads bounded bytes from an existing authorized TCP session"] }),
  descriptor("tcp_close", "control", "network", "serial", { sideEffects: ["Closes an existing TCP session"] }),
  descriptor("read_shared_evidence", "read", "pure_readonly", "parallel", { sideEffects: ["Reads bounded sanitized entries from the current race evidence board"] }),
  descriptor("publish_shared_evidence", "write", "workspace_write", "serial", { sideEffects: ["Publishes a bounded sanitized entry to the current race evidence board"] }),
] satisfies ToolDescriptor[];

export const BUILTIN_TOOL_DESCRIPTORS = new Map(BUILTIN_DESCRIPTORS.map((item) => [item.name, item]));

export function getBuiltinToolDescriptor(name: string): ToolDescriptor | undefined {
  return BUILTIN_TOOL_DESCRIPTORS.get(name);
}

export function validateExternalToolDescriptor(value: ToolDescriptor): ToolDescriptor {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value.name)) throw new Error("External tool name is invalid");
  if (value.source === "builtin") throw new Error("External tools must declare source=mcp or source=plugin");
  if (["workspace_write", "execute", "delegate", "unknown"].includes(value.effect)) {
    throw new Error(`External ${value.effect} tools require a dedicated platform adapter and cannot be registered directly`);
  }
  if (value.effect === "network" && !value.networkTargetFields?.length) {
    throw new Error("External network tools must declare a scope-checkable network target field");
  }
  if (!Array.isArray(value.sideEffects) || value.sideEffects.length === 0) throw new Error("External tools must document side effects");
  return {
    ...value,
    capabilityRequirements: [...new Set(value.capabilityRequirements)].slice(0, 32),
    sideEffects: [...new Set(value.sideEffects.map((item) => item.slice(0, 300)))].slice(0, 16),
    ...(value.networkTargetFields ? { networkTargetFields: [...new Set(value.networkTargetFields)] } : {}),
  };
}

export function toolDescriptorMap(external: ToolDescriptor[] = []): Map<string, ToolDescriptor> {
  const result = new Map(BUILTIN_TOOL_DESCRIPTORS);
  for (const item of external) {
    const validated = validateExternalToolDescriptor(item);
    if (result.has(validated.name)) throw new Error(`Duplicate tool descriptor: ${validated.name}`);
    result.set(validated.name, validated);
  }
  return result;
}

export function isActionDescriptor(value: ToolDescriptor): boolean {
  return !["control"].includes(value.kind);
}

import type { WebPhase } from "./types.js";

export interface WebBenchmarkCase {
  id: string;
  category: string;
  runtime: string;
  objective: string;
  expectedPhases: readonly WebPhase[];
  requiredContracts: readonly string[];
}

export interface WebBenchmarkResult {
  caseId: string;
  success: boolean;
  steps: number;
  toolCalls: number;
  failureReason?: string;
  webTaskDetected?: boolean;
  observationsCreated?: number;
  hypothesesCreated?: number;
  hypothesesConfirmed?: number;
  hypothesesRejected?: number;
  evidenceCreated?: number;
  evidenceReuseRate?: number;
  duplicateActionRate?: number;
  policyRejectionCount?: number;
  toolFailureCount?: number;
  stagnationCount?: number;
  strategySwitchCount?: number;
  candidateVerificationRate?: number;
  stateRecoverySuccess?: boolean;
  finalizationSuccess?: boolean;
  completionBeforeMaxRounds?: boolean;
  browserCapabilityAvailable?: boolean;
  browserSessionsCreated?: number;
  browserSessionsClosed?: number;
  browserNavigations?: number;
  browserActions?: number;
  browserActionsBlocked?: number;
  domSnapshotsCreated?: number;
  domStateTransitions?: number;
  ambiguousElementCount?: number;
  browserNetworkRequestsCaptured?: number;
  browserNetworkRequestsBlocked?: number;
  graphNodesFromBrowser?: number;
  graphEdgesFromBrowser?: number;
  browserRecoverySuccessRate?: number;
  browserResourceLeakCount?: number;
  browserActionsBeforeFinalization?: number;
  candidateBrowserVerificationRate?: number;
}

export interface WebBenchmarkReport {
  total: number;
  successful: number;
  successRate: number;
  averageSteps: number;
  averageToolCalls: number;
  failureReasons: Record<string, number>;
  reasoningMetrics?: Record<string, number>;
}

const CATEGORIES = [
  "sql_injection",
  "file_upload",
  "ssti",
  "ssrf",
  "jwt",
  "lfi_path_traversal",
  "rce",
  "node_prototype_pollution",
  "php_logic",
  "java_deserialization",
] as const;

const RUNTIMES = ["php", "node", "python", "java", "nginx"] as const;
const EXPECTED_PHASES: readonly WebPhase[] = [
  "INIT",
  "RECON",
  "ENUMERATION",
  "FINGERPRINT",
  "VULNERABILITY_ANALYSIS",
  "EXPLOITATION",
  "FLAG_SEARCH",
  "VERIFICATION",
  "COMPLETE",
];

export function buildWebBenchmarkCases(): WebBenchmarkCase[] {
  return CATEGORIES.flatMap((category, categoryIndex) =>
    RUNTIMES.map((runtime, runtimeIndex) => ({
      id: `web-${String(categoryIndex * RUNTIMES.length + runtimeIndex + 1).padStart(3, "0")}`,
      category,
      runtime,
      objective: `Establish evidence for ${category} behavior on a ${runtime} service without guessing.`,
      expectedPhases: EXPECTED_PHASES,
      requiredContracts: ["web_collect_baseline", "web_knowledge_lookup", "web_compare_responses", "finish_task"],
    })),
  );
}

export function summarizeWebBenchmark(results: readonly WebBenchmarkResult[]): WebBenchmarkReport {
  const total = results.length;
  const successful = results.filter((result) => result.success).length;
  const failureReasons: Record<string, number> = {};
  for (const result of results) {
    if (result.success) continue;
    const reason = result.failureReason ?? "unknown";
    failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
  }
  const withMetrics = results.some((result) => Object.keys(result).some((key) => key !== "caseId" && key !== "success" && key !== "steps" && key !== "toolCalls" && key !== "failureReason"));
  const optionalNumber = (key: keyof WebBenchmarkResult): number | undefined => {
    const values = results.map((result) => result[key]).filter((value): value is number => typeof value === "number");
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const optionalRate = (key: keyof WebBenchmarkResult): number | undefined => {
    const values = results.map((result) => result[key]).filter((value): value is boolean => typeof value === "boolean");
    return values.length === 0 ? undefined : values.filter(Boolean).length / values.length;
  };
  const reasoningMetrics: Record<string, number> = {};
  if (withMetrics) {
    for (const [key, value] of [["webTaskDetectionAccuracy", optionalRate("webTaskDetected")], ["observationsCreated", optionalNumber("observationsCreated")], ["hypothesesCreated", optionalNumber("hypothesesCreated")], ["hypothesesConfirmed", optionalNumber("hypothesesConfirmed")], ["hypothesesRejected", optionalNumber("hypothesesRejected")], ["evidenceCreated", optionalNumber("evidenceCreated")], ["evidenceReuseRate", optionalNumber("evidenceReuseRate")], ["duplicateActionRate", optionalNumber("duplicateActionRate")], ["policyRejectionCount", optionalNumber("policyRejectionCount")], ["toolFailureCount", optionalNumber("toolFailureCount")], ["stagnationCount", optionalNumber("stagnationCount")], ["strategySwitchCount", optionalNumber("strategySwitchCount")], ["candidateVerificationRate", optionalNumber("candidateVerificationRate")], ["stateRecoverySuccess", optionalRate("stateRecoverySuccess")], ["finalizationSuccess", optionalRate("finalizationSuccess")], ["completionBeforeMaxRounds", optionalRate("completionBeforeMaxRounds")], ["browserCapabilityAvailable", optionalRate("browserCapabilityAvailable")], ["browserSessionsCreated", optionalNumber("browserSessionsCreated")], ["browserSessionsClosed", optionalNumber("browserSessionsClosed")], ["browserNavigations", optionalNumber("browserNavigations")], ["browserActions", optionalNumber("browserActions")], ["browserActionsBlocked", optionalNumber("browserActionsBlocked")], ["domSnapshotsCreated", optionalNumber("domSnapshotsCreated")], ["domStateTransitions", optionalNumber("domStateTransitions")], ["ambiguousElementCount", optionalNumber("ambiguousElementCount")], ["browserNetworkRequestsCaptured", optionalNumber("browserNetworkRequestsCaptured")], ["browserNetworkRequestsBlocked", optionalNumber("browserNetworkRequestsBlocked")], ["graphNodesFromBrowser", optionalNumber("graphNodesFromBrowser")], ["graphEdgesFromBrowser", optionalNumber("graphEdgesFromBrowser")], ["browserRecoverySuccessRate", optionalNumber("browserRecoverySuccessRate")], ["browserResourceLeakCount", optionalNumber("browserResourceLeakCount")], ["browserActionsBeforeFinalization", optionalNumber("browserActionsBeforeFinalization")], ["candidateBrowserVerificationRate", optionalNumber("candidateBrowserVerificationRate")]] as const) if (value !== undefined) reasoningMetrics[key] = value;
  }
  return {
    total,
    successful,
    successRate: total === 0 ? 0 : successful / total,
    averageSteps: total === 0 ? 0 : results.reduce((sum, result) => sum + result.steps, 0) / total,
    averageToolCalls: total === 0 ? 0 : results.reduce((sum, result) => sum + result.toolCalls, 0) / total,
    failureReasons,
    ...(Object.keys(reasoningMetrics).length > 0 ? { reasoningMetrics } : {}),
  };
}

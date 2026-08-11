import type { NormalizedTask, RunEvent, RunState } from "../../types.js";

export const WEB_PHASES = [
  "INIT",
  "RECON",
  "ENUMERATION",
  "FINGERPRINT",
  "VULNERABILITY_ANALYSIS",
  "EXPLOITATION",
  "FLAG_SEARCH",
  "VERIFICATION",
  "COMPLETE",
  "FAILED",
] as const;

export type WebPhase = (typeof WEB_PHASES)[number];

export type WebRoleName =
  | "recon"
  | "fingerprint"
  | "vulnerability"
  | "payload"
  | "exploit"
  | "verification"
  | "recovery";

export interface WebRoleDefinition {
  name: WebRoleName;
  objective: string;
  responsibilities: string[];
  forbiddenConclusions: string[];
  preferredTools: string[];
  outputContract: string[];
}

export interface WebPhaseRecord {
  phase: WebPhase;
  enteredAt: string;
  reason: string;
  completedAt?: string;
}

export interface WebAgentState {
  phase: WebPhase;
  history: WebPhaseRecord[];
  activeRole: WebRoleName;
  failureCount: number;
  repeatedActionCount: number;
}

export interface WebOrchestratorContext {
  task: NormalizedTask;
  run: RunState;
  recentEvents?: RunEvent[];
}


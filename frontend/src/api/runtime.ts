import { request } from "./client";
import type { RuntimeAgentsSnapshot, RuntimeWorkflowsSnapshot } from "../types/api";

export const getRuntimeAgents = (signal?: AbortSignal) => request<RuntimeAgentsSnapshot>("/v1/agents", { signal });
export const getRuntimeWorkflows = (signal?: AbortSignal) => request<RuntimeWorkflowsSnapshot>("/v1/workflows", { signal });

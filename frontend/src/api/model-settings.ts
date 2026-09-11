import { request } from "./client";

export interface ModelSettings {
  configured: boolean;
  source: "session" | "environment" | "missing";
  provider: string;
  id: string;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  appKeyHeaderConfigured: boolean;
}

export interface ModelSettingsInput {
  provider: string;
  name: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  appKey?: string;
  appKeyHeader?: string;
  reasoning?: boolean;
}

export const getModelSettings = (signal?: AbortSignal) => request<{ model: ModelSettings }>("/v1/settings/model", { signal });
export const configureModelSettings = (input: ModelSettingsInput, signal?: AbortSignal) => request<{ model: ModelSettings }>("/v1/settings/model", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
export const clearModelSettings = (signal?: AbortSignal) => request<{ model: ModelSettings }>("/v1/settings/model", { method: "DELETE", signal });

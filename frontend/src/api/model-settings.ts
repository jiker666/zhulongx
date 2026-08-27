import { request } from "./client";

export interface ModelSettings {
  configured: boolean;
  source: "session" | "environment" | "missing";
  provider: string;
  id: string;
  name: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl: string;
  reasoning: boolean;
  thinkingFormat?: ModelThinkingFormat;
  appKeyHeaderConfigured: boolean;
}

export type ModelThinkingFormat = "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";

export interface ModelSettingsInput {
  provider: string;
  name: string;
  modelId: string;
  api: ModelSettings["api"];
  baseUrl: string;
  apiKey: string;
  appKey?: string;
  appKeyHeader?: string;
  reasoning?: boolean;
  thinkingFormat?: ModelThinkingFormat;
}

export const getModelSettings = (signal?: AbortSignal) => request<{ model: ModelSettings }>("/v1/settings/model", { signal });
export const configureModelSettings = (input: ModelSettingsInput, signal?: AbortSignal) => request<{ model: ModelSettings }>("/v1/settings/model", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
export const clearModelSettings = (signal?: AbortSignal) => request<{ model: ModelSettings }>("/v1/settings/model", { method: "DELETE", signal });

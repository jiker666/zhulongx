import type { ProviderError, ProviderErrorCode } from "./types.js";

function retryAfter(message: string): number | undefined {
  const milliseconds = message.match(/retry(?:-|\s)?after\s*[:=]?\s*(\d+)\s*ms/i)?.[1];
  if (milliseconds) return Math.min(Number(milliseconds), 300_000);
  const seconds = message.match(/retry(?:-|\s)?after\s*[:=]?\s*(\d+)\s*s(?:ec(?:ond)?s?)?/i)?.[1];
  return seconds ? Math.min(Number(seconds) * 1000, 300_000) : undefined;
}

function codeFor(message: string): ProviderErrorCode {
  if (/\b(?:aborted|cancelled|canceled|stopped by operator)\b/i.test(message)) return "aborted";
  if (/\b(?:tool denied|permission denied by policy|policy denied)\b/i.test(message)) return "tool_denied";
  if (/\b(?:cyber policy|network policy|unsafe request|out of scope)\b/i.test(message)) return "network_policy";
  if (/\b(?:quota|insufficient[_\s-]?quota|billing|credit balance)\b/i.test(message)) return "quota";
  if (/\b(?:429|too many requests|rate[_\s-]?limit)\b/i.test(message)) return "rate_limit";
  if (/\b(?:model not found|unknown model|api key|authentication|unauthorized|forbidden|provider.*config)\b/i.test(message)) return "provider_config";
  if (/\b(?:400|invalid request|unprocessable|request rejected|content policy)\b/i.test(message)) return "request_rejected";
  if (/\b(?:500|502|503|504|server error|service unavailable|bad gateway)\b/i.test(message)) return "server";
  if (/\b(?:econnreset|econnrefused|etimedout|fetch failed|socket hang up|connection error|network error|dns)\b/i.test(message)) return "network";
  return "unknown";
}

export function classifyProviderError(error: unknown): ProviderError {
  const message = (error instanceof Error ? error.message : String(error || "Unknown provider failure")).slice(0, 2_000);
  const code = codeFor(message);
  const retryable = ["rate_limit", "network", "server"].includes(code);
  const retryAfterMs = retryable ? retryAfter(message) : undefined;
  return { code, message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

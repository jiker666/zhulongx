import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../src/provider-errors.js";

describe("provider error classification", () => {
  it.each([
    ["429 Too Many Requests retry-after: 12s", "rate_limit", true, 12_000],
    ["insufficient_quota: add billing credit", "quota", false, undefined],
    ["503 service unavailable", "server", true, undefined],
    ["ECONNRESET while contacting provider", "network", true, undefined],
    ["unknown model or invalid API key", "provider_config", false, undefined],
    ["network policy rejected unsafe request", "network_policy", false, undefined],
    ["Run stopped by operator", "aborted", false, undefined],
  ])("classifies %s", (message, code, retryable, retryAfterMs) => {
    expect(classifyProviderError(new Error(message))).toEqual({ code, message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  });
});

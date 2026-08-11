const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key/i;

const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [redacted]"],
  [/\b(Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [redacted]"],
  [/\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-model-key]"],
  [/\bnss_agent_[A-Za-z0-9._~-]{8,}\b/gi, "[redacted-arena-token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-github-token]"],
];

export function sanitizeSensitiveText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce((output, [pattern, replacement]) => output.replace(pattern, replacement), value);
}

export function sanitizeSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeSecrets(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeSecrets(item, seen);
  }
  return output;
}

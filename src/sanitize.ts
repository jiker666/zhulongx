const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key/i;

function sanitizeText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]")
    .replace(/((?:authorization|cookie|set-cookie|password|secret|api[-_]?key|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

export function sanitizeSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeText(value);
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

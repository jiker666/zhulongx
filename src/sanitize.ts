const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key/i;

export function sanitizeSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
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

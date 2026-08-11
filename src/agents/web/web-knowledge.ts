export interface WebKnowledgeRecord {
  name: string;
  signals: string[];
  tests: string[];
  verification: string[];
  pitfalls: string[];
}

const RECORDS: readonly WebKnowledgeRecord[] = [
  {
    name: "sql_injection",
    signals: ["user-controlled parameter reaches a database-backed response", "error or timing difference after a single-variable mutation"],
    tests: ["compare baseline and type-preserving input", "test error behavior with a harmless delimiter", "verify through a reproducible response difference"],
    verification: ["same parameter produces a stable, attributable difference", "candidate data is recovered through an independent request"],
    pitfalls: ["a generic database error is not proof", "do not spray payloads without a baseline"],
  },
  {
    name: "file_upload",
    signals: ["upload endpoint", "file parameter", "extension or MIME filter"],
    tests: ["compare filename extension and MIME handling", "inspect returned path and content disposition", "check whether uploaded content is served or executed"],
    verification: ["uploaded content is retrievable through an observed path", "execution or flag disclosure is independently reproduced"],
    pitfalls: ["successful upload alone is not code execution", "avoid uploading destructive content"],
  },
  {
    name: "ssti",
    signals: ["template-like rendering of user input", "server-rendered output changes after a controlled expression marker"],
    tests: ["use a harmless arithmetic expression appropriate to the suspected engine", "compare literal and rendered output"],
    verification: ["rendering behavior is reproducible", "engine inference is supported by multiple observations"],
    pitfalls: ["reflection is not template evaluation", "do not escalate before confirming the rendering boundary"],
  },
  {
    name: "ssrf",
    signals: ["server-side URL fetch feature", "callback, preview, import, or webhook parameter"],
    tests: ["compare an allowed public URL with a controlled in-scope endpoint", "observe redirects and response handling"],
    verification: ["the server, rather than the client, performs the fetch", "the effect is confirmed by an independent observation"],
    pitfalls: ["do not probe cloud metadata or private networks without explicit scope", "URL acceptance alone is not SSRF proof"],
  },
  {
    name: "jwt",
    signals: ["JWT-shaped cookie or authorization value", "claims influence authorization behavior"],
    tests: ["decode header and claims without treating them as trusted", "compare authorization behavior under one controlled claim change"],
    verification: ["signature and algorithm handling are evidenced", "access change is reproducible and in scope"],
    pitfalls: ["decoded claims are not proof of forgery", "never persist live tokens in lessons or artifacts"],
  },
  {
    name: "lfi_path_traversal",
    signals: ["file or template path parameter", "local resource name appears in request flow"],
    tests: ["compare normalized and rejected path forms", "use only benign in-scope files for confirmation"],
    verification: ["response contains a stable, attributable local-file observation", "candidate flag is verified separately"],
    pitfalls: ["path normalization errors can mimic LFI", "do not read files outside the authorized challenge scope"],
  },
];

export function searchWebKnowledge(query: string, limit = 5): WebKnowledgeRecord[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = normalized.split(/\s+/).filter(Boolean);
  return RECORDS
    .map((record) => {
      const haystack = [record.name, ...record.signals, ...record.tests, ...record.verification].join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { record, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.record.name.localeCompare(right.record.name))
    .slice(0, Math.max(1, Math.min(limit, 8)))
    .map((item) => item.record);
}

export function listWebKnowledge(): readonly WebKnowledgeRecord[] {
  return RECORDS;
}


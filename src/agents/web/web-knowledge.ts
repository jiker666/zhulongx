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
    signals: [
      "an observed request parameter changes database-backed content, ordering, or result count",
      "a parser or database error appears only after a controlled input mutation",
      "the same input location produces a repeatable boolean or timing differential",
    ],
    tests: [
      "capture a clean baseline, then mutate one observed input with a harmless syntax marker",
      "compare a paired true/false predicate only when the request is read-only and explicitly authorized",
      "use repeated timing samples only when content-based comparison is unavailable and the request budget allows it",
    ],
    verification: [
      "the differential is reproducible across matched baseline and candidate requests",
      "an independent read-only query path confirms that user input changes query semantics",
    ],
    pitfalls: [
      "a generic server error or one slow response is not proof",
      "do not enumerate records or modify data merely to demonstrate the flaw",
    ],
  },
  {
    name: "file_upload",
    signals: [
      "an observed multipart request accepts a filename, media type, or storage path",
      "the response exposes a retrieval URL or object identifier",
      "validation behavior differs across extension, media type, and file content",
    ],
    tests: [
      "upload a non-executable canary file and vary one metadata field at a time",
      "use a safe filename containing separators or duplicate extensions to observe normalization",
      "retrieve only the returned object location and compare stored bytes, headers, and disposition",
    ],
    verification: [
      "the server stores or serves a canary outside the documented validation contract",
      "a second upload reproduces the same unsafe path or type-handling behavior",
    ],
    pitfalls: [
      "successful storage is not evidence of code execution",
      "do not upload executable, persistent, or destructive content to a shared environment",
    ],
  },
  {
    name: "ssti",
    signals: [
      "user-controlled text is transformed by a server-side rendering step",
      "template-engine syntax or errors appear in an observed response",
      "a generated document, notification, or preview renders supplied fields",
    ],
    tests: [
      "submit an inert arithmetic expression appropriate to the evidenced template family",
      "pair the expression with a literal control value to distinguish evaluation from reflection",
    ],
    verification: [
      "the server returns the computed value while the control remains literal",
      "the behavior repeats in the same field without invoking file, process, or network operations",
    ],
    pitfalls: [
      "literal reflection is not template evaluation",
      "do not escalate from arithmetic evaluation to command execution unless the operator explicitly requires it",
    ],
  },
  {
    name: "ssrf",
    signals: [
      "an observed feature accepts a URL for preview, import, callback, webhook, or proxy behavior",
      "response metadata suggests the server fetched a supplied resource",
      "the application exposes a documented remote-resource integration",
    ],
    tests: [
      "use an operator-controlled callback endpoint already present in allowedHosts",
      "compare a baseline URL with a unique canary URL while preserving all other request fields",
      "record redirect handling, resolved destination, response size, and callback evidence",
    ],
    verification: [
      "the operator-controlled endpoint receives a request correlated to the unique canary",
      "a repeated request shows the same server-side fetch behavior within scope",
    ],
    pitfalls: [
      "URL acceptance alone does not prove a server-side request",
      "do not probe private ranges, cloud metadata, internal services, or alternate protocols unless each destination is explicitly in scope",
    ],
  },
  {
    name: "jwt",
    signals: [
      "an observed bearer value has three base64url segments",
      "decoded claims contain identity, audience, issuer, role, or expiry data",
      "authorization behavior changes when a valid token is present",
    ],
    tests: [
      "decode header and payload locally without persisting the token",
      "compare missing, malformed, expired, and operator-provided valid tokens against the same read-only request",
      "verify issuer, audience, algorithm, key identifier, and claim enforcement from observed responses",
    ],
    verification: [
      "a token rejected by the documented trust policy is reproducibly accepted",
      "two operator-provided identities demonstrate an authorization boundary failure without guessing signing material",
    ],
    pitfalls: [
      "readable claims do not imply a signature bypass",
      "never store live tokens in findings, lessons, or audit summaries",
    ],
  },
  {
    name: "lfi_path_traversal",
    signals: [
      "an observed parameter selects a file, template, export, or object path",
      "path normalization errors or storage paths appear in responses",
      "the same endpoint returns different content for different documented file identifiers",
    ],
    tests: [
      "request an operator-provided canary file using one controlled traversal segment",
      "compare normalized and encoded forms only within the configured workspace or target scope",
    ],
    verification: [
      "content from the canary outside the intended directory is returned",
      "the result repeats with a second non-sensitive canary and a clean baseline",
    ],
    pitfalls: [
      "do not read operating-system files, credentials, source repositories, or unrelated tenant data to prove traversal",
      "an error containing a filesystem path is information disclosure, not arbitrary file read",
    ],
  },
  {
    name: "prototype_pollution",
    signals: [
      "an observed API accepts nested property paths or recursively merges user objects",
      "unexpected inherited properties appear after a controlled object update",
      "client or server code uses a merge utility on untrusted structured input",
    ],
    tests: [
      "set a unique inert canary property through the observed merge path",
      "check a fresh object or request context for unexpected inherited state",
    ],
    verification: [
      "the canary appears on an object that was not directly assigned the property",
      "a fresh baseline does not contain the property and cleanup restores normal state",
    ],
    pitfalls: [
      "direct assignment is not prototype pollution",
      "avoid properties that alter execution, authorization, logging, or application availability",
    ],
  },
  {
    name: "command_injection",
    signals: [
      "an observed input reaches a process, shell wrapper, converter, or diagnostic command",
      "syntax-specific errors or timing changes follow a one-variable mutation",
      "source or telemetry shows unsafe string construction at a process boundary",
    ],
    tests: [
      "use a harmless unique marker or bounded delay in an operator-owned isolated target",
      "pair the candidate with a quoted control value and keep all other fields identical",
    ],
    verification: [
      "the marker or delay is reproducible only for the candidate input",
      "source or process telemetry independently confirms that input crossed the command boundary",
    ],
    pitfalls: [
      "an application timeout alone is not command execution",
      "do not create files, open network connections, change state, or run destructive commands as proof",
    ],
  },
  {
    name: "source_code_exposure",
    signals: [
      "a documented static, download, or repository endpoint returns unintended implementation files",
      "stack traces disclose source fragments or local paths",
      "backup or source-map references are present in observed HTML or JavaScript",
    ],
    tests: [
      "request only source artifacts directly referenced by observed application content",
      "compare the response media type and content signature with the public asset baseline",
    ],
    verification: [
      "the response contains implementation code or configuration not intended for public delivery",
      "a second referenced artifact confirms the exposure without enumerating unobserved paths",
    ],
    pitfalls: [
      "do not guess repository, environment, backup, or process paths",
      "redact credentials and personal data from evidence immediately",
    ],
  },
  {
    name: "authentication_authorization",
    signals: [
      "the same resource or action is available to multiple observed identities",
      "a client-supplied identifier or role influences access control",
      "an unauthenticated request receives protected content rather than a generic shell",
    ],
    tests: [
      "compare the same read-only request as unauthenticated and as two operator-provided identities",
      "change only one operator-owned resource identifier and preserve the original request shape",
      "verify both response content and server-side state after any authorized write test",
    ],
    verification: [
      "an identity can read or act on a resource it does not own under the documented policy",
      "a repeated baseline confirms the result is not caused by cache, stale UI, or generic error handling",
    ],
    pitfalls: [
      "status code differences alone are insufficient when response bodies are generic",
      "do not brute-force credentials, enumerate unrelated identifiers, or cross tenant boundaries without explicit test accounts and scope",
    ],
  },
  {
    name: "xss",
    signals: [
      "user-controlled text is inserted into HTML, an attribute, a URL, CSS, or a script context",
      "encoding differs between input and rendered DOM",
      "a browser sink consumes data from an observed source without context-appropriate escaping",
    ],
    tests: [
      "place a unique inert marker in the observed input and capture its exact DOM context",
      "use a non-sensitive browser canary only after confirming the output context and policy scope",
    ],
    verification: [
      "the canary executes in the expected origin and context without accessing cookies or external endpoints",
      "a repeat browser session reproduces the behavior from the same input path",
    ],
    pitfalls: [
      "HTML reflection is not script execution",
      "do not exfiltrate cookies, tokens, personal data, or browser storage as proof",
    ],
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

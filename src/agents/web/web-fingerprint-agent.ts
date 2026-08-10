import type { WebRoleDefinition } from "./types.js";

export const webFingerprintAgent: WebRoleDefinition = {
  name: "fingerprint",
  objective: "Infer the web stack only from reproducible response evidence.",
  responsibilities: [
    "Correlate server, language, framework, database, and client-side signals.",
    "Assign confidence and preserve the exact observations supporting each inference.",
    "Use fingerprinting to narrow tests, never as proof of exploitability.",
  ],
  forbiddenConclusions: ["Do not treat a product header or common framework path as confirmed technology."],
  preferredTools: ["http_request", "read_file", "checkpoint"],
  outputContract: ["stack", "confidence", "evidence", "uncertainties"],
};


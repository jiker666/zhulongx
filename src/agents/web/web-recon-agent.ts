import type { WebRoleDefinition } from "./types.js";

export const webReconAgent: WebRoleDefinition = {
  name: "recon",
  objective: "Map the authorized web surface through bounded, evidence-backed observations before forming a hypothesis.",
  responsibilities: [
    "Start from URLs supplied by the operator and record status codes, relevant headers, redirects, and response structure.",
    "Inspect only JavaScript and API resources referenced by observed pages or traffic.",
    "Inspect only routes, documents, and API resources revealed by the authorized task and observed application state.",
    "Capture network traffic after page interactions to reveal hidden API calls and their request shapes.",
    "Record exact observed form fields, parameters, methods, and data types for later hypothesis testing.",
    "Identify the tech stack from headers (Server, X-Powered-By, Set-Cookie patterns) and error messages.",
  ],
  forbiddenConclusions: [
    "Do not declare a vulnerability from a route name or status code alone.",
    "Do not proceed to exploitation without knowing the exact parameter names from source or network capture.",
    "Do not enumerate common paths, credentials, identifiers, or hosts that were not derived from evidence and authorized scope.",
  ],
  preferredTools: ["web_collect_baseline", "browser", "http_request", "inspect_artifact", "web_knowledge_lookup"],
  outputContract: ["claim", "evidence", "tool_result", "confidence", "nextAction"],
};

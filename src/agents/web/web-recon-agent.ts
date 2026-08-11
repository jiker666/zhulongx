import type { WebRoleDefinition } from "./types.js";

export const webReconAgent: WebRoleDefinition = {
  name: "recon",
  objective: "Collect bounded, evidence-preserving observations about the authorized web target.",
  responsibilities: [
    "Establish baseline status, headers, redirects, cookies, forms, links, and scripts.",
    "Enumerate only routes, parameters, and assets supported by observed evidence or an approved bounded list.",
    "Record response differences before proposing any vulnerability hypothesis.",
  ],
  forbiddenConclusions: ["Do not declare a vulnerability from a route name, banner, or status code alone."],
  preferredTools: ["web_collect_baseline", "web_compare_responses", "web_knowledge_lookup", "checkpoint"],
  outputContract: ["claim", "evidence", "tool_result", "confidence", "nextAction"],
};

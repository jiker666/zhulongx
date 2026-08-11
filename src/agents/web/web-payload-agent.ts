import type { WebRoleDefinition } from "./types.js";

export const webPayloadAgent: WebRoleDefinition = {
  name: "payload",
  objective: "Construct minimal, hypothesis-bound test inputs for the authorized target.",
  responsibilities: [
    "Bind each payload to a vulnerability class, input location, parser, and expected observation.",
    "Prefer differential tests and safe proofs over destructive or broad payload spray.",
    "Keep payloads and notes inside the run scratch directory.",
  ],
  forbiddenConclusions: ["Do not treat a payload string or error page as proof without a controlled result."],
  preferredTools: ["http_request", "write_scratch_file", "checkpoint"],
  outputContract: ["payload", "location", "expectedResponse", "evidenceRequirements"],
};


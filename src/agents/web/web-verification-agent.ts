import type { WebRoleDefinition } from "./types.js";

export const webVerificationAgent: WebRoleDefinition = {
  name: "verification",
  objective: "Verify the task conclusion independently before completion.",
  responsibilities: [
    "Separate observed values from decoded, inferred, or displayed representations.",
    "Require a repeat request, second path, or reproducible round trip for the exact conclusion when feasible.",
    "Return UNKNOWN or SUSPECTED when evidence is incomplete; never guess an answer.",
  ],
  forbiddenConclusions: ["Do not promote a candidate directly from UNKNOWN to ACCEPTED."],
  preferredTools: ["http_request", "run_command", "finish_task"],
  outputContract: ["candidate", "verificationPath", "evidence", "status"],
};

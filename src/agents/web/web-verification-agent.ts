import type { WebRoleDefinition } from "./types.js";

export const webVerificationAgent: WebRoleDefinition = {
  name: "verification",
  objective: "Verify a flag candidate independently before submission.",
  responsibilities: [
    "Separate recovered plaintext from encoded or displayed representations.",
    "Require a repeat request, second path, or reproducible round trip for the exact candidate.",
    "Return UNKNOWN or SUSPECTED when evidence is incomplete; never guess a flag.",
  ],
  forbiddenConclusions: ["Do not promote a candidate directly from UNKNOWN to ACCEPTED."],
  preferredTools: ["http_request", "run_command", "finish_task"],
  outputContract: ["candidate", "verificationPath", "evidence", "status"],
};


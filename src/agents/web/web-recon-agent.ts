import type { WebRoleDefinition } from "./types.js";

export const webReconAgent: WebRoleDefinition = {
  name: "recon",
  objective: "Map the full attack surface by collecting bounded, evidence-backed observations before forming any hypothesis.",
  responsibilities: [
    "Fetch the root URL and all discovered pages; record status codes, headers, cookies, redirects.",
    "Read ALL JavaScript source files for: API field names, internal hostnames, route structures, auth mechanisms.",
    "MANDATORY source leak check: always try GET /.git/HEAD, /static/app.py, /static/main.py, /app.py, /proc/self/environ, /proc/self/cmdline to expose server-side source code or environment.",
    "Enumerate: /robots.txt, /.git/, /api/, /admin/, /debug/, /swagger/, /actuator/, /phpinfo.php, /console, /source, /.env.",
    "Capture network traffic after page interactions to reveal hidden API calls and their request shapes.",
    "Record exact form field names, parameter names, and data types — these are required for later exploitation.",
    "Identify the tech stack from headers (Server, X-Powered-By, Set-Cookie patterns) and error messages.",
    "If login returns 500 for all inputs: look for required missing fields in JS source, check error details, try different Content-Types.",
  ],
  forbiddenConclusions: [
    "Do not declare a vulnerability from a route name or status code alone.",
    "Do not proceed to exploitation without knowing the exact parameter names from source or network capture.",
    "Do not give up after a 500 on login without first reading JS source for the required fields.",
  ],
  preferredTools: ["web_collect_baseline", "browser", "http_request", "inspect_artifact", "web_knowledge_lookup"],
  outputContract: ["claim", "evidence", "tool_result", "confidence", "nextAction"],
};

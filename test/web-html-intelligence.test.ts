import { describe, expect, it } from "vitest";
import { extractHtmlStructure, resolveUrl } from "../src/web-reasoning/html/parser.js";
import { normalizeSemanticUrl } from "../src/web-reasoning/html/identity.js";

const SOURCE = "https://lab.example.invalid/";
const EVIDENCE = ["ev_1"];

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------
describe("resolveUrl", () => {
  it("resolves absolute URLs through source", () => {
    expect(resolveUrl("https://other.example/api", SOURCE)).toBe("https://other.example/api");
  });

  it("resolves root-relative URLs", () => {
    expect(resolveUrl("/api/v1/users", SOURCE)).toBe("https://lab.example.invalid/api/v1/users");
  });

  it("resolves relative URLs", () => {
    expect(resolveUrl("users", "https://lab.example.invalid/admin/")).toBe(
      "https://lab.example.invalid/admin/users",
    );
  });

  it("resolves protocol-relative URLs", () => {
    expect(resolveUrl("//cdn.example/script.js", SOURCE)).toBe("https://cdn.example/script.js");
  });

  it("falls back to raw value for truly invalid URLs like http://[", () => {
    // "http://[" causes the URL constructor to throw — truly invalid, not treated as relative.
    expect(resolveUrl("http://[", SOURCE)).toBe("http://[");
  });
});

// ---------------------------------------------------------------------------
// URL normalization for identity
// ---------------------------------------------------------------------------
describe("normalizeSemanticUrl", () => {
  it("lowercases scheme and hostname", () => {
    expect(normalizeSemanticUrl("HTTPS://Lab.Example.COM/path")).toBe(
      "https://lab.example.com/path",
    );
  });

  it("strips default ports", () => {
    expect(normalizeSemanticUrl("https://lab.example.invalid:443/api")).toBe(
      "https://lab.example.invalid/api",
    );
    expect(normalizeSemanticUrl("http://lab.example.invalid:80/x")).toBe(
      "http://lab.example.invalid/x",
    );
  });

  it("preserves non-default ports", () => {
    expect(normalizeSemanticUrl("https://lab.example.invalid:8443/api")).toBe(
      "https://lab.example.invalid:8443/api",
    );
  });

  it("strips fragment for entity identity", () => {
    expect(normalizeSemanticUrl("https://lab.example.invalid/page#section")).toBe(
      "https://lab.example.invalid/page",
    );
  });

  it("preserves pathname case and query order/case", () => {
    expect(normalizeSemanticUrl("https://lab.example.invalid/Path/Name?Key=Val&a=B")).toBe(
      "https://lab.example.invalid/Path/Name?Key=Val&a=B",
    );
  });
});

// ---------------------------------------------------------------------------
// Two-tier identity
// ---------------------------------------------------------------------------
describe("two-tier identity", () => {
  it("same entity in different documents => same findingId, different occurrenceId", () => {
    const html1 = '<form action="/login" method="post"><input name="user"></form>';
    // Same semantic form, but different surrounding markup changes contentHash
    const html2 = '<html><body><form action="/login" method="post"><input name="user"></form></body></html>';

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.forms).toHaveLength(1);
    expect(r2.forms).toHaveLength(1);
    expect(r1.forms[0]!.findingId).toBe(r2.forms[0]!.findingId);
    // Different source documents => different contentHash => different occurrenceId
    expect(r1.forms[0]!.occurrenceId).not.toBe(r2.forms[0]!.occurrenceId);
  });

  it("identical document + identical location => stable identical occurrenceId", () => {
    const html = '<form action="/login" method="post"><input name="user"></form>';
    const r1 = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r1.forms[0]!.occurrenceId).toBe(r2.forms[0]!.occurrenceId);
  });

  it("different entities => different findingId", () => {
    const html1 = '<form action="/login" method="post"></form>';
    const html2 = '<form action="/signup" method="get"></form>';

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.forms[0]!.findingId).not.toBe(r2.forms[0]!.findingId);
  });

  it("different HTML content, same semantic link => same findingId", () => {
    const html1 = '<html><head></head><body><a href="/about">About</a></body></html>';
    const html2 = '<div><a href="/about">About Us</a></div>';

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.links[0]!.findingId).toBe(r2.links[0]!.findingId);
    // Different documents => different contentHash => different occurrenceId
    expect(r1.links[0]!.occurrenceId).not.toBe(r2.links[0]!.occurrenceId);
  });
});

// ---------------------------------------------------------------------------
// Form identity regression
// ---------------------------------------------------------------------------
describe("form identity regression", () => {
  it("CSRF field presence changes structural identity", () => {
    const html1 = `<form action="/login" method="post"><input name="username"></form>`;
    const html2 = `<form action="/login" method="post"><input name="username"><input name="csrf_token"></form>`;

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.forms[0]!.findingId).not.toBe(r2.forms[0]!.findingId);
  });

  it("CSRF value changes do NOT change semantic identity", () => {
    const html1 = `<form action="/login" method="post"><input name="csrf_token" value="A"></form>`;
    const html2 = `<form action="/login" method="post"><input name="csrf_token" value="B"></form>`;

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.forms[0]!.findingId).toBe(r2.forms[0]!.findingId);
  });

  it("field DOM order is semantic: swapped order => different findingId", () => {
    const html1 = `<form action="/login" method="post"><input name="username"><input name="password"></form>`;
    const html2 = `<form action="/login" method="post"><input name="password"><input name="username"></form>`;

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.forms[0]!.findingId).not.toBe(r2.forms[0]!.findingId);
  });

  it("different formaction values => different findingId", () => {
    const html1 = `<form action="/x"><input type="submit" formaction="/a"></form>`;
    const html2 = `<form action="/x"><input type="submit" formaction="/b"></form>`;
    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);
    expect(r1.forms[0]!.findingId).not.toBe(r2.forms[0]!.findingId);
  });
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
describe("form extraction", () => {
  it("extracts form action, method, and fields", () => {
    const html = `<form action="/login" method="post">
      <input name="user" type="text" placeholder="Username" required>
      <input name="pass" type="password">
      <button type="submit">Sign In</button>
    </form>`;

    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.forms).toHaveLength(1);
    const f = r.forms[0]!;
    expect(f.action).toBe("https://lab.example.invalid/login");
    expect(f.method).toBe("POST");
    expect(f.fields).toHaveLength(3);
    expect(f.fields[0]!.name).toBe("user");
    expect(f.fields[0]!.type).toBe("text");
    expect(f.fields[0]!.required).toBe(true);
    expect(f.fields[1]!.name).toBe("pass");
    expect(f.fields[1]!.type).toBe("password");
    expect(f.fields[2]!.tag).toBe("button");
    expect(f.fields[2]!.text).toBe("Sign In");
    expect(f.provenance.evidenceIds).toEqual(EVIDENCE);
    expect(f.provenance.sourceKind).toBe("html");
  });

  it("extracts select options", () => {
    const html = `<form action="/search">
      <select name="category" multiple>
        <option value="books">Books</option>
        <option value="music">Music</option>
        <option>Other</option>
      </select>
    </form>`;

    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.forms[0]!.fields[0]!.values).toEqual(["books", "music", "Other"]);
    expect(r.forms[0]!.fields[0]!.multiple).toBe(true);
  });

  it("extracts textarea", () => {
    const html = `<form action="/comment">
      <textarea name="body" placeholder="Write here..." required>Default text</textarea>
    </form>`;

    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const field = r.forms[0]!.fields[0]!;
    expect(field.tag).toBe("textarea");
    expect(field.value).toBe("Default text");
    expect(field.placeholder).toBe("Write here...");
    expect(field.required).toBe(true);
  });

  it("resolves formaction and formmethod on input/button", () => {
    const html = `<form action="/default">
      <input type="submit" formaction="/custom" formmethod="post" name="go">
      <button formaction="/other" formmethod="delete">Delete</button>
    </form>`;

    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.forms[0]!.fields[0]!.formaction).toBe("https://lab.example.invalid/custom");
    expect(r.forms[0]!.fields[0]!.formmethod).toBe("POST");
    expect(r.forms[0]!.fields[1]!.formaction).toBe("https://lab.example.invalid/other");
    expect(r.forms[0]!.fields[1]!.formmethod).toBe("DELETE");
  });

  it("defaults form method to GET", () => {
    const html = `<form action="/search"><input name="q"></form>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.forms[0]!.method).toBe("GET");
  });

  it("uses effectiveBase for empty action", () => {
    const html = `<form><input name="q"></form>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.forms[0]!.action).toBe(SOURCE);
  });

  it("handles forms with zero fields without degradation", () => {
    const html = `<form action="/x"></form>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0]!.fields).toHaveLength(0);
    expect(r.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
describe("link extraction", () => {
  it("extracts href, text, rel, target", () => {
    const html = `<a href="/about" rel="nofollow" target="_blank">About Us</a>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]!.href).toBe("https://lab.example.invalid/about");
    expect(r.links[0]!.text).toBe("About Us");
    expect(r.links[0]!.rel).toBe("nofollow");
    expect(r.links[0]!.target).toBe("_blank");
  });

  it("skips links without href", () => {
    const html = `<a name="anchor">Jump</a>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.links).toHaveLength(0);
  });

  it("resolves relative links against effective base", () => {
    const html = `<base href="/app/"><a href="page">Page</a>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.links[0]!.href).toBe("https://lab.example.invalid/app/page");
  });
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------
describe("script extraction", () => {
  it("extracts external script src", () => {
    const html = `<script src="/static/app.js" type="module"></script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.scripts).toHaveLength(1);
    expect(r.scripts[0]!.src).toBe("https://lab.example.invalid/static/app.js");
    expect(r.scripts[0]!.isModule).toBe(true);
    expect(r.scripts[0]!.inlineHash).toBeUndefined();
  });

  it("extracts inline script hash", () => {
    const html = `<script>console.log("hello");</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.scripts).toHaveLength(1);
    expect(r.scripts[0]!.src).toBeUndefined();
    expect(r.scripts[0]!.inlineHash).toBeDefined();
    expect(r.scripts[0]!.inlineHash).toHaveLength(64);
    expect(r.scripts[0]!.inlineLength).toBeGreaterThan(0);
  });

  it("same inline script produces same findingId across responses", () => {
    const html = `<script>fetch("/api/data")</script>`;
    const r1 = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html, SOURCE, 100_000, ["ev_2"]);
    expect(r1.scripts[0]!.findingId).toBe(r2.scripts[0]!.findingId);
  });
});

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------
describe("meta extraction", () => {
  it("extracts meta refresh with redirect target", () => {
    const html = `<meta http-equiv="refresh" content="5; url=/dashboard">`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.metas).toHaveLength(1);
    expect(r.metas[0]!.kind).toBe("redirect");
    expect(r.metas[0]!.targetUrl).toBe("https://lab.example.invalid/dashboard");
  });

  it("extracts meta viewport", () => {
    const html = `<meta name="viewport" content="width=device-width">`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.metas[0]!.kind).toBe("viewport");
  });

  it("extracts meta charset", () => {
    const html = `<meta charset="utf-8">`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.metas[0]!.kind).toBe("charset");
  });

  it("classifies plain meta refresh without URL as refresh (not redirect)", () => {
    const html = `<meta http-equiv="refresh" content="5">`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.metas[0]!.kind).toBe("refresh");
    expect(r.metas[0]!.targetUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Identity anti-truncation
// ---------------------------------------------------------------------------
describe("identity anti-truncation", () => {
  it("comments with same first chars but different tails => different findingIds", () => {
    const prefix = "x".repeat(100);
    const html1 = `<!-- ${prefix} A -->`;
    const html2 = `<!-- ${prefix} B -->`;

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.comments[0]!.findingId).not.toBe(r2.comments[0]!.findingId);
  });

  it("meta contents with same first chars but different tails => different findingIds", () => {
    const prefix = "x".repeat(100);
    const html1 = `<meta name="description" content="${prefix} A">`;
    const html2 = `<meta name="description" content="${prefix} B">`;

    const r1 = extractHtmlStructure(html1, SOURCE, 100_000, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 100_000, EVIDENCE);

    expect(r1.metas[0]!.findingId).not.toBe(r2.metas[0]!.findingId);
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
describe("comment extraction", () => {
  it("extracts top-level HTML comment", () => {
    const html = `<!-- one -->`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.text).toBe("one");
    expect(r.comments[0]!.provenance.sourceKind).toBe("comment");
  });

  it("extracts nested comment inside element", () => {
    const html = `<div><!-- nested --></div>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.text).toBe("nested");
  });

  it("extracts multiple comments at different depths", () => {
    const html = `<!-- root --><div><section><!-- nested --></section></div>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.comments).toHaveLength(2);
    const texts = r.comments.map((c) => c.text).sort();
    expect(texts).toEqual(["nested", "root"]);
  });

  it("comment provenance offsets point to actual source range", () => {
    const html = `before<!-- the comment -->after`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.comments).toHaveLength(1);
    const c = r.comments[0]!;
    expect(c.text).toBe("the comment");

    const start = c.provenance.startOffset!;
    const end = c.provenance.endOffset!;

    expect(html.slice(start, end + 1)).toBe("<!-- the comment -->");
    expect(start).toBe(html.indexOf("<!--"));
    expect(end).toBe(html.indexOf("-->") + 2);
    expect(c.provenance.excerpt).toBe("<!-- the comment -->");
  });

  it("extracts HTML comments alongside content", () => {
    const html = `<!-- TODO: remove debug endpoint /debug/v1 -->
<div>content</div>
<!-- another comment -->`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.comments).toHaveLength(2);
    expect(r.comments[0]!.text).toContain("TODO");
    expect(r.comments[0]!.provenance.sourceKind).toBe("comment");
  });

  it("skips empty comments", () => {
    const html = `<!---->`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.comments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sourceKind: script vs attribute
// ---------------------------------------------------------------------------
describe("sourceKind classification", () => {
  it("<script src='/api/v1/x'> => sourceKind 'attribute'", () => {
    const html = `<script src="/api/v1/x"></script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const apiFromAttr = r.apiEndpoints.find(
      (e) => e.url === "https://lab.example.invalid/api/v1/x",
    );
    expect(apiFromAttr).toBeDefined();
    expect(apiFromAttr!.provenance.sourceKind).toBe("attribute");
  });

  it("inline <script>fetch('/api/v1/x')</script> => sourceKind 'script'", () => {
    const html = `<script>fetch("/api/v1/x")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const apiFromScript = r.apiEndpoints.find(
      (e) => e.url === "https://lab.example.invalid/api/v1/x",
    );
    expect(apiFromScript).toBeDefined();
    expect(apiFromScript!.provenance.sourceKind).toBe("script");
  });

  it("does NOT classify <style> content as sourceKind 'script'", () => {
    const html = `<style>
  /* background: url('/api/bg') */
  .btn { color: red; }
</style>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    for (const ep of r.apiEndpoints) {
      expect(ep.provenance.sourceKind).not.toBe("script");
    }
  });
});

// ---------------------------------------------------------------------------
// API endpoint extraction
// ---------------------------------------------------------------------------
describe("API endpoint extraction", () => {
  // --- looksApiLike filter ---
  it("ordinary href='/about' => link only, NOT HtmlApiEndpoint", () => {
    const html = `<a href="/about">About</a>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.links).toHaveLength(1);
    const aboutApis = r.apiEndpoints.filter((e) => e.url.includes("/about"));
    expect(aboutApis).toHaveLength(0);
  });

  it("API-like href='/api/users' => link AND apiEndpoint observation", () => {
    const html = `<a href="/api/users">Users</a>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.links).toHaveLength(1);
    // The URL /api/users is evidence-observed and API-like; it may also appear
    // as an apiEndpoint when matched by a quoted-path API pattern.
    const apiEps = r.apiEndpoints.filter(
      (e) => e.url === "https://lab.example.invalid/api/users",
    );
    expect(apiEps.length).toBeGreaterThanOrEqual(1);
  });

  // --- fetch/axios regex capture-group fix ---
  it("fetch('/api/users') => raw URL correct, method undefined", () => {
    const html = `<script>fetch("/api/users")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find((e) => e.url === "https://lab.example.invalid/api/users");
    expect(ep).toBeDefined();
    expect(ep!.method).toBeUndefined();
  });

  it("axios.get('/api/users') => URL correct, method GET", () => {
    const html = `<script>axios.get("/api/users")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find(
      (e) => e.url === "https://lab.example.invalid/api/users" && e.method === "GET",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
  });

  it("axios.post('/api/users') => URL correct, method POST", () => {
    const html = `<script>axios.post("/api/users")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find(
      (e) => e.url === "https://lab.example.invalid/api/users" && e.method === "POST",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("POST");
  });

  it("client.get('/api/users') (.method pattern) => URL correct, method GET", () => {
    const html = `<script>client.get("/api/users")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find(
      (e) => e.url === "https://lab.example.invalid/api/users" && e.method === "GET",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
  });

  it(".post('/api/items') (.method pattern) => URL correct, method POST", () => {
    const html = `<script>this.http.post("/api/items")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find(
      (e) => e.url === "https://lab.example.invalid/api/items" && e.method === "POST",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("POST");
  });

  // --- explicitApiContext ---
  it("apiUrl='/backend' passes looksApiLike via explicitApiContext", () => {
    const html = `<script>const apiUrl = "/backend";</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find((e) => e.url === "https://lab.example.invalid/backend");
    expect(ep).toBeDefined();
  });

  it("baseURL='https://api.example.com' passes looksApiLike via explicitApiContext", () => {
    const html = `<script>const baseURL = "https://api.example.com";</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find((e) => e.url === "https://api.example.com/");
    expect(ep).toBeDefined();
  });

  it("endpoint='/v2/data' passes looksApiLike via explicitApiContext", () => {
    const html = `<script>const endpoint = "/v2/data";</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints.find((e) => e.url === "https://lab.example.invalid/v2/data");
    expect(ep).toBeDefined();
  });

  // --- method differentiation in identity ---
  it("axios.get vs axios.post on same URL => different findingIds", () => {
    const htmlGet = `<script>axios.get("/api/users")</script>`;
    const htmlPost = `<script>axios.post("/api/users")</script>`;
    const rGet = extractHtmlStructure(htmlGet, SOURCE, 100_000, EVIDENCE);
    const rPost = extractHtmlStructure(htmlPost, SOURCE, 100_000, EVIDENCE);

    const epGet = rGet.apiEndpoints.find((e) => e.method === "GET")!;
    const epPost = rPost.apiEndpoints.find((e) => e.method === "POST")!;
    expect(epGet.findingId).not.toBe(epPost.findingId);
  });

  // --- physical-occurrence dedup: overlapping patterns, same position ---
  it("same physical URL occurrence matched by overlapping regex patterns => exactly ONE occurrence", () => {
    const html = `<script>fetch("/api/users")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const users = r.apiEndpoints.filter(
      (e) => e.url === "https://lab.example.invalid/api/users",
    );
    // The quoted "/api/users" pattern and the fetch("...") pattern overlap
    // on the same physical URL occurrence. Dedup must merge them to exactly 1.
    expect(users.length).toBe(1);
  });

  // --- physical-occurrence dedup: same entity, distinct positions ---
  it("same semantic endpoint at two distinct source positions => same findingId, two occurrenceIds", () => {
    const html = `<script>
fetch("/api/users");
fetch("/api/users");
</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const users = r.apiEndpoints.filter(
      (e) => e.url === "https://lab.example.invalid/api/users",
    );
    expect(users.length).toBe(2);
    expect(users[0]!.findingId).toBe(users[1]!.findingId);
    expect(users[0]!.occurrenceId).not.toBe(users[1]!.occurrenceId);
  });

  // --- provenance offset exactness ---
  it("provenance startOffset/endOffset bracket the exact raw URL text", () => {
    const html = `<script>fetch("/api/status")</script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const ep = r.apiEndpoints[0]!;
    expect(ep.provenance.evidenceIds).toEqual(EVIDENCE);
    expect(ep.provenance.sourceUrl).toBe(SOURCE);
    expect(ep.provenance.startOffset).toBeGreaterThan(0);
    expect(ep.provenance.endOffset).toBeGreaterThan(ep.provenance.startOffset!);
    // Exact slice must reproduce the raw URL
    const sliced = html.slice(ep.provenance.startOffset!, ep.provenance.endOffset! + 1);
    expect(sliced).toBe("/api/status");
    expect(ep.provenance.excerpt).toBe("/api/status");
  });
});

// ---------------------------------------------------------------------------
// Error handling and degradation
// ---------------------------------------------------------------------------
describe("error handling and degradation", () => {
  it("handles empty HTML gracefully", () => {
    const r = extractHtmlStructure("", SOURCE, 100_000, EVIDENCE);
    expect(r.degraded).toBe(false);
    expect(r.forms).toHaveLength(0);
    expect(r.links).toHaveLength(0);
  });

  it("truncates oversized input", () => {
    const big = "<html>" + "x".repeat(300_000) + "</html>";
    const r = extractHtmlStructure(big, SOURCE, 1_000, EVIDENCE);
    expect(r.truncated).toBe(true);
  });

  it("handles malformed HTML without crashing", () => {
    const html = `<form action="/x"><input name="a"<input name="b"></form>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.errors.every((e) => e.severity !== "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full-source hash vs truncation
// ---------------------------------------------------------------------------
describe("contentHash vs truncation", () => {
  it("preserves full-source contentHash even when only prefix is analyzed", () => {
    const prefix = "<html><body>" + "x".repeat(500);
    const html1 = prefix + " A".repeat(200);
    const html2 = prefix + " B".repeat(200);
    // Both share the same first 512 bytes, but differ after
    const r1 = extractHtmlStructure(html1, SOURCE, 512, EVIDENCE);
    const r2 = extractHtmlStructure(html2, SOURCE, 512, EVIDENCE);
    expect(r1.truncated).toBe(true);
    expect(r2.truncated).toBe(true);
    // contentHash must reflect the FULL source, not just the analyzed prefix
    expect(r1.contentHash).not.toBe(r2.contentHash);
  });
});

// ---------------------------------------------------------------------------
// UTF-8 truncation
// ---------------------------------------------------------------------------
describe("UTF-8 truncation", () => {
  it("truncates multibyte UTF-8 input without degradation", () => {
    // Each CJK character is 3 bytes in UTF-8
    const cjk = "汉".repeat(200); // 600 bytes
    const html = `<html><body>${cjk}</body></html>`;
    const r = extractHtmlStructure(html, SOURCE, 400, EVIDENCE);
    expect(r.truncated).toBe(true);
    // The result should not throw and should produce a valid structure.
    // Even truncated, we should at minimum not have degraded.
    expect(r.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// <base href> support
// ---------------------------------------------------------------------------
describe("base href", () => {
  it("resolves relative URLs against base href", () => {
    const html = `<base href="/app/">
<form action="login"><input name="u"></form>
<a href="home">Home</a>
<script src="main.js"></script>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    expect(r.base?.href).toBe("/app/");
    expect(r.forms[0]!.action).toBe("https://lab.example.invalid/app/login");
    expect(r.links[0]!.href).toBe("https://lab.example.invalid/app/home");
    expect(r.scripts[0]!.src).toBe("https://lab.example.invalid/app/main.js");
  });
});

// ---------------------------------------------------------------------------
// Occurrence uniqueness across all findings
// ---------------------------------------------------------------------------
describe("occurrence uniqueness", () => {
  it("every finding has a unique occurrenceId", () => {
    const html = `<form action="/a"><input name="x"></form>
<form action="/b"><input name="y"></form>
<a href="/c">C</a>
<a href="/d">D</a>`;
    const r = extractHtmlStructure(html, SOURCE, 100_000, EVIDENCE);
    const oids = [
      ...r.forms.map((f) => f.occurrenceId),
      ...r.links.map((l) => l.occurrenceId),
    ];
    expect(new Set(oids).size).toBe(oids.length);
  });
});

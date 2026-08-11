import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { extractOpenApiStructure } from "../src/web-reasoning/openapi/index.js";
import { createHash } from "node:crypto";

const EVIDENCE = ["ev_op"];

function contentHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// =============================================================================
// 1. Basic detection
// =============================================================================
describe("spec detection", () => {
  it("recognises valid OpenAPI 3 JSON", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Test", version: "1.0.0" },
      paths: {},
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(false);
    expect(r.spec).toBeDefined();
    expect(r.spec!.kind).toBe("openapi3");
    expect(r.spec!.version).toBe("3.0.3");
  });

  it("recognises valid OpenAPI 3 YAML", () => {
    const raw = [
      "openapi: '3.0.3'",
      "info:",
      "  title: Test",
      "  version: 1.0.0",
      "paths: {}",
    ].join("\n");
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(false);
    expect(r.spec).toBeDefined();
    expect(r.spec!.kind).toBe("openapi3");
  });

  it("recognises Swagger 2 JSON", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {},
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(false);
    expect(r.spec!.kind).toBe("swagger2");
    expect(r.spec!.version).toBe("2.0");
  });

  it("recognises Swagger 2 YAML", () => {
    const raw = [
      "swagger: '2.0'",
      "info:",
      "  title: Test",
      "  version: 1.0.0",
      "paths: {}",
    ].join("\n");
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(false);
    expect(r.spec!.kind).toBe("swagger2");
  });

  it("does not misclassify arbitrary JSON", () => {
    const raw = JSON.stringify({ hello: "world", paths: {} });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(true);
    expect(r.errors.some(e => e.code === "NOT_OPENAPI")).toBe(true);
  });

  it("does not misclassify arbitrary YAML", () => {
    const raw = "hello: world\npaths: {}";
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(true);
    expect(r.errors.some(e => e.code === "NOT_OPENAPI")).toBe(true);
  });

  it("rejects openapi: '3garbage'", () => {
    const raw = JSON.stringify({
      openapi: "3garbage",
      info: { title: "T", version: "1" },
      paths: {},
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(true);
  });

  it("rejects openapi: '30'", () => {
    const raw = JSON.stringify({
      openapi: "30",
      info: { title: "T", version: "1" },
      paths: {},
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(true);
  });

  it("rejects openapi: '300'", () => {
    const raw = JSON.stringify({
      openapi: "300",
      info: { title: "T", version: "1" },
      paths: {},
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(true);
  });

  it("returns degraded on malformed JSON", () => {
    const r = extractOpenApiStructure("{bad", undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(true);
    // JSON-first fallback: JSON.parse fails, then the YAML fallback also
    // fails. Either error family is the correct parse-failure signal.
    expect(
      r.errors.some(e => e.code === "PARSE_FAILURE" || e.code === "YAML_PARSE_ERROR"),
    ).toBe(true);
  });

  it("returns degraded on malformed YAML (unclosed flow sequence)", () => {
    // "[" is a YAML flow sequence start with no closing — parseDocument produces errors
    const raw = "openapi: '3.0.3'\ninfo:\n  title: [\n  version: '1'\npaths: {}";
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.degraded).toBe(true);
    expect(r.errors.some(e => e.code === "YAML_PARSE_ERROR")).toBe(true);
  });

  it("does not throw on unparseable input", () => {
    expect(() => extractOpenApiStructure("\x00\x01\x02", undefined, 0, EVIDENCE)).not.toThrow();
  });
});

// =============================================================================
// 2. Endpoint identity
// =============================================================================
describe("endpoint identity", () => {
  function doc(
    path: string,
    method: string,
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        [path]: {
          [method.toLowerCase()]: {
            responses: { "200": { description: "ok" } },
            ...extra,
          },
        },
      },
    });
  }

  it("GET /Users != GET /users (case-sensitive)", () => {
    const a = extractOpenApiStructure(doc("/Users", "GET"), undefined, 0, EVIDENCE);
    const b = extractOpenApiStructure(doc("/users", "GET"), undefined, 0, EVIDENCE);
    expect(a.endpoints[0]!.findingId).not.toBe(b.endpoints[0]!.findingId);
  });

  it("GET /users != GET /users/ (trailing slash)", () => {
    const a = extractOpenApiStructure(doc("/users", "GET"), undefined, 0, EVIDENCE);
    const b = extractOpenApiStructure(doc("/users/", "GET"), undefined, 0, EVIDENCE);
    expect(a.endpoints[0]!.findingId).not.toBe(b.endpoints[0]!.findingId);
  });

  it("GET /users != POST /users (method distinction)", () => {
    const a = extractOpenApiStructure(doc("/users", "GET"), undefined, 0, EVIDENCE);
    const b = extractOpenApiStructure(doc("/users", "POST"), undefined, 0, EVIDENCE);
    expect(a.endpoints[0]!.findingId).not.toBe(b.endpoints[0]!.findingId);
  });

  it("findingId stable when only description/summary/operationId/tags change", () => {
    const a = extractOpenApiStructure(doc("/users", "GET", { summary: "A" }), undefined, 0, EVIDENCE);
    const b = extractOpenApiStructure(doc("/users", "GET", { summary: "B", description: "x", operationId: "y", tags: ["z"] }), undefined, 0, EVIDENCE);
    expect(a.endpoints[0]!.findingId).toBe(b.endpoints[0]!.findingId);
  });

  it("occurrenceId changes when contentHash changes", () => {
    const a = extractOpenApiStructure(doc("/users", "GET", { summary: "A" }), undefined, 0, EVIDENCE);
    const b = extractOpenApiStructure(doc("/users", "GET", { summary: "B" }), undefined, 0, EVIDENCE);
    expect(a.endpoints[0]!.occurrenceId).not.toBe(b.endpoints[0]!.occurrenceId);
  });

  it("findingId does not contain contentHash", () => {
    const r = extractOpenApiStructure(doc("/users", "GET"), undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.findingId).not.toContain(r.contentHash);
    expect(r.endpoints[0]!.findingId).not.toContain(r.contentHash.slice(0, 8));
  });
});

// =============================================================================
// 3. Path-level parameter identity
// =============================================================================
describe("path-level parameter identity", () => {
  it("path-level param rebound with operation-scoped findingId", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users/{id}": {
          parameters: [{ name: "id", in: "path", required: true }],
          get: { responses: { "200": { description: "ok" } } },
          post: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const getEp = r.endpoints.find(e => e.method === "GET")!;
    const postEp = r.endpoints.find(e => e.method === "POST")!;

    expect(getEp.parameters).toHaveLength(1);
    expect(postEp.parameters).toHaveLength(1);

    // Different operation-scoped findingIds
    expect(getEp.parameters[0]!.findingId).not.toBe(postEp.parameters[0]!.findingId);

    // Provenance points to path-level declaration.
    // RFC 6901: the "/" inside the path key is escaped as ~1.
    expect(getEp.parameters[0]!.provenance.sourcePath).toContain("parameters/0");
    expect(getEp.parameters[0]!.provenance.sourcePath).toContain("users~1{id}");
  });
});

// =============================================================================
// 4. Operation parameter override
// =============================================================================
describe("parameter merge / override", () => {
  it("operation param overrides path-level param by (name, in)", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users": {
          parameters: [{ name: "role", in: "query", description: "path version" }],
          get: {
            parameters: [{ name: "role", in: "query", description: "operation version" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.parameters).toHaveLength(1);
    expect(r.endpoints[0]!.parameters[0]!.description).toBe("operation version");
  });
});

// =============================================================================
// 5. Parameter merge key collision safety
// =============================================================================
describe("parameter merge key collision", () => {
  it("uses collision-safe merge key (not fragile delimiters)", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          parameters: [
            { name: "a:b", in: "query" },
            { name: "a", in: "query", description: "should not collide" },
          ],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.parameters).toHaveLength(2);
  });

  it("params with | and newline in names don't collide", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          parameters: [
            { name: "a|b", in: "query" },
            { name: "a\nb", in: "query" },
          ],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.parameters).toHaveLength(2);
  });
});

// =============================================================================
// 6. Path parameter required semantics
// =============================================================================
describe("path parameter required semantics", () => {
  it("required: false on path param → requiredObserved=false, required=true, spec-implied", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: false }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const p = r.endpoints[0]!.parameters[0]!;
    expect(p.requiredObserved).toBe(false);
    expect(p.required).toBe(true);
    expect(p.requiredSource).toBe("spec-implied");
    expect(r.errors.some(e => e.code === "PATH_PARAM_REQUIRED_FALSE")).toBe(true);
  });

  it("required: true on path param → requiredObserved=true, required=true, explicit", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const p = r.endpoints[0]!.parameters[0]!;
    expect(p.requiredObserved).toBe(true);
    expect(p.required).toBe(true);
    expect(p.requiredSource).toBe("explicit");
  });

  it("required absent on path param → required=true, spec-implied", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users/{id}": {
          get: {
            parameters: [{ name: "id", in: "path" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const p = r.endpoints[0]!.parameters[0]!;
    expect(p.required).toBe(true);
    expect(p.requiredSource).toBe("spec-implied");
    expect("requiredObserved" in p).toBe(false);
  });

  it("required absent on query param → required=false, default", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users": {
          get: {
            parameters: [{ name: "page", in: "query" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const p = r.endpoints[0]!.parameters[0]!;
    expect(p.required).toBe(false);
    expect(p.requiredSource).toBe("default");
  });

  it("Boolean() coercion NOT used for required (string 'false')", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            parameters: [{ name: "flag", in: "query", required: "false" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const p = r.endpoints[0]!.parameters[0]!;
    expect(p.required).toBe(false);
    expect(p.requiredSource).toBe("default");
  });
});

// =============================================================================
// 7. Swagger2 formData
// =============================================================================
describe("Swagger2 formData", () => {
  it("preserves formData canonical case", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      info: { title: "T", version: "1" },
      paths: {
        "/upload": {
          post: {
            parameters: [{ name: "file", in: "formData", type: "string" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.parameters).toHaveLength(1);
    expect(r.endpoints[0]!.parameters[0]!.in).toBe("formData");
  });

  it("Swagger2 body/formData params are not duplicated", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      info: { title: "T", version: "1" },
      paths: {
        "/upload": {
          post: {
            parameters: [
              { name: "file", in: "formData", type: "string" },
              { name: "payload", in: "body", schema: { type: "object" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.parameters).toHaveLength(2);
  });
});

// =============================================================================
// 8. OAS3 / Swagger2 semantic separation
// =============================================================================
describe("OAS3 / Swagger2 semantic gating", () => {
  it("Swagger2 doc with requestBody does not extract it", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.requestBody).toBeUndefined();
  });

  it("OAS3 doc with consumes does not extract it on endpoint", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          post: {
            consumes: ["application/json"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.consumes).toBeUndefined();
  });

  it("Swagger2 has host, basePath, schemes at root", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      info: { title: "T", version: "1" },
      host: "api.example.com",
      basePath: "/v1",
      schemes: ["https"],
      consumes: ["application/json"],
      produces: ["application/json"],
      paths: {},
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.host).toBe("api.example.com");
    expect(r.basePath).toBe("/v1");
    expect(r.schemes).toEqual(["https"]);
    expect(r.consumes).toEqual(["application/json"]);
    expect(r.produces).toEqual(["application/json"]);
  });

  it("OAS3 response with stray top-level schema is NOT extracted", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                schema: { type: "string" },
              },
            },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const resp = r.endpoints[0]!.responses[0]!;
    expect("schema" in resp).toBe(false);
  });
});

// =============================================================================
// 9. Security inheritance
// =============================================================================
describe("security inheritance", () => {
  it("operation without security inherits root security", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
      security: [{ ApiKey: [] }],
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.security).toBeUndefined();
    expect(ep.effectiveSecurity).toBeDefined();
    expect(ep.effectiveSecurity!).toHaveLength(1);
  });

  it("operation security overrides root security", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            security: [{ Bearer: [] }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      security: [{ ApiKey: [] }],
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.security).toBeDefined();
    expect(ep.security!).toHaveLength(1);
    expect(ep.security![0]!.entries[0]!.scheme).toBe("Bearer");
    expect(ep.effectiveSecurity![0]!.entries[0]!.scheme).toBe("Bearer");
  });

  it("security: [] explicitly disables inherited security", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            security: [],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      security: [{ ApiKey: [] }],
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.security).toEqual([]);
    expect(ep.effectiveSecurity).toEqual([]);
  });

  it("security: [{}] is distinct from security: []", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            security: [{}],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.security).toBeDefined();
    expect(ep.security!).toHaveLength(1);
    expect(ep.security![0]!.entries).toEqual([]);
  });

  it("security OR/AND alternatives preserved", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            security: [
              { OAuth: ["read"], ApiKey: [] },
              { Bearer: [] },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const sec = r.endpoints[0]!.security!;
    expect(sec).toHaveLength(2);
    expect(sec[0]!.entries).toHaveLength(2);
    expect(sec[0]!.entries[0]!.scheme).toBe("OAuth");
    expect(sec[0]!.entries[0]!.scopes).toEqual(["read"]);
    expect(sec[0]!.entries[1]!.scheme).toBe("ApiKey");
    expect(sec[1]!.entries).toHaveLength(1);
    expect(sec[1]!.entries[0]!.scheme).toBe("Bearer");
  });
});

// =============================================================================
// 10. Security scheme extraction
// =============================================================================
describe("security scheme extraction", () => {
  it("OAS3: schemeName distinct from apiKeyName", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        securitySchemes: {
          MyApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.securitySchemes).toHaveLength(1);
    expect(r.securitySchemes[0]!.schemeName).toBe("MyApiKey");
    expect(r.securitySchemes[0]!.apiKeyName).toBe("X-API-Key");
  });

  it("Swagger2 security scheme uses Swagger2 pointer identity", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      info: { title: "T", version: "1" },
      paths: {},
      securityDefinitions: {
        LegacyKey: { type: "apiKey", name: "X-Key", in: "header" },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.securitySchemes).toHaveLength(1);
    expect(r.securitySchemes[0]!.schemeName).toBe("LegacyKey");
    expect(r.securitySchemes[0]!.apiKeyName).toBe("X-Key");
    expect(r.securitySchemes[0]!.provenance.sourcePath).toContain("securityDefinitions");
    expect(r.securitySchemes[0]!.provenance.sourcePath).not.toContain("components");
  });

  it("malformed security scheme: type absent, not fabricated as 'unknown'", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        securitySchemes: {
          Broken: { description: "test" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.securitySchemes).toHaveLength(1);
    expect(r.securitySchemes[0]!.schemeName).toBe("Broken");
    expect("type" in r.securitySchemes[0]!).toBe(false);
  });
});

// =============================================================================
// 11. Server precedence
// =============================================================================
describe("server precedence", () => {
  it("operation servers > path servers > root servers", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://root.example" }],
      paths: {
        "/x": {
          servers: [{ url: "https://path.example" }],
          get: {
            servers: [{ url: "https://op.example" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.servers!).toHaveLength(1);
    expect(ep.servers![0]!.url).toBe("https://op.example");
    expect(ep.effectiveServers![0]!.url).toBe("https://op.example");
  });

  it("absent operation servers inherits path servers", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://root.example" }],
      paths: {
        "/x": {
          servers: [{ url: "https://path.example" }],
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.servers).toBeUndefined();
    expect(ep.effectiveServers![0]!.url).toBe("https://path.example");
  });

  it("absent path servers inherits root servers", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://root.example" }],
      paths: {
        "/x": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.effectiveServers![0]!.url).toBe("https://root.example");
  });

  it("explicit servers: [] does NOT inherit path/root", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://root.example" }],
      paths: {
        "/x": {
          servers: [{ url: "https://path.example" }],
          get: {
            servers: [],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.servers).toEqual([]);
    expect(ep.effectiveServers).toEqual([]);
  });

  it("server identity: same URL at different index = same findingId", () => {
    const rawA = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      servers: [
        { url: "https://other.example" },
        { url: "https://api.example.com/{version}" },
      ],
    });
    const rawB = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      servers: [
        { url: "https://api.example.com/{version}" },
      ],
    });
    const a = extractOpenApiStructure(rawA, undefined, 0, EVIDENCE);
    const b = extractOpenApiStructure(rawB, undefined, 0, EVIDENCE);
    const srvA = a.servers.find(s => s.url === "https://api.example.com/{version}")!;
    const srvB = b.servers.find(s => s.url === "https://api.example.com/{version}")!;
    expect(srvA.findingId).toBe(srvB.findingId);
    expect(srvA.occurrenceId).not.toBe(srvB.occurrenceId);
  });
});

// =============================================================================
// 12. JSON Pointer escaping
// =============================================================================
describe("JSON Pointer escaping", () => {
  it("path key containing / has correct provenance pointer", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/a/b": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect(ep.provenance.sourcePath).toContain("~1a~1b");
    expect(ep.provenance.sourcePath).not.toContain("//a/b");
    expect(ep.provenance.sourcePath).not.toMatch(/~0[01]/);
  });

  it("component name containing / and ~ has correct escaping", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          "A/B~C": { type: "string" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.schemas).toHaveLength(1);
    const sp = r.schemas[0]!.provenance.sourcePath;
    expect(sp).toContain("A~1B~0C");
  });

  it("schema property name with / has correct provenance pointer", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          Test: {
            type: "object",
            properties: {
              "a/b": { type: "string" },
            },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schema = r.schemas.find(s => s.name === "Test")!;
    const prop = schema.properties!["a/b"]!;
    expect(prop.provenance.sourcePath).toContain("a~1b");
  });

  it("media type provenance has correctly escaped content-type", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const resp = r.endpoints[0]!.responses[0]!;
    const schema = resp.content!["application/json"]!.schema!;
    expect(schema.provenance.sourcePath).toContain("application~1json");
    expect(schema.provenance.sourcePath).not.toContain("application/json");
  });
});

// =============================================================================
// 13. Local $ref basics
// =============================================================================
describe("local $ref resolution", () => {
  it("resolves #/components/schemas/User in OAS3", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schema = r.endpoints[0]!.responses[0]!.content!["application/json"]!.schema!;
    expect(schema.$ref).toBe("#/components/schemas/User");
    expect(schema.resolved).toBeDefined();
    expect(schema.resolved!.type).toBe("object");
    expect(schema.resolved!.properties).toBeDefined();
    expect(schema.resolved!.properties!["name"]).toBeDefined();
  });

  it("resolves Swagger2 response schema $ref", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      info: { title: "T", version: "1" },
      paths: {
        "/users": {
          get: {
            produces: ["application/json"],
            responses: {
              "200": {
                description: "ok",
                schema: { $ref: "#/definitions/User" },
              },
            },
          },
        },
      },
      definitions: {
        User: { type: "object", properties: { name: { type: "string" } } },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    // Response schema must be extracted through the response structure
    expect(r.endpoints).toHaveLength(1);
    const resp = r.endpoints[0]!.responses[0]!;
    expect(resp.schema).toBeDefined();
    expect(resp.schema!.$ref).toBe("#/definitions/User");
    expect(resp.schema!.resolved).toBeDefined();
    expect(resp.schema!.resolved!.type).toBe("object");
  });

  it("treats # root ref as local, not remote", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          RootWrapper: { $ref: "#" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schema = r.schemas.find(s => s.name === "RootWrapper")!;
    // Must preserve observed $ref
    expect(schema.$ref).toBe("#");
    // Must not classify # as remote
    expect(r.unresolvedRefs).not.toContain("#");
    expect(r.errors.some(e => e.code === "REF_REMOTE_OR_EXTERNAL" && e.pointer === "#")).toBe(false);
  });
});

// =============================================================================
// 14. RFC 6901 ~0/~1 in $ref
// =============================================================================
describe("RFC 6901 ~0/~1 in $ref", () => {
  it("resolves ref with ~1 encoded / in component name", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A~1B~0C" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          "A/B~C": { type: "string" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schema = r.endpoints[0]!.responses[0]!.content!["application/json"]!.schema!;
    expect(schema.resolved).toBeDefined();
    expect(schema.resolved!.type).toBe("string");
  });
});

// =============================================================================
// 15. Remote / external ref
// =============================================================================
describe("remote / external ref", () => {
  // A real spy: if the parser attempts network access via fetch it is
  // observed as a call and its mocked implementation rejects. Installed only
  // when the runtime provides fetch (Node 18+/undici does). If fetch is
  // absent we skip the spy rather than fake a "verified no I/O" claim.
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    if (typeof globalThis.fetch === "function") {
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("network access attempted during parse"));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchSpy = undefined;
  });

  function expectNoIoAttempted(): void {
    // Assert only when the spy exists (runtime provided fetch); otherwise no
    // "verified no I/O" claim is made.
    if (fetchSpy !== undefined) {
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  }

  it("https:// ref stays unresolved, no I/O attempted", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          RemoteRef: { $ref: "https://example.com/schema.json" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expectNoIoAttempted();
    const schema = r.schemas.find(s => s.name === "RemoteRef")!;
    expect(schema.$ref).toBe("https://example.com/schema.json");
    expect(schema.resolved).toBeUndefined();
    expect(schema.unresolvedReason).toBeDefined();
    expect(r.unresolvedRefs).toContain("https://example.com/schema.json");
  });

  it("relative external ref stays unresolved", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          ExtRef: { $ref: "other.yaml#/User" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expectNoIoAttempted();
    expect(r.unresolvedRefs).toContain("other.yaml#/User");
    const schema = r.schemas.find(s => s.name === "ExtRef")!;
    expect(schema.unresolvedReason).toBeDefined();
  });
});

// =============================================================================
// 16. Unresolved local ref
// =============================================================================
describe("unresolved local ref", () => {
  it("pointer not found → REF_UNRESOLVED", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          Ghost: { $ref: "#/components/schemas/DoesNotExist" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.unresolvedRefs).toContain("#/components/schemas/DoesNotExist");
    expect(r.errors.some(e => e.code === "REF_UNRESOLVED")).toBe(true);
  });
});

// =============================================================================
// 17. Ref chain A → B → C
// =============================================================================
describe("ref chain", () => {
  it("A → B → C resolves through chain", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/C" },
          C: { type: "string" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schemaA = r.schemas.find(s => s.name === "A")!;
    // A → B → C: the observed first-hop ref is preserved at A, and the chain
    // collapses to the final concrete target (no unbounded nested graphs).
    expect(schemaA.$ref).toBe("#/components/schemas/B");
    expect(schemaA.resolved).toBeDefined();
    expect(schemaA.resolved!.type).toBe("string");
    // Target provenance points at the final hop of the chain.
    expect(schemaA.resolved!.provenance.sourcePath).toContain("/components/schemas/C");
    // The whole chain resolved — no leftover unresolved refs, no false cycle.
    expect(r.unresolvedRefs).toHaveLength(0);
    expect(r.errors.some(e => e.code === "REF_CYCLE_DETECTED")).toBe(false);
  });
});

// =============================================================================
// 18. Ref depth budget (exceeds MAX_REF_DEPTH=12)
// =============================================================================
describe("ref depth budget", () => {
  it("chain exceeding MAX_REF_DEPTH terminates with REF_DEPTH_EXCEEDED", () => {
    // MAX_REF_DEPTH = 12; create a chain of 15 refs: S0→S1→...→S14→S15(type)
    const depth = 15;
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < depth; i++) {
      schemas[`S${i}`] = { $ref: `#/components/schemas/S${i + 1}` };
    }
    schemas[`S${depth}`] = { type: "string" };

    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: { schemas },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    // Must terminate (no stack overflow)
    expect(r.errors.some(e => e.code === "REF_DEPTH_EXCEEDED")).toBe(true);
    // S0 must still be extracted (with unresolved chain)
    const s0 = r.schemas.find(s => s.name === "S0");
    expect(s0).toBeDefined();
  });
});

// =============================================================================
// 19. Ref cycle
// =============================================================================
describe("ref cycle", () => {
  it("A → B → A terminates with REF_CYCLE_DETECTED", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/A" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.errors.some(e => e.code === "REF_CYCLE_DETECTED")).toBe(true);
  });
});

// =============================================================================
// 20. Sibling repeated ref is NOT a cycle
// =============================================================================
describe("sibling repeated ref", () => {
  it("same ref in two properties resolves both without false cycle", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          User: { type: "object", properties: { name: { type: "string" } } },
          Container: {
            type: "object",
            properties: {
              user1: { $ref: "#/components/schemas/User" },
              user2: { $ref: "#/components/schemas/User" },
            },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const container = r.schemas.find(s => s.name === "Container")!;
    expect(container.properties!["user1"]!.resolved).toBeDefined();
    expect(container.properties!["user2"]!.resolved).toBeDefined();
    expect(r.errors.some(e => e.code === "REF_CYCLE_DETECTED")).toBe(false);
  });
});

// =============================================================================
// 21. Shared node budget
// =============================================================================
describe("shared node budget", () => {
  it("budget is shared: many independent parameter $refs consume shared budget", () => {
    // MAX_RESOLVED_NODES = 1000. Create 1000+ parameter refs to test shared budget.
    // Each param ref resolution consumes 1 from the shared budget.
    const paramCount = 1001;
    const params: unknown[] = [];
    const componentParams: Record<string, unknown> = {};
    for (let i = 0; i < paramCount; i++) {
      params.push({ $ref: `#/components/parameters/P${i}` });
      componentParams[`P${i}`] = { name: `p${i}`, in: "query" };
    }

    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            parameters: params,
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: { parameters: componentParams },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    // Must terminate
    expect(r.errors.some(e => e.code === "REF_NODE_BUDGET_EXCEEDED")).toBe(true);
  });
});

// =============================================================================
// 22. Resolved schema provenance
// =============================================================================
describe("resolved schema provenance", () => {
  it("outer provenance at ref-use site; resolved provenance at target definition", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/users": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: { type: "object" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const resp = r.endpoints[0]!.responses[0]!;
    const schema = resp.content!["application/json"]!.schema!;

    // Must resolve
    expect(schema.resolved).toBeDefined();

    // Outer provenance at ref-use site
    expect(schema.provenance.sourcePath).toContain("schema");
    expect(schema.provenance.sourcePath).toContain("application~1json");

    // Resolved provenance at target definition
    expect(schema.resolved!.provenance.sourcePath).toContain("/components/schemas/User");
  });
});

// =============================================================================
// 23. Response handling
// =============================================================================
describe("response extraction", () => {
  it("extracts response with description and status codes", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": { description: "ok" },
              "404": { description: "not found" },
            },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.responses).toHaveLength(2);
    expect(r.endpoints[0]!.responses[0]!.description).toBe("ok");
    expect(r.endpoints[0]!.responses[1]!.statusCode).toBe("404");
  });

  it("missing response description: property absent, not ''", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {},
            },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const resp = r.endpoints[0]!.responses[0]!;
    expect("description" in resp).toBe(false);
  });
});

// =============================================================================
// 24. Schema runtime type validation
// =============================================================================
describe("schema runtime type validation", () => {
  it("rejects 'potato' as invalid schema type", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          BadType: { type: "potato" },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schema = r.schemas.find(s => s.name === "BadType")!;
    expect("type" in schema).toBe(false);
    expect(r.errors.some(e => e.code === "INVALID_SCHEMA_TYPE")).toBe(true);
  });

  it("filtered array type: keeps valid, drops invalid, emits warning", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          Mixed: { type: ["string", "potato", 123] },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schema = r.schemas.find(s => s.name === "Mixed")!;
    expect(schema.type).toEqual(["string"]);
    expect(r.errors.some(e => e.code === "INVALID_SCHEMA_TYPE")).toBe(true);
  });

  it("preserves 'null' in type array", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          Nullable: { type: ["string", "null"] },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const schema = r.schemas.find(s => s.name === "Nullable")!;
    expect(schema.type).toEqual(["string", "null"]);
  });
});

// =============================================================================
// 25. Schema bounded extraction
// =============================================================================
describe("schema bounded extraction", () => {
  it("extracts allOf/oneOf/anyOf", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          Comp: {
            allOf: [{ type: "object" }, { properties: { name: { type: "string" } } }],
            oneOf: [{ type: "string" }, { type: "number" }],
            anyOf: [{ type: "boolean" }],
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const s = r.schemas.find(sc => sc.name === "Comp")!;
    expect(s.allOf).toBeDefined();
    expect(s.allOf!).toHaveLength(2);
    expect(s.oneOf).toBeDefined();
    expect(s.oneOf!).toHaveLength(2);
    expect(s.anyOf).toBeDefined();
    expect(s.anyOf!).toHaveLength(1);
  });

  it("extracts items, enum, required, format, nullable, example, default", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: {
        schemas: {
          Full: {
            type: "array",
            items: { type: "string", format: "email" },
            enum: ["a", "b"],
            required: ["name"],
            nullable: true,
            example: "test",
            default: "a",
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const s = r.schemas.find(sc => sc.name === "Full")!;
    expect(s.items).toBeDefined();
    expect(s.items!.type).toBe("string");
    expect(s.items!.format).toBe("email");
    expect(s.enum).toEqual(["a", "b"]);
    expect(s.required).toEqual(["name"]);
    expect(s.nullable).toBe(true);
    expect(s.example).toBe("test");
    expect(s.default).toBe("a");
  });

  it("bounded: deep nesting terminates without throwing", () => {
    let schema: unknown = { type: "string" };
    for (let i = 0; i < 20; i++) {
      schema = { type: "object", properties: { deep: schema } };
    }
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
      components: { schemas: { Deep: schema } },
    });
    expect(() => extractOpenApiStructure(raw, undefined, 0, EVIDENCE)).not.toThrow();
  });
});

// =============================================================================
// 26. Parameter Reference Object chain
// =============================================================================
describe("parameter Reference Object chain", () => {
  it("resolves param → $ref A → $ref B → concrete parameter", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: {
            parameters: [{ $ref: "#/components/parameters/ParamA" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        parameters: {
          ParamA: { $ref: "#/components/parameters/ParamB" },
          ParamB: { name: "id", in: "path", required: true },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.parameters).toHaveLength(1);
    expect(r.endpoints[0]!.parameters[0]!.name).toBe("id");
    expect(r.endpoints[0]!.parameters[0]!.in).toBe("path");
  });
});

// =============================================================================
// 27. RequestBody Reference Object
// =============================================================================
describe("requestBody Reference Object", () => {
  it("resolves requestBody $ref chain", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: { $ref: "#/components/requestBodies/Body" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        requestBodies: {
          Body: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    expect(r.endpoints[0]!.requestBody).toBeDefined();
    expect(r.endpoints[0]!.requestBody!.required).toBe(true);
    expect(r.endpoints[0]!.requestBody!.content["application/json"]).toBeDefined();
    expect(r.endpoints[0]!.requestBody!.content["application/json"]!.schema).toBeDefined();
    expect(r.endpoints[0]!.requestBody!.content["application/json"]!.schema!.type).toBe("object");
  });
});

// =============================================================================
// 28. No vulnerability declarations
// =============================================================================
describe("no vulnerability declarations", () => {
  it("endpoint with security: [] does not trigger vulnerability language", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/api/admin": {
          post: {
            security: [],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      role: { type: "string", enum: ["user", "admin"] },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const resultText = JSON.stringify(r);
    const forbidden = [
      "auth bypass", "IDOR", "broken access control",
      "privilege escalation", "vulnerability", "exploitable",
    ];
    for (const term of forbidden) {
      expect(resultText.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});

// =============================================================================
// 29. Identity stability across documents
// =============================================================================
describe("identity stability", () => {
  it("same endpoint across different documents: findingId stable, occurrenceId different", () => {
    const docA = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "A", version: "1" },
      paths: {
        "/users": {
          get: { description: "doc A", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const docB = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "B", version: "1" },
      paths: {
        "/users": {
          get: { description: "doc B", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const a = extractOpenApiStructure(docA, undefined, 0, EVIDENCE);
    const b = extractOpenApiStructure(docB, undefined, 0, EVIDENCE);
    expect(a.endpoints[0]!.findingId).toBe(b.endpoints[0]!.findingId);
    expect(a.endpoints[0]!.occurrenceId).not.toBe(b.endpoints[0]!.occurrenceId);
  });

  it("same param name/in under different endpoint identities has different findingId", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/a": {
          get: {
            parameters: [{ name: "x", in: "query" }],
            responses: { "200": { description: "ok" } },
          },
        },
        "/b": {
          get: {
            parameters: [{ name: "x", in: "query" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const epA = r.endpoints.find(e => e.path === "/a")!;
    const epB = r.endpoints.find(e => e.path === "/b")!;
    // Different endpoint identities → different param findingIds
    expect(epA.parameters[0]!.findingId).not.toBe(epB.parameters[0]!.findingId);
  });
});

// =============================================================================
// 30. exactOptionalPropertyTypes compliance
// =============================================================================
describe("exactOptionalPropertyTypes", () => {
  it("unobserved optional fields are absent, not present with undefined", () => {
    const raw = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/x": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const r = extractOpenApiStructure(raw, undefined, 0, EVIDENCE);
    const ep = r.endpoints[0]!;
    expect("operationId" in ep).toBe(false);
    expect("summary" in ep).toBe(false);
    expect("tags" in ep).toBe(false);
    expect("servers" in ep).toBe(false);
    expect("security" in ep).toBe(false);
  });
});

// =============================================================================
// 31. ContentHash computed from full source before truncation
// =============================================================================
describe("contentHash and truncation", () => {
  it("contentHash computed from full source before truncation", () => {
    const bigDoc = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1", description: "x".repeat(5000) },
      paths: {},
    });
    const fullHash = contentHash(bigDoc);
    const r = extractOpenApiStructure(bigDoc, undefined, 100, EVIDENCE);
    expect(r.truncated).toBe(true);
    expect(r.contentHash).toBe(fullHash);
  });
});

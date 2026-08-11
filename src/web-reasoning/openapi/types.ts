/**
 * OpenAPI / Swagger structured intelligence types.
 *
 * Identity model:
 *   findingId    = semantic entity identity (e.g. operation + parameter scope)
 *   occurrenceId = findingId + contentHash + logical source pointer
 *
 * Every structured finding carries findingId + occurrenceId + provenance.
 * Nested metadata (e.g. media-type content entries) may omit identity fields.
 *
 * Local $ref expansion is bounded by cycle detection, max depth, and node budget.
 * The `resolved` field MUST NOT create unbounded or cyclic object graphs.
 */

// ---- provenance ----

export interface OpenApiProvenance {
  evidenceIds: string[];
  sourceUrl?: string;
  contentHash: string;
  sourceKind: "openapi";
  /** Logical source path (JSON Pointer / key path), not byte offsets. */
  sourcePath: string;
}

// ---- spec info ----

export type OpenApiSpecKind = "openapi3" | "swagger2";

export interface OpenApiSpecInfo {
  kind: OpenApiSpecKind;
  version: string;
  title?: string;
  description?: string;
}

// ---- servers / base URL ----

export interface OpenApiServerVariable {
  default?: string;
  enum?: string[];
  description?: string;
}

export interface OpenApiServer {
  findingId: string;
  occurrenceId: string;
  url: string;
  description?: string;
  variables?: Record<string, OpenApiServerVariable>;
  provenance: OpenApiProvenance;
}

// ---- security ----

export interface OpenApiSecurityRequirementEntry {
  scheme: string;
  scopes: string[];
}

export interface OpenApiSecurityRequirement {
  /** Per-scheme entries preserving scope ownership. */
  entries: OpenApiSecurityRequirementEntry[];
  provenance: OpenApiProvenance;
}

export interface OpenApiSecurityScheme {
  findingId: string;
  occurrenceId: string;
  /** The security scheme / component identifier (e.g. "MyApiKey"). */
  schemeName: string;
  type?: string;
  /** The apiKey name (e.g. "X-API-Key"), distinct from schemeName. */
  apiKeyName?: string;
  description?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  provenance: OpenApiProvenance;
}

// ---- schemas ----

export type OpenApiSchemaType =
  | "string" | "number" | "integer" | "boolean"
  | "array" | "object" | "null";

export interface OpenApiSchema {
  findingId?: string;
  occurrenceId?: string;
  name?: string;
  type?: OpenApiSchemaType | OpenApiSchemaType[];
  format?: string;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  /** Observed enum values, preserving null / arrays / objects when present. */
  enum?: unknown[];
  nullable?: boolean;
  description?: string;
  example?: unknown;
  default?: unknown;
  /** Inline composition members — each may be a $ref, inline schema, or both. */
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  /** Direct $ref (in-place reference, distinct from allOf/oneOf/anyOf members). */
  $ref?: string;
  /** Resolved schema when $ref was local and resolvable. */
  resolved?: OpenApiSchema;
  /** Reason the $ref target could not be resolved. */
  unresolvedReason?: string;
  provenance: OpenApiProvenance;
}

// ---- parameters ----

export type OpenApiParameterLocation = "query" | "header" | "path" | "cookie";

export interface OpenApiParameter {
  /**
   * Operation-scoped identity:
   *   endpointSemanticKey + ":" + name + ":" + location
   * Component parameters carry their own component-pointer identity.
   */
  findingId: string;
  occurrenceId: string;
  name: string;
  in: OpenApiParameterLocation | "body" | "formData";
  description?: string;
  /** Effective required value (never undefined). */
  required: boolean;
  /** Observed required value from the source document, if explicitly present. */
  requiredObserved?: boolean;
  /** How the effective required value was determined. */
  requiredSource: "explicit" | "spec-implied" | "default";
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: string;
  explode?: boolean;
  schema?: OpenApiSchema;
  /** Swagger 2 primitive type/format fields. */
  type?: string;
  format?: string;
  example?: unknown;
  examples?: Record<string, unknown>;
  provenance: OpenApiProvenance;
}

// ---- request body (OAS3) ----

export interface OpenApiRequestBody {
  findingId: string;
  occurrenceId: string;
  description?: string;
  required: boolean;
  content: Record<string, OpenApiMediaType>;
  provenance: OpenApiProvenance;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
  examples?: Record<string, unknown>;
}

// ---- responses ----

export interface OpenApiResponse {
  findingId: string;
  occurrenceId: string;
  statusCode: string;
  description?: string;
  /** OAS3 response content map. */
  content?: Record<string, OpenApiMediaType>;
  /** Swagger 2 top-level response schema (not wrapped in a media type). */
  schema?: OpenApiSchema;
  headers?: Record<string, OpenApiResponseHeader>;
  provenance: OpenApiProvenance;
}

export interface OpenApiResponseHeader {
  description?: string;
  schema?: OpenApiSchema;
  required?: boolean;
}

// ---- endpoint (path + method) ----

export const OPENAPI_METHODS = [
  "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE",
] as const;

export type OpenApiMethod = (typeof OPENAPI_METHODS)[number];

export interface OpenApiEndpoint {
  findingId: string;
  occurrenceId: string;
  path: string;
  method: OpenApiMethod;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: OpenApiResponse[];
  /** Explicitly declared operation-level security (present on the operation object). */
  security?: OpenApiSecurityRequirement[];
  /** Effective security after inheritance resolution:
   *   operation.security present → operation-level
   *   operation.security = []      → explicitly empty (disabled)
   *   operation.security absent    → inherited from root
   */
  effectiveSecurity?: OpenApiSecurityRequirement[];
  /**
   * Explicitly declared operation-level servers.
   * Effective (operation > path > root) resolution stored in effectiveServers.
   */
  servers?: OpenApiServer[];
  /** Effective servers after precedence resolution. */
  effectiveServers?: OpenApiServer[];
  /** Swagger 2 operation-level consumes override. */
  consumes?: string[];
  /** Swagger 2 operation-level produces override. */
  produces?: string[];
  provenance: OpenApiProvenance;
}

// ---- extraction result ----

export interface OpenApiExtractionResult {
  sourceUrl?: string;
  contentHash: string;
  spec?: OpenApiSpecInfo;
  endpoints: OpenApiEndpoint[];
  schemas: OpenApiSchema[];
  securitySchemes: OpenApiSecurityScheme[];
  servers: OpenApiServer[];
  /** Swagger 2 host field (if present). */
  host?: string;
  /** Swagger 2 basePath field (if present). */
  basePath?: string;
  /** Swagger 2 root schemes (if present). */
  schemes?: string[];
  /** Swagger 2 root consumes (if present). */
  consumes?: string[];
  /** Swagger 2 root produces (if present). */
  produces?: string[];
  errors: OpenApiExtractionError[];
  truncated: boolean;
  degraded: boolean;
  degradationReason?: string;
  /** Unresolved $ref targets kept as evidence. */
  unresolvedRefs: string[];
}

export interface OpenApiExtractionError {
  code: string;
  message: string;
  pointer?: string;
  severity: "warning" | "error";
}

// ---- summary (for evidence record) ----

export interface OpenApiExtractionSummary {
  sourceUrl?: string;
  contentHash: string;
  specKind?: OpenApiSpecKind;
  endpointCount: number;
  schemaCount: number;
  securitySchemeCount: number;
  errorCount: number;
  unresolvedRefCount: number;
  createdEvidenceIds: string[];
}

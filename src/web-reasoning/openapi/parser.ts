/**
 * OpenAPI / Swagger structured extraction.
 *
 * - Structural detection via parse-first, not substring matching
 * - Local $ref resolution only (# / #/...), RFC 6901 JSON Pointer
 * - Shared mutable node budget + branch-local activeRefs for cycle detection
 * - Reusable $ref-chain resolver for schemas, parameters, request bodies, etc.
 * - Parameter merging (path-level + operation-level, operation-scoped identity)
 * - Security inheritance preserving OR/AND alternatives (operation > root)
 * - Server precedence (operation > path > root), explicit [] ≠ absent
 * - No I/O, no remote $refs, no vulnerability declarations
 */

import { createHash } from "node:crypto";
import { parseDocument, isMap, isSeq, isScalar, type YAMLMap, type YAMLSeq, type Scalar } from "yaml";
import {
  endpointSemanticKey,
  parameterSemanticKey as paramIdKey,
  schemaSemanticKey,
  securitySchemeSemanticKey,
  serverSemanticKey as serverIdKey,
  requestBodySemanticKey,
  responseSemanticKey,
  openApiFindingId,
  openApiOccurrenceId,
} from "./identity.js";
import type {
  OpenApiEndpoint,
  OpenApiExtractionError,
  OpenApiExtractionResult,
  OpenApiMediaType,
  OpenApiMethod,
  OpenApiParameter,
  OpenApiParameterLocation,
  OpenApiProvenance,
  OpenApiRequestBody,
  OpenApiResponse,
  OpenApiSchema,
  OpenApiSchemaType,
  OpenApiSecurityRequirement,
  OpenApiSecurityRequirementEntry,
  OpenApiSecurityScheme,
  OpenApiServer,
  OpenApiServerVariable,
  OpenApiSpecInfo,
  OpenApiSpecKind,
} from "./types.js";
import { OPENAPI_METHODS } from "./types.js";

// ---- constants ----

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_REF_DEPTH = 12;
const MAX_RESOLVED_NODES = 1_000;
const MAX_SCHEMAS = 200;
const MAX_SCHEMA_PROPERTIES = 100;
const MAX_SCHEMA_RECURSION = 8;

// ---- RFC 6901 JSON Pointer helpers ----

/** Escape a single pointer token: ~ → ~0, / → ~1 */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Append ONE escaped token to a pointer base. */
function appendPointer(base: string, token: string): string {
  return `${base}/${escapePointerToken(token)}`;
}

/** Append multiple tokens, each escaped individually. */
function appendPointerTokens(base: string, ...tokens: string[]): string {
  let out = base;
  for (const token of tokens) {
    out = appendPointer(out, token);
  }
  return out;
}

function decodePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointerTokens(pointer: string): string[] {
  if (pointer === "" || pointer === "#") return [];
  const raw = pointer.startsWith("#/") ? pointer.slice(2)
    : pointer.startsWith("/") ? pointer.slice(1)
    : pointer;
  return raw.split("/").map(decodePointer);
}

function resolvePointer(root: unknown, tokens: string[]): { value: unknown; pointer: string } | null {
  let current: unknown = root;
  for (let i = 0; i < tokens.length; i++) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    const key = tokens[i]!;
    if (key === "__proto__" || key === "constructor" || key === "prototype") return null;
    if (!Object.prototype.hasOwnProperty.call(current as Record<string, unknown>, key)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  const built = tokens.length === 0
    ? "#"
    : "#/" + tokens.map(t => escapePointerToken(t)).join("/");
  return { value: current, pointer: built };
}

/** Convert a canonical `#/...` pointer to a provenance sourcePath. */
function pointerToSourcePath(pointer: string): string {
  if (pointer === "#") return "";
  if (pointer.startsWith("#/")) return pointer.slice(1);
  return pointer;
}

// ---- $ref resolver: shared budget + branch-local activeRefs ----

interface ResolverBudget {
  resolvedNodes: number;
  unresolvedRefs: Set<string>;
}

function isRef(obj: unknown): obj is { $ref: string } {
  return typeof obj === "object" && obj !== null && typeof (obj as Record<string, unknown>).$ref === "string";
}

function isLocalRef(ref: string): boolean {
  return ref === "#" || ref.startsWith("#/");
}

/**
 * Resolve a single local $ref to its target value.
 *
 * Mutates budget.resolvedNodes and activeRefs on success.
 * activeRefs tracks the current resolution chain — a ref already in
 * activeRefs is a cycle. Independent branches each get their own copy.
 */
function resolveRef(
  refPath: string,
  root: unknown,
  budget: ResolverBudget,
  activeRefs: Set<string>,
  errors: OpenApiExtractionError[],
): { value: unknown; pointer: string } | null {
  if (!isLocalRef(refPath)) {
    budget.unresolvedRefs.add(refPath);
    errors.push({
      code: "REF_REMOTE_OR_EXTERNAL",
      message: `$ref target is not a local JSON Pointer: ${refPath}`,
      pointer: refPath,
      severity: "warning",
    });
    return null;
  }

  if (budget.resolvedNodes >= MAX_RESOLVED_NODES) {
    budget.unresolvedRefs.add(refPath);
    errors.push({
      code: "REF_NODE_BUDGET_EXCEEDED",
      message: `$ref node budget exceeded (max ${MAX_RESOLVED_NODES})`,
      pointer: refPath,
      severity: "warning",
    });
    return null;
  }

  if (activeRefs.size >= MAX_REF_DEPTH) {
    budget.unresolvedRefs.add(refPath);
    errors.push({
      code: "REF_DEPTH_EXCEEDED",
      message: `$ref depth exceeded (max ${MAX_REF_DEPTH}): ${refPath}`,
      pointer: refPath,
      severity: "warning",
    });
    return null;
  }

  const tokens = pointerTokens(refPath);
  const result = resolvePointer(root, tokens);
  if (!result) {
    budget.unresolvedRefs.add(refPath);
    errors.push({
      code: "REF_UNRESOLVED",
      message: `$ref pointer not found in document: ${refPath}`,
      pointer: refPath,
      severity: "warning",
    });
    return null;
  }

  if (activeRefs.has(result.pointer)) {
    budget.unresolvedRefs.add(refPath);
    errors.push({
      code: "REF_CYCLE_DETECTED",
      message: `$ref cycle detected at ${refPath}`,
      pointer: refPath,
      severity: "warning",
    });
    return null;
  }

  activeRefs.add(result.pointer);
  budget.resolvedNodes++;
  return result;
}

// ---- reusable $ref-chain resolver ----

interface DerefChainResult {
  value: unknown;
  observedRef?: string;
  resolvedPointer?: string;
  unresolvedReason?: string;
  chainLength: number;
}

/**
 * Resolve a chain of $ref objects to a concrete value.
 *
 * A → B → C resolves through the chain, tracking each hop in activeRefs.
 * Uses the shared node budget and branch-local activeRefs.
 * Returns the final concrete value plus metadata about the chain.
 */
function derefChainToObject(
  raw: unknown,
  root: unknown,
  budget: ResolverBudget,
  activeRefs: Set<string>,
  errors: OpenApiExtractionError[],
): DerefChainResult {
  if (!isRef(raw)) {
    const r: DerefChainResult = { value: raw, chainLength: 0 };
    return r;
  }

  let current: unknown = raw;
  let observedRef: string | undefined;
  let finalPointer: string | undefined;
  let chainLength = 0;

  while (chainLength < MAX_REF_DEPTH) {
    if (!isRef(current)) {
      const r: DerefChainResult = { value: current, chainLength };
      if (observedRef !== undefined) r.observedRef = observedRef;
      if (finalPointer !== undefined) r.resolvedPointer = finalPointer;
      return r;
    }

    if (observedRef === undefined) observedRef = current.$ref;

    const ref = current.$ref;

    if (!isLocalRef(ref)) {
      budget.unresolvedRefs.add(ref);
      errors.push({
        code: "REF_REMOTE_OR_EXTERNAL",
        message: `$ref target is not a local JSON Pointer: ${ref}`,
        pointer: ref,
        severity: "warning",
      });
      const r: DerefChainResult = { value: current, unresolvedReason: "remote-or-external", chainLength };
      if (observedRef !== undefined) r.observedRef = observedRef;
      return r;
    }

    if (budget.resolvedNodes >= MAX_RESOLVED_NODES) {
      budget.unresolvedRefs.add(ref);
      errors.push({
        code: "REF_NODE_BUDGET_EXCEEDED",
        message: `$ref node budget exceeded (max ${MAX_RESOLVED_NODES})`,
        pointer: ref,
        severity: "warning",
      });
      const r: DerefChainResult = { value: current, unresolvedReason: "node budget", chainLength };
      if (observedRef !== undefined) r.observedRef = observedRef;
      return r;
    }

    if (activeRefs.size >= MAX_REF_DEPTH) {
      budget.unresolvedRefs.add(ref);
      errors.push({
        code: "REF_DEPTH_EXCEEDED",
        message: `$ref depth exceeded (max ${MAX_REF_DEPTH}): ${ref}`,
        pointer: ref,
        severity: "warning",
      });
      const r: DerefChainResult = { value: current, unresolvedReason: "depth exceeded", chainLength };
      if (observedRef !== undefined) r.observedRef = observedRef;
      return r;
    }

    const tokens = pointerTokens(ref);
    const result = resolvePointer(root, tokens);
    if (!result) {
      budget.unresolvedRefs.add(ref);
      errors.push({
        code: "REF_UNRESOLVED",
        message: `$ref pointer not found in document: ${ref}`,
        pointer: ref,
        severity: "warning",
      });
      const r: DerefChainResult = { value: current, unresolvedReason: "unresolved", chainLength };
      if (observedRef !== undefined) r.observedRef = observedRef;
      return r;
    }

    if (activeRefs.has(result.pointer)) {
      budget.unresolvedRefs.add(ref);
      errors.push({
        code: "REF_CYCLE_DETECTED",
        message: `$ref cycle detected at ${ref}`,
        pointer: ref,
        severity: "warning",
      });
      const r: DerefChainResult = { value: current, unresolvedReason: "cycle", chainLength };
      if (observedRef !== undefined) r.observedRef = observedRef;
      return r;
    }

    activeRefs.add(result.pointer);
    budget.resolvedNodes++;
    finalPointer = result.pointer;
    current = result.value;
    chainLength++;
  }

  // Depth exceeded at loop limit
  if (isRef(current)) {
    const ref = current.$ref;
    budget.unresolvedRefs.add(ref);
    errors.push({
      code: "REF_DEPTH_EXCEEDED",
      message: `$ref chain depth exceeded (max ${MAX_REF_DEPTH})`,
      pointer: ref,
      severity: "warning",
    });
    const r: DerefChainResult = { value: current, unresolvedReason: "depth exceeded", chainLength };
    if (observedRef !== undefined) r.observedRef = observedRef;
    return r;
  }

  const r: DerefChainResult = { value: current, chainLength };
  if (observedRef !== undefined) r.observedRef = observedRef;
  if (finalPointer !== undefined) r.resolvedPointer = finalPointer;
  return r;
}

// ---- type guards ----

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

// ---- OpenAPI Schema Type runtime guard ----

const OPENAPI_SCHEMA_TYPES = new Set<OpenApiSchemaType>([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

function isOpenApiSchemaType(value: unknown): value is OpenApiSchemaType {
  return typeof value === "string" && OPENAPI_SCHEMA_TYPES.has(value as OpenApiSchemaType);
}

// ---- provenance ----

function provenance(
  evidenceIds: string[],
  sourceUrl: string | undefined,
  contentHash: string,
  sourcePath: string,
): OpenApiProvenance {
  const p: OpenApiProvenance = {
    evidenceIds,
    contentHash,
    sourceKind: "openapi",
    sourcePath,
  };
  if (sourceUrl !== undefined) p.sourceUrl = sourceUrl;
  return p;
}

// ---- extraction context ----

interface ExtractionCtx {
  root: unknown;
  evidenceIds: string[];
  sourceUrl: string | undefined;
  contentHash: string;
  specKind: OpenApiSpecKind;
  budget: ResolverBudget;
  errors: OpenApiExtractionError[];
  schemaCount: number;
}

// ---- YAML parsing ----

function parseJsonSafe(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface YamlParseResult {
  value: unknown;
  errors: string[];
}

function parseYamlSafe(raw: string): YamlParseResult | null {
  try {
    const doc = parseDocument(raw);
    const docErrs: string[] = [];
    if (doc.errors && doc.errors.length > 0) {
      for (const e of doc.errors) {
        docErrs.push(String((e as { message?: string }).message ?? e));
      }
    }
    if (docErrs.length > 0) {
      return { value: null, errors: docErrs };
    }
    if (!doc || doc.contents === undefined || doc.contents === null) {
      return null;
    }
    return { value: yamlNodeToPlain(doc.contents), errors: [] };
  } catch {
    return null;
  }
}

function yamlNodeToPlain(node: unknown): unknown {
  if (node === null || node === undefined) return null;
  if (isScalar(node)) {
    const s = node as Scalar;
    if (s.value === null) return null;
    return s.value;
  }
  if (isMap(node)) {
    const map = node as YAMLMap<unknown, unknown>;
    const out: Record<string, unknown> = {};
    for (const item of map.items) {
      if (item === null || item === undefined) continue;
      const key = isScalar(item.key) ? String(item.key.value ?? "") : String(item.key);
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = yamlNodeToPlain(item.value);
    }
    return out;
  }
  if (isSeq(node)) {
    const seq = node as YAMLSeq<unknown>;
    return seq.items.map(yamlNodeToPlain);
  }
  return String(node);
}

// ---- spec detection ----

/** OAS3 version: "3." followed by digits (e.g. "3.0.3", "3.1.0"). */
const OAS3_VERSION_RE = /^3\.\d+(?:\.\d+)*$/;

function detectSpec(root: unknown): { kind: OpenApiSpecKind; version: string } | null {
  if (!isObj(root)) return null;
  const openapi = root.openapi;
  const swagger = root.swagger;
  if (isStr(openapi) && OAS3_VERSION_RE.test(openapi)) {
    if (isObj(root.info) && isObj(root.paths)) {
      return { kind: "openapi3", version: openapi };
    }
  }
  if (isStr(swagger) && swagger === "2.0") {
    if (isObj(root.info) && isObj(root.paths)) {
      return { kind: "swagger2", version: swagger };
    }
  }
  return null;
}

// ---- spec info ----

function extractSpecInfo(root: Record<string, unknown>, kind: OpenApiSpecKind): OpenApiSpecInfo {
  const info = isObj(root.info) ? root.info : {};
  const si: OpenApiSpecInfo = {
    kind,
    version: isStr(root.openapi) ? root.openapi : isStr(root.swagger) ? root.swagger : "unknown",
  };
  if (isStr(info.title)) si.title = info.title;
  if (isStr(info.description)) si.description = info.description;
  return si;
}

// ---- schema extraction (bounded, $ref-chain recursive) ----

function extractSchema(
  raw: unknown,
  sourcePath: string,
  ctx: ExtractionCtx,
  activeRefs: Set<string>,
  name?: string,
  depth = 0,
): OpenApiSchema | undefined {
  if (depth > MAX_SCHEMA_RECURSION) return undefined;
  if (ctx.schemaCount >= MAX_SCHEMAS) return undefined;

  const prov = provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, sourcePath);

  // --- $ref chain: resolve A → B → C with derefChainToObject ---
  if (isRef(raw)) {
    const chain = derefChainToObject(raw, ctx.root, ctx.budget, activeRefs, ctx.errors);
    ctx.schemaCount++;

    const schema: OpenApiSchema = { provenance: prov };
    if (name !== undefined) schema.name = name;

    if (chain.observedRef) schema.$ref = chain.observedRef;

    if (chain.unresolvedReason) {
      schema.unresolvedReason = chain.unresolvedReason;
      return schema;
    }

    // Extract from resolved target with TARGET provenance
    const targetPath = chain.resolvedPointer
      ? pointerToSourcePath(chain.resolvedPointer)
      : sourcePath;
    // activeRefs already contains the full chain; keep it so the target
    // can detect cycles back into the chain
    const resolved = extractSchema(chain.value, targetPath, ctx, activeRefs, name, depth + 1);
    if (resolved) schema.resolved = resolved;

    return schema;
  }

  // --- non-$ref, non-object ---
  if (!isObj(raw)) {
    return { provenance: prov };
  }

  // --- normal schema object ---
  ctx.schemaCount++;
  const schema: OpenApiSchema = { provenance: prov };
  if (name !== undefined) schema.name = name;

  if (isOpenApiSchemaType(raw.type)) {
    schema.type = raw.type;
  } else if (isArr(raw.type)) {
    const observedTypes = raw.type.filter(isOpenApiSchemaType);
    if (observedTypes.length > 0) {
      schema.type = observedTypes;
    }
    if (observedTypes.length !== raw.type.length) {
      ctx.errors.push({
        code: "INVALID_SCHEMA_TYPE",
        message: "Schema type array contains unsupported/non-string values",
        pointer: sourcePath,
        severity: "warning",
      });
    }
  } else if (raw.type !== undefined) {
    ctx.errors.push({
      code: "INVALID_SCHEMA_TYPE",
      message: "Schema type is not a recognized OpenAPI/JSON Schema type",
      pointer: sourcePath,
      severity: "warning",
    });
  }
  if (isStr(raw.format)) schema.format = raw.format;
  if (isStr(raw.description)) schema.description = raw.description;
  if (raw.nullable === true) schema.nullable = true;
  if (raw.example !== undefined) schema.example = raw.example;
  if (raw.default !== undefined) schema.default = raw.default;

  // required
  if (isArr(raw.required)) {
    const req = raw.required.filter(isStr);
    if (req.length > 0 && req.length <= MAX_SCHEMA_PROPERTIES) schema.required = req;
  }

  // enum
  if (isArr(raw.enum)) {
    schema.enum = raw.enum.slice(0, MAX_SCHEMA_PROPERTIES);
  }

  // properties — each sibling gets its own activeRefs copy
  if (isObj(raw.properties)) {
    const props: Record<string, OpenApiSchema> = {};
    const entries = Object.entries(raw.properties).slice(0, MAX_SCHEMA_PROPERTIES);
    for (const [key, val] of entries) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const propRefs = new Set(activeRefs);
      const extracted = extractSchema(
        val,
        appendPointerTokens(sourcePath, "properties", key),
        ctx,
        propRefs,
        undefined,
        depth + 1,
      );
      if (extracted) props[key] = extracted;
    }
    if (Object.keys(props).length > 0) schema.properties = props;
  }

  // items
  if (raw.items !== undefined) {
    const itemRefs = new Set(activeRefs);
    const extracted = extractSchema(
      raw.items,
      appendPointer(sourcePath, "items"),
      ctx,
      itemRefs,
      undefined,
      depth + 1,
    );
    if (extracted) schema.items = extracted;
  }

  // composition — each member gets its own activeRefs copy
  for (const compKey of ["allOf", "oneOf", "anyOf"] as const) {
    if (isArr(raw[compKey])) {
      const members: OpenApiSchema[] = [];
      const arr = raw[compKey] as unknown[];
      for (let i = 0; i < arr.length && i < MAX_SCHEMA_PROPERTIES; i++) {
        const memberRefs = new Set(activeRefs);
        const member = extractSchema(
          arr[i],
          appendPointerTokens(sourcePath, compKey, String(i)),
          ctx,
          memberRefs,
          undefined,
          depth + 1,
        );
        if (member) members.push(member);
      }
      if (members.length > 0) schema[compKey] = members;
    }
  }

  return schema;
}

// ---- security requirement extraction (preserves OR/AND + empty {} entries) ----

/**
 * Extract security requirements preserving OR/AND semantics.
 *
 * Returns:
 * - undefined  → field not present
 * - []         → explicitly empty (security disabled)
 * - [...]      → one requirement object per array element
 *
 * Empty requirement objects `{}` are preserved as `{ entries: [], provenance }`.
 * Non-object elements are skipped with a warning.
 */
function extractSecurityRequirements(
  raw: unknown,
  sourcePath: string,
  ctx: ExtractionCtx,
): OpenApiSecurityRequirement[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isArr(raw)) return undefined;
  if (raw.length === 0) return [];

  const requirements: OpenApiSecurityRequirement[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isObj(item)) {
      ctx.errors.push({
        code: "MALFORMED_SECURITY_REQUIREMENT",
        message: `Security requirement at index ${i} is not an object; skipping`,
        pointer: appendPointer(sourcePath, String(i)),
        severity: "warning",
      });
      continue;
    }
    const entries: OpenApiSecurityRequirementEntry[] = [];
    for (const [scheme, scopesRaw] of Object.entries(item)) {
      entries.push({
        scheme,
        scopes: isArr(scopesRaw) ? scopesRaw.filter(isStr) : [],
      });
    }
    // Always push — even empty entries (preserves `{}`)
    requirements.push({
      entries,
      provenance: provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, appendPointer(sourcePath, String(i))),
    });
  }
  return requirements;
}

// ---- security scheme extraction (spec-kind-aware pointers) ----

function extractSecuritySchemes(
  root: Record<string, unknown>,
  ctx: ExtractionCtx,
): OpenApiSecurityScheme[] {
  const schemes: OpenApiSecurityScheme[] = [];

  let schemeMap: Record<string, unknown> | null = null;
  let basePointer: string;

  if (ctx.specKind === "openapi3") {
    const components = isObj(root.components) ? root.components : null;
    schemeMap = components && isObj(components.securitySchemes)
      ? components.securitySchemes as Record<string, unknown>
      : null;
    basePointer = "/components/securitySchemes";
  } else {
    schemeMap = isObj(root.securityDefinitions)
      ? root.securityDefinitions as Record<string, unknown>
      : null;
    basePointer = "/securityDefinitions";
  }

  if (!schemeMap) return [];

  for (const [key, raw] of Object.entries(schemeMap)) {
    if (!isObj(raw)) continue;
    const sp = appendPointer(basePointer, key);
    const fid = openApiFindingId("security", securitySchemeSemanticKey(`#${appendPointer(basePointer, key)}`));
    const oid = openApiOccurrenceId(fid, ctx.contentHash, sp);

    const s: OpenApiSecurityScheme = {
      findingId: fid,
      occurrenceId: oid,
      schemeName: key,
      provenance: provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, sp),
    };
    if (isStr(raw.type)) s.type = raw.type;
    if (isStr(raw.description)) s.description = raw.description;
    if (isStr(raw.in)) s.in = raw.in;
    if (isStr(raw.scheme)) s.scheme = raw.scheme;
    if (isStr(raw.bearerFormat)) s.bearerFormat = raw.bearerFormat;
    if (isStr(raw.name)) s.apiKeyName = raw.name;
    schemes.push(s);
  }
  return schemes;
}

// ---- server extraction ----

function extractServers(
  raw: unknown,
  sourcePath: string,
  ctx: ExtractionCtx,
): OpenApiServer[] {
  if (!isArr(raw)) return [];
  const servers: OpenApiServer[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isObj(item) || !isStr(item.url)) continue;
    const urlTemplate = item.url as string;
    const sp = appendPointer(sourcePath, String(i));
    const fid = openApiFindingId("server", serverIdKey(urlTemplate));
    const oid = openApiOccurrenceId(fid, ctx.contentHash, sp);

    const s: OpenApiServer = {
      findingId: fid,
      occurrenceId: oid,
      url: urlTemplate,
      provenance: provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, sp),
    };
    if (isStr(item.description)) s.description = item.description;
    if (isObj(item.variables)) {
      const vars: Record<string, OpenApiServerVariable> = {};
      for (const [vk, vv] of Object.entries(item.variables)) {
        if (!isObj(vv)) continue;
        const sv: OpenApiServerVariable = {};
        if (isStr(vv.default)) sv.default = vv.default;
        if (isStr(vv.description)) sv.description = vv.description;
        if (isArr(vv.enum)) sv.enum = vv.enum.filter(isStr);
        vars[vk] = sv;
      }
      if (Object.keys(vars).length > 0) s.variables = vars;
    }
    servers.push(s);
  }
  return servers;
}

// ---- media type extraction ----

function extractMediaType(
  raw: unknown,
  sourcePath: string,
  ctx: ExtractionCtx,
  activeRefs: Set<string>,
): OpenApiMediaType | undefined {
  if (!isObj(raw)) return undefined;
  const mt: OpenApiMediaType = {};
  if (raw.schema !== undefined) {
    const schemaRefs = new Set(activeRefs);
    const extracted = extractSchema(
      raw.schema,
      appendPointer(sourcePath, "schema"),
      ctx,
      schemaRefs,
    );
    if (extracted) mt.schema = extracted;
  }
  if (raw.example !== undefined) mt.example = raw.example;
  if (isObj(raw.examples)) mt.examples = raw.examples as Record<string, unknown>;
  return mt;
}

// ---- response extraction ----

function extractResponses(
  raw: unknown,
  endpointKey: string,
  sourcePath: string,
  ctx: ExtractionCtx,
  activeRefs: Set<string>,
): OpenApiResponse[] {
  if (!isObj(raw)) return [];
  const responses: OpenApiResponse[] = [];
  for (const [code, respRaw] of Object.entries(raw)) {
    if (!isObj(respRaw)) continue;
    const sp = appendPointer(sourcePath, code);
    const sk = responseSemanticKey(endpointKey, code);
    const fid = openApiFindingId("response", sk);
    const oid = openApiOccurrenceId(fid, ctx.contentHash, sp);

    const r: OpenApiResponse = {
      findingId: fid,
      occurrenceId: oid,
      statusCode: code,
      provenance: provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, sp),
    };
    if (isStr(respRaw.description)) r.description = respRaw.description;

    if (isObj(respRaw.content)) {
      const content: Record<string, OpenApiMediaType> = {};
      for (const [ct, mtRaw] of Object.entries(respRaw.content)) {
        const mtRefs = new Set(activeRefs);
        const mt = extractMediaType(
          mtRaw,
          appendPointerTokens(sp, "content", ct),
          ctx,
          mtRefs,
        );
        if (mt) content[ct] = mt;
      }
      if (Object.keys(content).length > 0) r.content = content;
    }

    // Swagger 2 top-level response schema (not wrapped in a media type)
    if (ctx.specKind === "swagger2" && respRaw.schema !== undefined) {
      const respSchemaRefs = new Set(activeRefs);
      const extracted = extractSchema(
        respRaw.schema,
        appendPointer(sp, "schema"),
        ctx,
        respSchemaRefs,
      );
      if (extracted) r.schema = extracted;
    }

    if (isObj(respRaw.headers)) {
      const headers: Record<string, { description?: string; schema?: OpenApiSchema; required?: boolean }> = {};
      for (const [hk, hv] of Object.entries(respRaw.headers)) {
        if (!isObj(hv)) continue;
        const h: { description?: string; schema?: OpenApiSchema; required?: boolean } = {};
        if (isStr(hv.description)) h.description = hv.description;
        if (hv.schema !== undefined) {
          const hdrRefs = new Set(activeRefs);
          const hExtracted = extractSchema(
            hv.schema,
            appendPointerTokens(sp, "headers", hk, "schema"),
            ctx,
            hdrRefs,
          );
          if (hExtracted) h.schema = hExtracted;
        }
        if (isBool(hv.required)) h.required = hv.required;
        headers[hk] = h;
      }
      if (Object.keys(headers).length > 0) r.headers = headers;
    }

    responses.push(r);
  }
  return responses;
}

// ---- parameter extraction ----

/**
 * Canonicalize parameter location.
 *
 * Swagger 2 `formData` is lowercased to `formdata` by toLowerCase(),
 * but the canonical output must be `"formData"`.
 */
function normalizeParamLocation(
  raw: string,
  specKind: OpenApiSpecKind,
): OpenApiParameter["in"] | null {
  const lower = raw.toLowerCase();

  if (specKind === "swagger2") {
    if (lower === "formdata") return "formData";
    if (lower === "query" || lower === "header" || lower === "path" || lower === "body") {
      return lower as OpenApiParameter["in"];
    }
    return null;
  }

  // OAS3
  if (lower === "query" || lower === "header" || lower === "path" || lower === "cookie") {
    return lower as OpenApiParameter["in"];
  }
  return null;
}

/** Collision-safe merge key for parameters. */
function paramMergeKey(name: string, loc: string): string {
  return JSON.stringify([name, loc]);
}

function extractParameter(
  raw: unknown,
  endpointKey: string,
  sourcePath: string,
  ctx: ExtractionCtx,
  activeRefs: Set<string>,
): OpenApiParameter | undefined {
  // $ref-chain resolution: parameter → $ref A → $ref B → concrete Parameter Object
  const chain = derefChainToObject(raw, ctx.root, ctx.budget, activeRefs, ctx.errors);
  const obj = chain.value;

  if (!isObj(obj) || !isStr(obj.name)) return undefined;
  const rawIn = isStr(obj.in) ? obj.in : "";
  const loc = normalizeParamLocation(rawIn, ctx.specKind);
  if (!loc) return undefined;

  const name = obj.name as string;
  const sk = paramIdKey(endpointKey, name, loc);
  const fid = openApiFindingId("param", sk);
  const oid = openApiOccurrenceId(fid, ctx.contentHash, sourcePath);

  // Required semantics: only actual boolean is observed
  let required: boolean;
  let requiredSource: OpenApiParameter["requiredSource"];
  let requiredObserved: boolean | undefined;

  if (isBool(obj.required)) {
    requiredObserved = obj.required;
    if (loc === "path") {
      required = true;
      if (requiredObserved) {
        requiredSource = "explicit";
      } else {
        requiredSource = "spec-implied";
        ctx.errors.push({
          code: "PATH_PARAM_REQUIRED_FALSE",
          message: `Path parameter "${name}" has required: false, which contradicts the OpenAPI specification; effective required remains true`,
          pointer: sourcePath,
          severity: "warning",
        });
      }
    } else {
      required = requiredObserved;
      requiredSource = "explicit";
    }
  } else {
    if (loc === "path") {
      required = true;
      requiredSource = "spec-implied";
    } else {
      required = false;
      requiredSource = "default";
    }
  }

  const p: OpenApiParameter = {
    findingId: fid,
    occurrenceId: oid,
    name,
    in: loc,
    required,
    requiredSource,
    provenance: provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, sourcePath),
  };
  if (requiredObserved !== undefined) p.requiredObserved = requiredObserved;
  if (isStr(obj.description)) p.description = obj.description;
  if (obj.deprecated === true) p.deprecated = true;
  if (obj.allowEmptyValue === true) p.allowEmptyValue = true;
  if (isStr(obj.style)) p.style = obj.style;
  if (obj.explode === true) p.explode = true;
  if (isStr(obj.type)) p.type = obj.type;
  if (isStr(obj.format)) p.format = obj.format;
  if (obj.example !== undefined) p.example = obj.example;
  if (isObj(obj.examples)) p.examples = obj.examples as Record<string, unknown>;

  if (obj.schema !== undefined) {
    const schemaRefs = new Set(activeRefs);
    const extracted = extractSchema(
      obj.schema,
      appendPointer(sourcePath, "schema"),
      ctx,
      schemaRefs,
    );
    if (extracted) p.schema = extracted;
  }

  return p;
}

// ---- request body extraction (OAS3 only) ----

function extractRequestBody(
  raw: unknown,
  endpointKey: string,
  sourcePath: string,
  ctx: ExtractionCtx,
  activeRefs: Set<string>,
): OpenApiRequestBody | undefined {
  // $ref-chain resolution for requestBody Reference Objects
  const chain = derefChainToObject(raw, ctx.root, ctx.budget, activeRefs, ctx.errors);
  const obj = chain.value;

  if (!isObj(obj)) return undefined;
  const sk = requestBodySemanticKey(endpointKey);
  const fid = openApiFindingId("requestBody", sk);
  const oid = openApiOccurrenceId(fid, ctx.contentHash, sourcePath);

  const rb: OpenApiRequestBody = {
    findingId: fid,
    occurrenceId: oid,
    required: obj.required === true,
    content: {},
    provenance: provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, sourcePath),
  };
  if (isStr(obj.description)) rb.description = obj.description;

  if (isObj(obj.content)) {
    for (const [ct, mtRaw] of Object.entries(obj.content)) {
      const mtRefs = new Set(activeRefs);
      const mt = extractMediaType(
        mtRaw,
        appendPointerTokens(sourcePath, "content", ct),
        ctx,
        mtRefs,
      );
      if (mt) rb.content[ct] = mt;
    }
  }

  return rb;
}

// ---- main endpoint extraction ----

function extractEndpoints(
  paths: Record<string, unknown>,
  root: Record<string, unknown>,
  ctx: ExtractionCtx,
): OpenApiEndpoint[] {
  const endpoints: OpenApiEndpoint[] = [];

  // Root security
  const rootSecurity = extractSecurityRequirements(root.security, "/security", ctx);

  // Root servers (OAS3 only, absent vs present)
  let rootServers: OpenApiServer[] | undefined;
  if (ctx.specKind === "openapi3" && root.servers !== undefined) {
    rootServers = extractServers(root.servers, "/servers", ctx);
  }

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!isObj(pathItem)) continue;

    const escapedPathRef = appendPointer("/paths", rawPath);

    // Raw path-level parameter observations (unknown[]) — rebound per operation
    const rawPathParams: unknown[] = isArr(pathItem.parameters)
      ? pathItem.parameters as unknown[]
      : [];

    // Path-level servers (OAS3 only, absent vs present)
    let pathServers: OpenApiServer[] | undefined;
    if (ctx.specKind === "openapi3" && pathItem.servers !== undefined) {
      pathServers = extractServers(
        pathItem.servers,
        appendPointer(escapedPathRef, "servers"),
        ctx,
      );
    }

    for (const methodName of OPENAPI_METHODS) {
      const lower = methodName.toLowerCase();
      const operation = (pathItem as Record<string, unknown>)[lower];
      if (!isObj(operation)) continue;

      const ekey = endpointSemanticKey(rawPath, methodName);
      const opSourcePath = appendPointer(escapedPathRef, lower);
      const fid = openApiFindingId("endpoint", ekey);
      const oid = openApiOccurrenceId(fid, ctx.contentHash, opSourcePath);

      const ep: OpenApiEndpoint = {
        findingId: fid,
        occurrenceId: oid,
        path: rawPath,
        method: methodName,
        parameters: [],
        responses: [],
        provenance: provenance(ctx.evidenceIds, ctx.sourceUrl, ctx.contentHash, opSourcePath),
      };

      if (isStr(operation.operationId)) ep.operationId = operation.operationId;
      if (isStr(operation.summary)) ep.summary = operation.summary;
      if (isStr(operation.description)) ep.description = operation.description;
      if (isArr(operation.tags)) ep.tags = operation.tags.filter(isStr);
      if (operation.deprecated === true) ep.deprecated = true;

      // Swagger 2 operation-level consumes/produces (gated)
      if (ctx.specKind === "swagger2") {
        if (isArr(operation.consumes)) ep.consumes = operation.consumes.filter(isStr);
        if (isArr(operation.produces)) ep.produces = operation.produces.filter(isStr);
      }

      // --- Parameters: rebind path-level + extract operation-level ---

      // Path-level params rebound with the real operation-scoped endpoint key
      const reboundPathParams: OpenApiParameter[] = [];
      for (let i = 0; i < rawPathParams.length; i++) {
        const paramRefs = new Set<string>();
        const param = extractParameter(
          rawPathParams[i],
          ekey,
          appendPointerTokens(escapedPathRef, "parameters", String(i)),
          ctx,
          paramRefs,
        );
        if (param) reboundPathParams.push(param);
      }

      // Operation-level params
      const opParams: OpenApiParameter[] = [];
      if (isArr(operation.parameters)) {
        const opParamsRaw = operation.parameters as unknown[];
        for (let i = 0; i < opParamsRaw.length; i++) {
          const paramRefs = new Set<string>();
          const param = extractParameter(
            opParamsRaw[i],
            ekey,
            appendPointerTokens(opSourcePath, "parameters", String(i)),
            ctx,
            paramRefs,
          );
          if (param) opParams.push(param);
        }
      }

      // Merge by (name, in): operation param overrides path param
      const merged = new Map<string, OpenApiParameter>();
      for (const pp of reboundPathParams) {
        merged.set(paramMergeKey(pp.name, pp.in), pp);
      }
      for (const op of opParams) {
        merged.set(paramMergeKey(op.name, op.in), op);
      }
      ep.parameters = [...merged.values()];

      // Request body (OAS3 only, gated)
      if (ctx.specKind === "openapi3" && operation.requestBody !== undefined) {
        const rbRefs = new Set<string>();
        const rb = extractRequestBody(
          operation.requestBody,
          ekey,
          appendPointer(opSourcePath, "requestBody"),
          ctx,
          rbRefs,
        );
        if (rb) ep.requestBody = rb;
      }

      // Responses
      if (isObj(operation.responses)) {
        const respRefs = new Set<string>();
        ep.responses = extractResponses(
          operation.responses,
          ekey,
          appendPointer(opSourcePath, "responses"),
          ctx,
          respRefs,
        );
      }

      // --- Security inheritance ---
      // operation present → use it (even [])
      // operation absent → inherit root
      if (operation.security !== undefined) {
        const opSec = extractSecurityRequirements(
          operation.security,
          appendPointer(opSourcePath, "security"),
          ctx,
        );
        if (opSec !== undefined) {
          ep.security = opSec;
          ep.effectiveSecurity = opSec;
        }
      } else {
        if (rootSecurity !== undefined) {
          ep.effectiveSecurity = rootSecurity;
        }
      }

      // --- Server precedence (OAS3 only, gated) ---
      // operation present → use it (even [])
      // operation absent → inherit path
      // path absent → inherit root
      if (ctx.specKind === "openapi3") {
        if (operation.servers !== undefined) {
          const opServers = extractServers(
            operation.servers,
            appendPointer(opSourcePath, "servers"),
            ctx,
          );
          ep.servers = opServers;
          ep.effectiveServers = opServers;
        } else if (pathServers !== undefined) {
          ep.effectiveServers = pathServers;
        } else if (rootServers !== undefined) {
          ep.effectiveServers = rootServers;
        }
      }

      endpoints.push(ep);
    }
  }

  return endpoints;
}

// ---- root schema extraction (spec-kind-aware pointers) ----

function extractRootSchemas(
  root: Record<string, unknown>,
  ctx: ExtractionCtx,
): OpenApiSchema[] {
  const schemas: OpenApiSchema[] = [];

  let schemaMap: Record<string, unknown> | null = null;
  let basePointer: string;

  if (ctx.specKind === "openapi3") {
    const components = isObj(root.components) ? root.components : null;
    schemaMap = components && isObj(components.schemas)
      ? components.schemas as Record<string, unknown>
      : null;
    basePointer = "/components/schemas";
  } else {
    schemaMap = isObj(root.definitions)
      ? root.definitions as Record<string, unknown>
      : null;
    basePointer = "/definitions";
  }

  if (!schemaMap) return [];

  for (const [name, raw] of Object.entries(schemaMap)) {
    if (ctx.schemaCount >= MAX_SCHEMAS) break;
    const sp = appendPointer(basePointer, name);
    const schemaRefs = new Set<string>();
    const extracted = extractSchema(raw, sp, ctx, schemaRefs, name);
    if (!extracted) continue;

    // Stable identity for named schemas
    const fid = openApiFindingId("schema", schemaSemanticKey(`#${appendPointer(basePointer, name)}`));
    const oid = openApiOccurrenceId(fid, ctx.contentHash, sp);
    extracted.findingId = fid;
    extracted.occurrenceId = oid;

    schemas.push(extracted);
  }
  return schemas;
}

// ---- main extraction ----

export function extractOpenApiStructure(
  raw: string,
  sourceUrl: string | undefined,
  maxBytes: number,
  evidenceIds: string[],
): OpenApiExtractionResult {
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const errors: OpenApiExtractionError[] = [];
  const effectiveMax = maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const budget: ResolverBudget = { resolvedNodes: 0, unresolvedRefs: new Set() };

  // Bound input (UTF-8 safe)
  const buf = Buffer.from(raw, "utf8");
  let truncated = false;
  let input: string;
  if (buf.length > effectiveMax) {
    truncated = true;
    let cut = effectiveMax;
    while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
    input = buf.subarray(0, cut).toString("utf8");
  } else {
    input = raw;
  }

  function buildResult(degraded: boolean): OpenApiExtractionResult {
    const r: OpenApiExtractionResult = {
      contentHash,
      endpoints: [],
      schemas: [],
      securitySchemes: [],
      servers: [],
      errors,
      unresolvedRefs: [...budget.unresolvedRefs],
      truncated,
      degraded,
    };
    if (sourceUrl !== undefined) r.sourceUrl = sourceUrl;
    return r;
  }

  // Parse: try JSON first, then YAML
  let parsed: unknown = parseJsonSafe(input);

  if (parsed === null) {
    const yamlResult = parseYamlSafe(input);
    if (yamlResult === null) {
      errors.push({
        code: "PARSE_FAILURE",
        message: "Failed to parse input as JSON or YAML",
        severity: "error",
      });
      const r = buildResult(true);
      r.degradationReason = "parse failure";
      return r;
    }
    if (yamlResult.errors.length > 0) {
      for (const msg of yamlResult.errors) {
        errors.push({
          code: "YAML_PARSE_ERROR",
          message: msg,
          severity: "error",
        });
      }
      const r = buildResult(true);
      r.degradationReason = "yaml parse errors";
      return r;
    }
    parsed = yamlResult.value;
  }

  if (parsed === null || !isObj(parsed)) {
    errors.push({
      code: "PARSE_FAILURE",
      message: "Parsed value is not a JSON object",
      severity: "error",
    });
    const r = buildResult(true);
    r.degradationReason = "parse failure";
    return r;
  }

  // Detect spec
  const spec = detectSpec(parsed);
  if (!spec) {
    errors.push({
      code: "NOT_OPENAPI",
      message: "Document root does not match OpenAPI 3.x or Swagger 2.0 structure",
      severity: "error",
    });
    const r = buildResult(true);
    r.degradationReason = "not OpenAPI/Swagger";
    return r;
  }

  const root = parsed as Record<string, unknown>;

  const ctx: ExtractionCtx = {
    root: parsed,
    evidenceIds,
    sourceUrl,
    contentHash,
    specKind: spec.kind,
    budget,
    errors,
    schemaCount: 0,
  };

  // Spec info
  const specInfo = extractSpecInfo(root, spec.kind);

  // Servers (OAS3 only, absent vs present)
  let servers: OpenApiServer[] = [];
  if (spec.kind === "openapi3" && root.servers !== undefined) {
    servers = extractServers(root.servers, "/servers", ctx);
  }

  // Swagger 2 root fields
  let host: string | undefined;
  let basePath: string | undefined;
  let schemes: string[] | undefined;
  let consumes: string[] | undefined;
  let produces: string[] | undefined;
  if (spec.kind === "swagger2") {
    if (isStr(root.host)) host = root.host;
    if (isStr(root.basePath)) basePath = root.basePath;
    if (isArr(root.schemes)) schemes = root.schemes.filter(isStr);
    if (isArr(root.consumes)) consumes = root.consumes.filter(isStr);
    if (isArr(root.produces)) produces = root.produces.filter(isStr);
  }

  // Security schemes
  const securitySchemes = extractSecuritySchemes(root, ctx);

  // Schemas
  const schemas = extractRootSchemas(root, ctx);

  // Endpoints
  const pathsObj = isObj(root.paths) ? root.paths : {};
  const endpoints = extractEndpoints(pathsObj, root, ctx);

  const r = buildResult(false);
  r.spec = specInfo;
  r.endpoints = endpoints;
  r.schemas = schemas;
  r.securitySchemes = securitySchemes;
  r.servers = servers;
  if (host !== undefined) r.host = host;
  if (basePath !== undefined) r.basePath = basePath;
  if (schemes !== undefined) r.schemes = schemes;
  if (consumes !== undefined) r.consumes = consumes;
  if (produces !== undefined) r.produces = produces;
  return r;
}

/**
 * HTML structured extraction using htmlparser2 for DOM structure.
 * Regex is used ONLY for API-like string auxiliary extraction.
 */

import { createHash } from "node:crypto";
import { parseDocument, DomUtils } from "htmlparser2";
import { isTag, type AnyNode, type Element } from "domhandler";
import {
  apiEndpointSemanticKey,
  formSemanticKey,
  htmlFindingId,
  htmlOccurrenceId,
  linkSemanticKey,
  scriptSemanticKey,
} from "./identity.js";
import type {
  HtmlApiEndpoint,
  HtmlBaseInfo,
  HtmlCommentFinding,
  HtmlExtractionError,
  HtmlExtractionResult,
  HtmlFormField,
  HtmlFormFinding,
  HtmlLinkFinding,
  HtmlMetaFinding,
  HtmlProvenance,
  HtmlScriptFinding,
} from "./types.js";

// ---- constants ----

const DEFAULT_MAX_BYTES = 256 * 1024;
const FORM_FIELD_TAGS = new Set(["input", "select", "textarea", "button"]);

// ---- helpers ----

type CommentNode = Extract<AnyNode, { type: "comment" }>;

function isCommentNode(node: AnyNode): node is CommentNode {
  return node.type === "comment";
}

function collectCommentNodes(nodes: AnyNode[]): CommentNode[] {
  const out: CommentNode[] = [];
  const walk = (items: AnyNode[]): void => {
    for (const node of items) {
      if (isCommentNode(node)) {
        out.push(node);
      }
      if ("children" in node && Array.isArray(node.children)) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Convert htmlparser2's `number | null` to `number | undefined`. */
function n2u(v: number | null): number | undefined {
  return v === null ? undefined : v;
}

function utf8Slice(input: string, maxBytes: number): { sliced: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) return { sliced: input, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { sliced: buf.subarray(0, cut).toString("utf8"), truncated: true };
}

function excerpt(text: string, maxLength = 200): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength) + "…";
}

function textContent(node: AnyNode): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === "text") parts.push(n.data);
    if ("children" in n && n.children) for (const child of n.children) walk(child);
  };
  walk(node);
  return parts.join("").trim();
}

function sourceSlice(
  html: string,
  start: number | undefined,
  end: number | undefined,
  fallback: string,
): string {
  if (start !== undefined && end !== undefined && start >= 0 && end >= start) {
    return html.slice(start, end + 1);
  }
  return fallback;
}

function provenance(
  evidenceIds: string[],
  sourceUrl: string | undefined,
  contentHash: string,
  sourceKind: HtmlProvenance["sourceKind"],
  startOffset: number | undefined,
  endOffset: number | undefined,
  excerptText: string,
): HtmlProvenance {
  const p: HtmlProvenance = {
    evidenceIds,
    contentHash,
    sourceKind,
    excerpt: excerpt(excerptText),
  };
  if (sourceUrl !== undefined) p.sourceUrl = sourceUrl;
  if (startOffset !== undefined) p.startOffset = startOffset;
  if (endOffset !== undefined) p.endOffset = endOffset;
  return p;
}

// ---- URL resolution ----

export function resolveUrl(rawUrl: string, sourceUrl: string, baseHref?: string): string {
  const base = baseHref ?? sourceUrl;
  try {
    return new URL(rawUrl, base).toString();
  } catch {
    return rawUrl;
  }
}

// ---- form field extraction ----

function extractFormField(
  el: Element,
  html: string,
  effectiveBase: string,
  evidenceIds: string[],
  sourceUrl: string | undefined,
  contentHash: string,
): HtmlFormField {
  const a = el.attribs;
  const tag = el.tagName as HtmlFormField["tag"];
  const si = n2u(el.startIndex);
  const ei = n2u(el.endIndex);
  const provExcerpt = sourceSlice(
    html, si, ei,
    `<${tag}${Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join("")}>`,
  );

  const field: HtmlFormField = {
    tag,
    provenance: provenance(evidenceIds, sourceUrl, contentHash, "html", si, ei, provExcerpt),
  };
  if (a.name !== undefined) field.name = a.name;

  if (tag === "input") {
    field.type = (a.type ?? "text").toLowerCase();
    if (a.value !== undefined) field.value = a.value;
    if (a.placeholder !== undefined) field.placeholder = a.placeholder;
    if (a.required !== undefined) field.required = true;
    if (a.disabled !== undefined) field.disabled = true;
    if (a.formaction) field.formaction = resolveUrl(a.formaction, effectiveBase);
    if (a.formmethod) field.formmethod = a.formmethod.toUpperCase();
  } else if (tag === "select") {
    if (a.multiple !== undefined) field.multiple = true;
    if (a.required !== undefined) field.required = true;
    if (a.disabled !== undefined) field.disabled = true;
    const options = DomUtils.findAll(
      (n) => isTag(n) && n.tagName === "option",
      el.children,
    ) as Element[];
    const vals: string[] = [];
    for (const opt of options) {
      const oa = opt.attribs;
      if (oa.value !== undefined) vals.push(oa.value);
      else vals.push(textContent(opt));
    }
    if (vals.length > 0) field.values = vals;
  } else if (tag === "textarea") {
    const tc = textContent(el);
    if (tc) field.value = tc;
    if (a.placeholder !== undefined) field.placeholder = a.placeholder;
    if (a.required !== undefined) field.required = true;
    if (a.disabled !== undefined) field.disabled = true;
  } else if (tag === "button") {
    field.type = (a.type ?? "submit").toLowerCase();
    if (a.value !== undefined) field.value = a.value;
    const btnText = textContent(el);
    if (btnText) field.text = btnText;
    if (a.formaction) field.formaction = resolveUrl(a.formaction, effectiveBase);
    if (a.formmethod) field.formmethod = a.formmethod.toUpperCase();
    if (a.disabled !== undefined) field.disabled = true;
  }

  return field;
}

/** Stable field signature — preserves DOM order, includes structural overrides. */
function fieldSignature(field: HtmlFormField): string {
  const parts = [field.tag, field.name ?? "", field.type ?? ""];
  if (field.formaction) parts.push(`fa:${field.formaction}`);
  if (field.formmethod) parts.push(`fm:${field.formmethod}`);
  return parts.join(":");
}

// ---- content range helpers for sourceKind classification ----

interface ContentRange {
  start: number;
  end: number;
  kind: HtmlProvenance["sourceKind"];
}

const SOURCE_KIND_PRIORITY: HtmlProvenance["sourceKind"][] = [
  "comment", "script", "attribute", "html",
];

/**
 * Build non-overlapping source ranges for precise sourceKind classification.
 *
 * Script ranges: only the body between <script> and </script>, not the opening tag.
 * Attribute ranges: opening tags up to >.
 * Comment ranges: full <!-- ... -->
 *
 * This ensures:
 *   <script src="/api/x"> → src attribute → sourceKind "attribute"
 *   <script>fetch("/api/x")</script> → inside body → sourceKind "script"
 */
function collectContentRanges(children: AnyNode[], html: string): ContentRange[] {
  const ranges: ContentRange[] = [];
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (isTag(n) && n.tagName === "script") {
        const si = n2u(n.startIndex);
        const ei = n2u(n.endIndex);
        if (si !== undefined) {
          const openEnd = html.indexOf(">", si);
          if (openEnd > si) {
            ranges.push({ start: si, end: openEnd, kind: "attribute" });
          }
          // Script body range
          if (n.children.length > 0 && ei !== undefined) {
            const bodyStart = openEnd >= 0 ? openEnd + 1 : si;
            const closeStart = html.lastIndexOf("</", ei);
            const bodyEnd = closeStart > bodyStart ? closeStart - 1 : ei;
            if (bodyEnd > bodyStart) {
              ranges.push({ start: bodyStart, end: bodyEnd, kind: "script" });
            }
          }
        }
        if ("children" in n && n.children) walk(n.children);
      } else if (isTag(n) && n.tagName === "style") {
        const si = n2u(n.startIndex);
        if (si !== undefined) {
          const openEnd = html.indexOf(">", si);
          if (openEnd > si) {
            ranges.push({ start: si, end: openEnd, kind: "attribute" });
          }
        }
        if ("children" in n && n.children) walk(n.children);
      } else if (n.type === "comment") {
        const si = n2u(n.startIndex);
        const ei = n2u(n.endIndex);
        if (si !== undefined && ei !== undefined) {
          ranges.push({ start: si, end: ei, kind: "comment" });
        }
      } else if (isTag(n)) {
        const si = n2u(n.startIndex);
        if (si !== undefined) {
          const openEnd = html.indexOf(">", si);
          if (openEnd > si) {
            ranges.push({ start: si, end: openEnd, kind: "attribute" });
          }
        }
        if ("children" in n && n.children) walk(n.children);
      }
    }
  };
  walk(children);
  return ranges;
}

/** Classify by specificity: find all containing ranges, pick highest priority. */
function classifyByRanges(pos: number, ranges: ContentRange[]): HtmlProvenance["sourceKind"] {
  let best: HtmlProvenance["sourceKind"] = "html";
  let bestPriority = SOURCE_KIND_PRIORITY.length;
  for (const r of ranges) {
    if (pos >= r.start && pos <= r.end) {
      const pri = SOURCE_KIND_PRIORITY.indexOf(r.kind);
      if (pri >= 0 && pri < bestPriority) {
        bestPriority = pri;
        best = r.kind;
        if (bestPriority === 0) break;
      }
    }
  }
  return best;
}

// ---- API-like predicate ----

function looksApiLike(
  resolved: string,
  _raw: string,
  contextMethod?: string,
  explicitApiContext?: boolean,
): boolean {
  if (contextMethod) return true;
  if (explicitApiContext) return true;
  if (/\/(?:api|v\d+|graphql|rest|ws|rpc)\//i.test(resolved)) return true;
  if (/\/graphql/i.test(resolved)) return true;
  if (/\/(?:api|v\d+|graphql|rest|ws|rpc)$/i.test(resolved)) return true;
  if (/\.(?:json|xml)(?:\?|$)/i.test(resolved)) return true;
  return false;
}

// ---- main extraction ----

export function extractHtmlStructure(
  html: string,
  sourceUrl: string,
  maxBytes: number,
  evidenceIds: string[],
): HtmlExtractionResult {
  const sourceContentHash = createHash("sha256").update(html).digest("hex");
  const errors: HtmlExtractionError[] = [];
  const effectiveMax = maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const { sliced: input, truncated } = utf8Slice(html, effectiveMax);

  const empty = (): HtmlExtractionResult => ({
    sourceUrl,
    contentHash: sourceContentHash,
    forms: [],
    links: [],
    scripts: [],
    metas: [],
    comments: [],
    apiEndpoints: [],
    errors,
    truncated,
    degraded: false,
  });

  let dom: ReturnType<typeof parseDocument>;
  try {
    dom = parseDocument(input, { withStartIndices: true, withEndIndices: true });
  } catch (err) {
    errors.push({
      code: "PARSE_FAILURE",
      message: `htmlparser2 failed: ${String(err).slice(0, 240)}`,
      severity: "error",
    });
    return { ...empty(), degraded: true, degradationReason: "htmlparser2 parseDocument threw" };
  }

  const children = dom.children;
  if (!children || children.length === 0) return empty();

  const contentRanges = collectContentRanges(children, input);

  // ---- <base href> ----
  const baseEl = DomUtils.findOne(
    (n) => isTag(n) && n.tagName === "base",
    children,
  ) as Element | null;
  const base: HtmlBaseInfo = {};
  if (baseEl?.attribs.href) {
    base.href = baseEl.attribs.href;
    if (baseEl.attribs.target) base.target = baseEl.attribs.target;
  }
  const effectiveBase = base.href ? resolveUrl(base.href, sourceUrl) : sourceUrl;

  // ---- <form> elements ----
  const forms: HtmlFormFinding[] = [];
  const formElements = DomUtils.findAll(
    (n) => isTag(n) && n.tagName === "form",
    children,
  ) as Element[];

  for (const formEl of formElements) {
    try {
      const rawAction = formEl.attribs.action ?? "";
      const method = (formEl.attribs.method ?? "GET").toUpperCase();
      const action = rawAction ? resolveUrl(rawAction, effectiveBase) : effectiveBase;

      const fields: HtmlFormField[] = [];
      const allFieldEls = DomUtils.findAll(
        (n) => isTag(n) && FORM_FIELD_TAGS.has(n.tagName),
        formEl.children,
      ) as Element[];

      for (const fieldEl of allFieldEls) {
        fields.push(
          extractFormField(fieldEl, input, effectiveBase, evidenceIds, sourceUrl, sourceContentHash),
        );
      }

      const fieldSig = fields.map(fieldSignature).filter(Boolean).join(";");
      const sk = formSemanticKey(action, method) + (fieldSig ? `|${fieldSig}` : "");
      const fid = htmlFindingId("form", sk);
      const formSi = n2u(formEl.startIndex) ?? 0;
      const oid = htmlOccurrenceId(fid, sourceContentHash, `action:${formSi}`);

      const formEi = n2u(formEl.endIndex);
      const provExcerpt = sourceSlice(
        input, n2u(formEl.startIndex), formEi,
        `<form action="${rawAction}" method="${method}">`,
      );

      const f: HtmlFormFinding = {
        findingId: fid,
        occurrenceId: oid,
        action,
        method,
        fields,
        provenance: provenance(
          evidenceIds, sourceUrl, sourceContentHash, "html",
          n2u(formEl.startIndex), formEi, provExcerpt,
        ),
      };
      if (formEl.attribs.enctype !== undefined) f.enctype = formEl.attribs.enctype;
      forms.push(f);
    } catch (err) {
      errors.push({
        code: "FORM_EXTRACTION_ERROR",
        message: String(err).slice(0, 200),
        severity: "warning",
      });
    }
  }

  // ---- <a> links ----
  const links: HtmlLinkFinding[] = [];
  const linkElements = DomUtils.findAll(
    (n) => isTag(n) && n.tagName === "a",
    children,
  ) as Element[];

  for (const linkEl of linkElements) {
    try {
      const rawHref = linkEl.attribs.href;
      if (!rawHref) continue;
      const href = resolveUrl(rawHref, effectiveBase);
      const sk = linkSemanticKey(href);
      const fid = htmlFindingId("link", sk);
      const linkSi = n2u(linkEl.startIndex) ?? 0;
      const oid = htmlOccurrenceId(fid, sourceContentHash, `href:${linkSi}`);

      const linkEi = n2u(linkEl.endIndex);
      const provExcerpt = sourceSlice(
        input, n2u(linkEl.startIndex), linkEi,
        `<a href="${rawHref}">`,
      );

      const l: HtmlLinkFinding = {
        findingId: fid,
        occurrenceId: oid,
        href,
        text: excerpt(textContent(linkEl), 200),
        provenance: provenance(
          evidenceIds, sourceUrl, sourceContentHash, "html",
          n2u(linkEl.startIndex), linkEi, provExcerpt,
        ),
      };
      if (linkEl.attribs.rel !== undefined) l.rel = linkEl.attribs.rel;
      if (linkEl.attribs.target !== undefined) l.target = linkEl.attribs.target;
      links.push(l);
    } catch (err) {
      errors.push({
        code: "LINK_EXTRACTION_ERROR",
        message: String(err).slice(0, 200),
        severity: "warning",
      });
    }
  }

  // ---- <script> elements ----
  const scripts: HtmlScriptFinding[] = [];
  const scriptElements = DomUtils.findAll(
    (n) => isTag(n) && n.tagName === "script",
    children,
  ) as Element[];

  for (const scriptEl of scriptElements) {
    try {
      const rawSrc = scriptEl.attribs.src;
      let src: string | undefined;
      let inlineHash: string | undefined;
      let inlineLength: number | undefined;

      if (rawSrc) {
        src = resolveUrl(rawSrc, effectiveBase);
      } else {
        const body = textContent(scriptEl);
        if (body) {
          inlineLength = Buffer.byteLength(body);
          inlineHash = createHash("sha256").update(body).digest("hex");
        }
      }

      const sk = scriptSemanticKey(src, inlineHash);
      const fid = htmlFindingId("script", sk);
      const scriptSi = n2u(scriptEl.startIndex) ?? 0;
      const oid = htmlOccurrenceId(
        fid, sourceContentHash,
        `${src ? "src" : "inline"}:${scriptSi}`,
      );

      const scriptEi = n2u(scriptEl.endIndex);
      const provExcerpt = sourceSlice(
        input, n2u(scriptEl.startIndex), scriptEi,
        rawSrc ? `<script src="${rawSrc}">` : "<script>…</script>",
      );

      const s: HtmlScriptFinding = {
        findingId: fid,
        occurrenceId: oid,
        isModule: scriptEl.attribs.type === "module",
        provenance: provenance(
          evidenceIds, sourceUrl, sourceContentHash, "html",
          n2u(scriptEl.startIndex), scriptEi, provExcerpt,
        ),
      };
      if (src !== undefined) s.src = src;
      if (inlineHash !== undefined) s.inlineHash = inlineHash;
      if (inlineLength !== undefined) s.inlineLength = inlineLength;
      scripts.push(s);
    } catch (err) {
      errors.push({
        code: "SCRIPT_EXTRACTION_ERROR",
        message: String(err).slice(0, 200),
        severity: "warning",
      });
    }
  }

  // ---- <meta> elements ----
  const metas: HtmlMetaFinding[] = [];
  const metaElements = DomUtils.findAll(
    (n) => isTag(n) && n.tagName === "meta",
    children,
  ) as Element[];

  for (const metaEl of metaElements) {
    try {
      const content = metaEl.attribs.content ?? "";
      const httpEquiv = metaEl.attribs["http-equiv"]?.toLowerCase();
      const nameAttr = metaEl.attribs.name?.toLowerCase();

      let kind: HtmlMetaFinding["kind"] = "other";
      if (httpEquiv === "refresh") kind = "refresh";
      else if (nameAttr === "viewport") kind = "viewport";
      else if (httpEquiv === "content-type" || nameAttr === "charset" || metaEl.attribs.charset) kind = "charset";

      let targetUrl: string | undefined;
      const redirectMatch = /(\d+)\s*;\s*url\s*=\s*["']?([^"'\s;>]+)/i.exec(content);
      if (redirectMatch?.[2]) {
        kind = "redirect";
        targetUrl = resolveUrl(redirectMatch[2], effectiveBase);
      } else if (kind === "refresh" && /\d+\s*;\s*url=/i.test(content)) {
        kind = "redirect";
      }

      const key = `meta:${kind}:${content}`;
      const fid = htmlFindingId("meta", key);
      const oid = htmlOccurrenceId(fid, sourceContentHash, `${n2u(metaEl.startIndex) ?? 0}`);

      const metaSi = n2u(metaEl.startIndex);
      const metaEi = n2u(metaEl.endIndex);
      const provExcerpt = sourceSlice(
        input, metaSi, metaEi,
        `<meta${httpEquiv ? ` http-equiv="${httpEquiv}"` : ""} content="${excerpt(content, 80)}">`,
      );

      const m: HtmlMetaFinding = {
        findingId: fid,
        occurrenceId: oid,
        kind,
        content,
        provenance: provenance(
          evidenceIds, sourceUrl, sourceContentHash, "html",
          metaSi, metaEi, provExcerpt,
        ),
      };
      if (metaEl.attribs["http-equiv"] !== undefined) m.httpEquiv = metaEl.attribs["http-equiv"];
      if (metaEl.attribs.name !== undefined) m.name = metaEl.attribs.name;
      if (targetUrl !== undefined) m.targetUrl = targetUrl;
      metas.push(m);
    } catch (err) {
      errors.push({
        code: "META_EXTRACTION_ERROR",
        message: String(err).slice(0, 200),
        severity: "warning",
      });
    }
  }

  // ---- HTML comments ----
  const comments: HtmlCommentFinding[] = [];
  const commentNodes = collectCommentNodes(children);

  for (const c of commentNodes) {
    try {
      const text = (c.data ?? "").trim();
      if (!text) continue;
      const key = `comment:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
      const fid = htmlFindingId("comment", key);
      const oid = htmlOccurrenceId(fid, sourceContentHash, `${n2u(c.startIndex) ?? 0}`);

      const cSi = n2u(c.startIndex);
      const cEi = n2u(c.endIndex);
      const provExcerpt = sourceSlice(
        input, cSi, cEi,
        `<!-- ${excerpt(text, 80)} -->`,
      );

      comments.push({
        findingId: fid,
        occurrenceId: oid,
        text: excerpt(text, 500),
        provenance: provenance(
          evidenceIds, sourceUrl, sourceContentHash, "comment",
          cSi, cEi, provExcerpt,
        ),
      });
    } catch (err) {
      errors.push({
        code: "COMMENT_EXTRACTION_ERROR",
        message: String(err).slice(0, 200),
        severity: "warning",
      });
    }
  }

  // ---- API-like endpoints (regex-based auxiliary extraction) ----
  const apiEndpoints = extractApiEndpoints(
    input, sourceUrl, effectiveBase, evidenceIds, sourceContentHash, contentRanges,
  );

  const result: HtmlExtractionResult = {
    sourceUrl,
    contentHash: sourceContentHash,
    forms,
    links,
    scripts,
    metas,
    comments,
    apiEndpoints,
    errors,
    truncated,
    degraded: false,
  };
  if (base.href) result.base = base;
  return result;
}

// ---- API endpoint extraction (regex-only, auxiliary) ----

interface ApiUrlCapture {
  rawUrl: string;
  /** Code-unit offset of rawUrl within the html string (UTF-16 code units, not bytes). */
  urlStart: number;
  method?: string;
  explicitApiContext?: boolean;
}

interface ApiPattern {
  pattern: RegExp;
  extract: (match: RegExpExecArray, matchIndex: number) => ApiUrlCapture | undefined;
}

// Pattern ordering encodes interpretation priority: earlier patterns provide
// richer observations (method-aware, explicitApiContext) and take precedence
// when multiple patterns match the same physical source span.
const API_PATTERNS: ApiPattern[] = [
  // fetch("URL"), axios.get("URL"), client.get("URL")
  // Group 1 = axios.<method>, group 2 = .<method>, group 3 = URL
  {
    pattern: /\b(?:fetch|axios\.(get|post|put|delete|patch)|\.(get|post|put|delete|patch))\s*\(\s*["']([^"']+)["']/gi,
    extract: (m, matchIdx) => {
      const method = (m[1] ?? m[2])?.toUpperCase();
      const raw = m[3];
      if (!raw) return undefined;
      const start = matchIdx + m[0].indexOf(raw);
      return { rawUrl: raw, urlStart: start, method };
    },
  },
  // apiUrl="/backend", baseURL="https://...", endpoint="/v2/data", graphqlUrl="..."
  {
    pattern: /(?:apiUrl|baseUrl|baseURL|endpoint|graphqlUrl)\s*[=:]\s*["']([^"'\s]{2,300})["']/gi,
    extract: (m, matchIdx) => {
      const raw = m[1];
      if (!raw) return undefined;
      const start = matchIdx + m[0].indexOf(raw);
      return { rawUrl: raw, urlStart: start, explicitApiContext: true };
    },
  },
  // absolute https://host/api/... in text
  {
    pattern: /\b(https?:\/\/[^\s"'<>]{5,300}\/(?:api|v\d+|graphql|rest|ws|rpc)\/[^\s"'<>]*)/gi,
    extract: (m, matchIdx) => {
      const raw = m[1];
      if (!raw) return undefined;
      return { rawUrl: raw, urlStart: matchIdx };
    },
  },
  // quoted "/api/..." or "/v1/..." strings
  {
    pattern: /["'](\/(?:api|v\d+|graphql|rest|ws|rpc)\/[^"'\s]{1,300})["']/gi,
    extract: (m, matchIdx) => {
      const raw = m[1];
      if (!raw) return undefined;
      return { rawUrl: raw, urlStart: matchIdx + 1 };
    },
  },
  // quoted "/graphql" alone
  {
    pattern: /["'](\/graphql)["']/gi,
    extract: (m, matchIdx) => {
      const raw = m[1];
      if (!raw) return undefined;
      return { rawUrl: raw, urlStart: matchIdx + 1 };
    },
  },
];

function extractApiEndpoints(
  html: string,
  sourceUrl: string,
  effectiveBase: string,
  evidenceIds: string[],
  sourceContentHash: string,
  contentRanges: ContentRange[],
): HtmlApiEndpoint[] {
  // Physical-span dedup: key = `${urlStart}:${urlEnd}`.
  // First pattern to match a given span wins (first = richest interpretation,
  // since method-aware patterns precede generic ones in API_PATTERNS order).
  const seenSpans = new Set<string>();
  const results: HtmlApiEndpoint[] = [];

  for (const { pattern, extract } of API_PATTERNS) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(html)) !== null) {
      const capture = extract(match, match.index);
      if (!capture) continue;

      const { rawUrl, urlStart, method, explicitApiContext } = capture;
      const urlEnd = urlStart + rawUrl.length - 1;
      const resolved = resolveUrl(rawUrl, effectiveBase);

      if (!looksApiLike(resolved, rawUrl, method, explicitApiContext)) continue;

      // Physical-span dedup: only one observation per source span
      const spanKey = `${urlStart}:${urlEnd}`;
      if (seenSpans.has(spanKey)) continue;
      seenSpans.add(spanKey);

      // Semantic identity: normalized endpoint + observed method
      const sk = apiEndpointSemanticKey(resolved, method);
      const fid = htmlFindingId("api", sk);
      const oid = htmlOccurrenceId(fid, sourceContentHash, `api:${urlStart}`);

      const sourceKind = classifyByRanges(urlStart, contentRanges);
      const context = html.slice(
        Math.max(0, urlStart - 40),
        Math.min(html.length, urlEnd + 40),
      );

      const ep: HtmlApiEndpoint = {
        findingId: fid,
        occurrenceId: oid,
        url: resolved,
        context: excerpt(context, 150),
        provenance: provenance(
          evidenceIds, sourceUrl, sourceContentHash, sourceKind,
          urlStart, urlEnd, rawUrl,
        ),
      };
      if (method !== undefined) ep.method = method;
      results.push(ep);
    }
  }

  return results;
}

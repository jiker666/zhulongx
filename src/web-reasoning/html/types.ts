/**
 * Structured HTML intelligence types.
 * Two-tier identity: findingId (entity) vs occurrenceId (source observation).
 * Unified provenance: every finding traces back to EvidenceRecord.
 */

/** Unified provenance — every extracted entity must carry this. */
export interface HtmlProvenance {
  evidenceIds: string[];
  sourceUrl?: string;
  contentHash: string;
  sourceKind: "html" | "attribute" | "script" | "comment";
  startOffset?: number;
  endOffset?: number;
  excerpt: string;
}

/** Unified form field — preserves observed form semantics for reasoning and request generation. */
export interface HtmlFormField {
  tag: "input" | "select" | "textarea" | "button";
  name?: string;
  type?: string;
  value?: string;
  values?: string[];
  text?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  multiple?: boolean;
  formaction?: string;
  formmethod?: string;
  provenance: HtmlProvenance;
}

export interface HtmlFormFinding {
  /** sha256("form:" + normalizedSemanticKey) — stable across responses */
  findingId: string;
  /** sha256(findingId + contentHash + sourceLocation) — per-observation */
  occurrenceId: string;
  action: string;
  method: string;
  enctype?: string;
  fields: HtmlFormField[];
  provenance: HtmlProvenance;
}

export interface HtmlLinkFinding {
  findingId: string;
  occurrenceId: string;
  href: string;
  text: string;
  rel?: string;
  target?: string;
  provenance: HtmlProvenance;
}

export interface HtmlScriptFinding {
  findingId: string;
  occurrenceId: string;
  src?: string;
  inlineHash?: string;
  inlineLength?: number;
  isModule: boolean;
  provenance: HtmlProvenance;
}

export interface HtmlMetaFinding {
  findingId: string;
  occurrenceId: string;
  kind: "refresh" | "redirect" | "charset" | "viewport" | "other";
  content: string;
  httpEquiv?: string;
  name?: string;
  /** Resolved redirect target (for meta refresh/redirect), resolved against sourceUrl/base. */
  targetUrl?: string;
  provenance: HtmlProvenance;
}

export interface HtmlCommentFinding {
  findingId: string;
  occurrenceId: string;
  text: string;
  provenance: HtmlProvenance;
}

export interface HtmlApiEndpoint {
  findingId: string;
  occurrenceId: string;
  url: string;
  method?: string;
  context: string;
  provenance: HtmlProvenance;
}

export interface HtmlBaseInfo {
  href?: string;
  target?: string;
}

export interface HtmlExtractionResult {
  sourceUrl: string;
  contentHash: string;
  base?: HtmlBaseInfo;
  forms: HtmlFormFinding[];
  links: HtmlLinkFinding[];
  scripts: HtmlScriptFinding[];
  metas: HtmlMetaFinding[];
  comments: HtmlCommentFinding[];
  apiEndpoints: HtmlApiEndpoint[];
  errors: HtmlExtractionError[];
  truncated: boolean;
  degraded: boolean;
  degradationReason?: string;
}

export interface HtmlExtractionError {
  code: string;
  message: string;
  severity: "warning" | "error";
}

export interface HtmlExtractionSummary {
  sourceUrl: string;
  contentHash: string;
  formCount: number;
  linkCount: number;
  scriptCount: number;
  metaCount: number;
  commentCount: number;
  apiEndpointCount: number;
  errorCount: number;
  createdEvidenceIds: string[];
}

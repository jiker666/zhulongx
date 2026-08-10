export { extractHtmlStructure, resolveUrl } from "./parser.js";
export {
  apiEndpointSemanticKey,
  formSemanticKey,
  htmlFindingId,
  htmlOccurrenceId,
  linkSemanticKey,
  normalizeSemanticUrl,
  scriptSemanticKey,
} from "./identity.js";
export type {
  HtmlApiEndpoint,
  HtmlBaseInfo,
  HtmlCommentFinding,
  HtmlExtractionError,
  HtmlExtractionResult,
  HtmlExtractionSummary,
  HtmlFormField,
  HtmlFormFinding,
  HtmlLinkFinding,
  HtmlMetaFinding,
  HtmlProvenance,
  HtmlScriptFinding,
} from "./types.js";

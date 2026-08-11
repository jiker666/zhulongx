import { parseJavaScript } from "./parser.js";
import { deduplicateJavaScriptResult } from "./deduplicator.js";
import { extractJavaScriptFacts } from "./extractor.js";
import type { JavaScriptAnalysisAdapter, JavaScriptAnalysisInput, JavaScriptAnalysisResult } from "./types.js";

export class StaticJavaScriptAnalyzer implements JavaScriptAnalysisAdapter {
  async analyze(input: JavaScriptAnalysisInput, signal?: AbortSignal): Promise<JavaScriptAnalysisResult> {
    if (signal?.aborted) return { analysisId: `aborted_${input.id}`, inputId: input.id, status: "aborted", language: "unknown", moduleKind: "unknown", networkCalls: [], routes: [], storageFindings: [], sourceMapFindings: [], scriptDependencies: [], configurationReferences: [], diagnostics: [{ code: "aborted", message: "Analysis aborted", severity: "warning" }], statistics: { astNodesVisited: 0, findingsCreated: 0, resolvedNetworkCalls: 0, partialNetworkCalls: 0, unresolvedNetworkCalls: 0, sourceMapMetadataCount: 0 }, createdEvidenceIds: [] };
    if (input.content.length > input.maxBytes) return { analysisId: `limited_${input.id}`, inputId: input.id, status: "size_limited", language: "unknown", moduleKind: "unknown", networkCalls: [], routes: [], storageFindings: [], sourceMapFindings: [], scriptDependencies: [], configurationReferences: [], diagnostics: [{ code: "size_limit", message: "Input exceeds analysis limit", severity: "warning" }], statistics: { astNodesVisited: 0, findingsCreated: 0, resolvedNetworkCalls: 0, partialNetworkCalls: 0, unresolvedNetworkCalls: 0, sourceMapMetadataCount: 0 }, createdEvidenceIds: [] };
    const parsed = parseJavaScript(input, signal); if (!parsed.ast || parsed.status === "failed" || parsed.status === "unsupported") return { analysisId: `failed_${input.id}`, inputId: input.id, status: parsed.status === "unsupported" ? "size_limited" : "failed", language: parsed.language, moduleKind: parsed.moduleKind, networkCalls: [], routes: [], storageFindings: [], sourceMapFindings: [], scriptDependencies: [], configurationReferences: [], diagnostics: parsed.diagnostics, statistics: { astNodesVisited: 0, findingsCreated: 0, resolvedNetworkCalls: 0, partialNetworkCalls: 0, unresolvedNetworkCalls: 0, sourceMapMetadataCount: 0 }, createdEvidenceIds: [] };
    const result = extractJavaScriptFacts(input, parsed.ast as import("typescript").SourceFile, parsed.status === "partially_parsed" ? "partial" : "completed"); result.language = parsed.language; result.moduleKind = parsed.moduleKind; result.diagnostics = parsed.diagnostics; return deduplicateJavaScriptResult(result);
  }
}

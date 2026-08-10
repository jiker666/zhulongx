import ts from "typescript";
import type { JavaScriptAnalysisInput, JavaScriptDiagnostic, JavaScriptParseResult, SourceLocation } from "./types.js";

function location(source: ts.SourceFile, position: number): SourceLocation { const line = source.getLineAndCharacterOfPosition(Math.max(0, position)); return { line: line.line + 1, column: line.character + 1, offset: position }; }
function language(input: JavaScriptAnalysisInput): JavaScriptParseResult["language"] { if (/tsx|jsx/i.test(input.mediaType ?? "") || /\.tsx$/i.test(input.sourceUrl ?? "")) return "tsx"; if (/jsx/i.test(input.mediaType ?? "") || /\.jsx$/i.test(input.sourceUrl ?? "")) return "jsx"; if (/typescript|\.tsx?$/.test(`${input.mediaType ?? ""}${input.sourceUrl ?? ""}`)) return "typescript"; return "javascript"; }
export function parseJavaScript(input: JavaScriptAnalysisInput, signal?: AbortSignal): JavaScriptParseResult {
  if (input.content.length > input.maxBytes) return { status: "unsupported", language: language(input), moduleKind: "unknown", diagnostics: [{ code: "size_limit", message: "JavaScript input exceeds configured size limit", severity: "warning" }] };
  if (signal?.aborted) return { status: "failed", language: language(input), moduleKind: "unknown", diagnostics: [{ code: "aborted", message: "JavaScript parsing aborted", severity: "warning" }] };
  const lang = language(input); const scriptKind = lang === "typescript" || lang === "tsx" ? ts.ScriptKind.TSX : lang === "jsx" ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(input.sourceUrl ?? input.id, input.content, ts.ScriptTarget.Latest, true, scriptKind); const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []; const diagnostics: JavaScriptDiagnostic[] = parseDiagnostics.slice(0, 20).map((item) => ({ code: String(item.code), message: ts.flattenDiagnosticMessageText(item.messageText, " ").slice(0, 300), severity: item.category === ts.DiagnosticCategory.Error ? "error" : "warning", ...(item.start === undefined ? {} : { location: location(source, item.start) }) }));
  const moduleKind = source.statements.some((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) ? "esm" : /\brequire\s*\(/.test(input.content) ? "commonjs" : "script";
  return { status: diagnostics.some((item) => item.severity === "error") ? "partially_parsed" : "parsed", language: lang, moduleKind, ast: source, diagnostics };
}
export function sourceLocation(source: ts.SourceFile, node: ts.Node): SourceLocation { return location(source, node.getStart(source)); }

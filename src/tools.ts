import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, open, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { AuditChain } from "./audit.js";
import { extractZipArchive, searchArtifact } from "./artifact-tools.js";
import { SandboxExecutor, type Executor } from "./executor.js";
import { adaptExternalTool, type ExternalToolRegistration } from "./external-tools.js";
import { hostMatches, isPathInside, resolveWorkspacePath } from "./policy.js";
import type { PublishSharedEvidenceInput, SharedEvidenceBoard, SharedEvidenceKind } from "./shared-evidence.js";
import { searchWebKnowledge } from "./agents/web/web-knowledge.js";
import { ControlledBrowserRuntime } from "./web-reasoning/browser/runtime.js";
import type { BrowserRuntimeConfig, BrowserToolInput } from "./web-reasoning/browser/types.js";
import type {
  ExperienceLesson,
  FailureClassification,
  Finding,
  HypothesisRecord,
  RunPlan,
  RunState,
  RuntimeConfig,
  ScopeConfig,
  StrategyRevision,
  ToolShape,
} from "./types.js";

interface CheckpointInput {
  observations: string[];
  assessment: string;
  planChanges: string[];
  nextAction: string;
  failureClassification?: "none" | FailureClassification;
  nextActionRationale?: string;
  hypotheses?: Array<{
    hypothesis: string;
    status: "open" | "supported" | "contradicted" | "confirmed";
    evidence: string[];
  }>;
}

interface ListFilesInput {
  path?: string;
  depth?: number;
}

interface ReadFileInput {
  path: string;
  offset?: number;
  length?: number;
}

interface InspectArtifactInput {
  source?: "workspace" | "scratch";
  path: string;
  maxStrings?: number;
}

interface ExtractArchiveInput {
  source?: "workspace" | "scratch";
  path: string;
  destination: string;
  maxEntries?: number;
  maxBytes?: number;
}

interface SearchArtifactInput {
  source?: "workspace" | "scratch";
  path: string;
  pattern: string;
  encoding?: "utf8" | "hex";
  maxMatches?: number;
  contextBytes?: number;
}

interface ObserveImageInput {
  source?: "workspace" | "scratch";
  path: string;
}

interface RunCommandInput {
  program: string;
  args: string[];
  cwd?: "scratch" | "workspace";
  stdin?: string;
  stdinEncoding?: "utf8" | "base64";
  timeoutMs?: number;
}

const MAX_COMMAND_OUTPUT_CHARS = 24_000;
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

function boundedCommandOutput(value: string): string {
  const clean = value.replace(ANSI_ESCAPE, "");
  if (clean.length <= MAX_COMMAND_OUTPUT_CHARS) return clean;
  const head = Math.floor(MAX_COMMAND_OUTPUT_CHARS * 0.72);
  const tail = MAX_COMMAND_OUTPUT_CHARS - head - 64;
  return `${clean.slice(0, head)}\n...[command output bounded; use offset-based reads or narrower disassembly]...\n${clean.slice(-Math.max(0, tail))}`;
}

interface HttpRequestInput {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: "utf8" | "base64";
  responseEncoding?: "auto" | "utf8" | "base64";
  sessionId?: string;
  followRedirects?: boolean;
  form?: Record<string, string>;
  multipart?: Record<string, string>;
  replayOf?: string;
  compareTo?: string;
}

interface HttpSessionMemory {
  cookies: Map<string, string>;
}

interface HttpReplayMemory {
  method: HttpRequestInput["method"];
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

interface HttpResponseMemory {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodySha256: string;
  bytes: number;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = /^(authorization|cookie|set-cookie|proxy-authorization)$/i.test(key) ? "[redacted]" : value.slice(0, 1000);
  });
  return result;
}

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  return extended.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
}

function cookieNames(headers: Headers): string[] {
  return setCookieHeaders(headers).flatMap((value) => value.split(/,(?=[^;,]+=)/)).map((value) => value.split("=", 1)[0]?.trim() ?? "").filter(Boolean);
}

interface WebBaselineInput {
  url: string;
  includeBody?: boolean;
}

interface WebKnowledgeInput {
  query: string;
  limit?: number;
}

interface WebCompareInput {
  baseline: string;
  candidate: string;
}

interface WebTimingInput { samples: number[]; baselineSamples?: number[] }

interface ScratchWriteInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  append?: boolean;
}

interface TcpOpenInput {
  host: string;
  port: number;
  timeoutMs?: number;
}

interface TcpSendInput {
  sessionId: string;
  data: string;
  encoding?: "utf8" | "base64";
  newline?: boolean;
}

interface TcpReceiveInput {
  sessionId: string;
  length?: number;
  timeoutMs?: number;
  encoding?: "utf8" | "base64";
}

interface TcpCloseInput {
  sessionId: string;
}

interface ReadSharedEvidenceInput {
  limit?: number;
  kinds?: SharedEvidenceKind[];
}

interface PublishSharedEvidenceToolInput extends PublishSharedEvidenceInput {}

type FindingInput = Omit<Finding, "id">;
type ExperienceLessonInput = Omit<ExperienceLesson, "id">;

interface FinishTaskInput {
  status: "completed" | "blocked";
  summary: string;
  submission?: string;
  evidence: string[];
  remainingRisks: string[];
  nextSteps: string[];
  confidence: number;
  verification: string[];
  independentlyVerified: boolean;
}

interface ToolContext {
  state: RunState;
  scope: ScopeConfig;
  runtime: RuntimeConfig;
  audit: AuditChain;
  sandboxNamespace?: string;
  sharedEvidence?: SharedEvidenceBoard;
  browser?: Partial<BrowserRuntimeConfig>;
  executor?: Executor;
  externalTools?: ExternalToolRegistration[];
}

export interface ToolSet {
  tools: ToolShape[];
  cleanup: () => Promise<void>;
}

interface TcpSession {
  id: string;
  host: string;
  port: number;
  socket: Socket;
  chunks: Buffer[];
  bufferedBytes: number;
  receivedBytes: number;
  sentBytes: number;
  closed: boolean;
  lastError?: string;
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

async function listFiles(root: string, input: string, depth: number): Promise<string[]> {
  const start = await resolveExistingWorkspacePath(root, input);
  const stats = await lstat(start);
  if (!stats.isDirectory()) return [relative(root, start)];
  const results: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }];
  while (queue.length > 0 && results.length < 500) {
    const current = queue.shift();
    if (!current) break;
    for await (const item of await opendir(current.path)) {
      const absolute = resolve(current.path, item.name);
      results.push(relative(root, absolute) + (item.isDirectory() ? "/" : ""));
      if (item.isDirectory() && current.depth < depth) queue.push({ path: absolute, depth: current.depth + 1 });
      if (results.length >= 500) break;
    }
  }
  return results;
}

async function resolveExistingWorkspacePath(root: string, input: string): Promise<string> {
  const lexicalPath = resolveWorkspacePath(root, input);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(lexicalPath)]);
  if (!isPathInside(realRoot, realCandidate)) throw new Error(`Resolved path escapes workspace: ${input}`);
  return realCandidate;
}

async function resolveScratchPath(root: string, input: string): Promise<string> {
  const lexicalPath = resolveWorkspacePath(root, input);
  const realRoot = await realpath(root);
  if (!isPathInside(realRoot, lexicalPath)) throw new Error(`Scratch path escapes root: ${input}`);
  return lexicalPath;
}

async function readBoundedFile(
  root: string,
  inputPath: string,
  offset: number,
  length: number,
  maxOutputBytes: number,
): Promise<{
  path: string;
  output: string;
  encoding: "utf8" | "base64";
  display: string;
  preview?: { format: "hex+ascii"; lines: string[]; bytes: number };
  offset: number;
  bytes: number;
  truncated: boolean;
}> {
  const path = await resolveExistingWorkspacePath(root, inputPath);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Path is not a regular file");
  const cappedLength = Math.min(length, maxOutputBytes);
  const handle = await open(path, "r");
  let data: Buffer;
  try {
    const buffer = Buffer.alloc(cappedLength);
    const { bytesRead } = await handle.read(buffer, 0, cappedLength, offset);
    data = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const binary = data.includes(0);
  const preview = binary ? makeHexPreview(data, offset) : undefined;
  const display = binary
    ? [
        `binary preview offset=${offset} bytes=${data.length} truncated=${offset + data.length < stats.size}`,
        preview?.lines.join("\n") ?? "",
        `base64 (bounded): ${data.toString("base64").slice(0, 4096)}${data.length > 3072 ? "..." : ""}`,
      ].filter(Boolean).join("\n")
    : data.toString("utf8");
  return {
    path: relative(root, path),
    output: binary ? data.toString("base64") : data.toString("utf8"),
    encoding: binary ? "base64" : "utf8",
    display,
    ...(preview ? { preview } : {}),
    offset,
    bytes: data.length,
    truncated: offset + data.length < stats.size,
  };
}

function makeHexPreview(data: Buffer, offset: number, maxBytes = 1024): { format: "hex+ascii"; lines: string[]; bytes: number } {
  const sample = data.subarray(0, Math.min(data.length, maxBytes));
  const lines: string[] = [];
  for (let index = 0; index < sample.length; index += 16) {
    const row = sample.subarray(index, index + 16);
    const hex = Array.from(row, (value) => value.toString(16).padStart(2, "0"));
    const padded = [...hex, ...Array.from({ length: 16 - hex.length }, () => "  ")];
    const ascii = Array.from(row, (value) => value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".").join("");
    lines.push(`${(offset + index).toString(16).padStart(8, "0")}  ${padded.slice(0, 8).join(" ")}  ${padded.slice(8).join(" ")}  |${ascii.padEnd(16, " ")}|`);
  }
  return { format: "hex+ascii", lines, bytes: sample.length };
}

const MAX_ARTIFACT_INSPECTION_BYTES = 8 * 1024 * 1024;

function identifyMagic(bytes: Buffer): string {
  const ascii = (offset: number, value: string) => bytes.subarray(offset, offset + value.length).toString("latin1") === value;
  if (ascii(0, "\u007fELF")) return "elf";
  if (ascii(0, "MZ")) return "pe-or-dos";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "gif";
  if (ascii(0, "%PDF-")) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1)) return "zip";
  if (bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "7z";
  if (ascii(0, "Rar!\u001a\u0007")) return "rar";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (ascii(0, "SQLite format 3\u0000")) return "sqlite3";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) return "wasm";
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0xd4, 0xc3, 0xb2, 0xa1])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0xa1, 0xb2, 0xc3, 0xd4])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x0a, 0x0d, 0x0d, 0x0a]))
  ) return "pcap-or-pcapng";
  return "unknown";
}

const PE_MACHINE_NAMES: Record<number, string> = {
  0x014c: "i386",
  0x014d: "i860",
  0x0166: "mips",
  0x01c0: "arm",
  0x01c4: "armv7",
  0x01c2: "thumb",
  0x0200: "ia64",
  0x8664: "x86_64",
  0xaa64: "arm64",
};

function readUInt32(bytes: Buffer, offset: number): number | undefined {
  return offset >= 0 && offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : undefined;
}

function readUInt16(bytes: Buffer, offset: number): number | undefined {
  return offset >= 0 && offset + 2 <= bytes.length ? bytes.readUInt16LE(offset) : undefined;
}

function readUInt64Hex(bytes: Buffer, offset: number): string | undefined {
  if (offset < 0 || offset + 8 > bytes.length) return undefined;
  return `0x${bytes.readBigUInt64LE(offset).toString(16)}`;
}

function peString(bytes: Buffer, offset: number, length: number): string {
  return bytes.subarray(offset, Math.min(bytes.length, offset + length)).toString("ascii").replace(/\0.*$/, "");
}

/** Parse bounded PE headers without executing or relying on an external toolchain. */
export function parsePeHeaders(bytes: Buffer): Record<string, unknown> | undefined {
  if (bytes.length < 2 || bytes.subarray(0, 2).toString("ascii") !== "MZ") return undefined;
  const peOffset = readUInt32(bytes, 0x3c);
  if (peOffset === undefined || peOffset < 0x40 || peOffset + 24 > bytes.length) {
    return { format: "dos", peHeaderOffset: peOffset ?? null, validPeSignature: false };
  }
  const signature = bytes.subarray(peOffset, peOffset + 4).toString("ascii");
  if (signature !== "PE\0\0") {
    return { format: "dos", peHeaderOffset: peOffset, validPeSignature: false };
  }
  const coff = peOffset + 4;
  const machine = readUInt16(bytes, coff);
  const sectionCount = readUInt16(bytes, coff + 2);
  const optionalSize = readUInt16(bytes, coff + 16);
  const optionalOffset = coff + 20;
  if (machine === undefined || sectionCount === undefined || optionalSize === undefined || optionalOffset + optionalSize > bytes.length) {
    return { format: "pe", peHeaderOffset: peOffset, validPeSignature: true, truncatedHeaders: true };
  }
  const optionalMagic = readUInt16(bytes, optionalOffset);
  const pe32Plus = optionalMagic === 0x20b;
  const entryPointRva = readUInt32(bytes, optionalOffset + 16);
  const sectionAlignment = readUInt32(bytes, optionalOffset + 32);
  const fileAlignment = readUInt32(bytes, optionalOffset + 36);
  const sizeOfImage = readUInt32(bytes, optionalOffset + 56);
  const sizeOfHeaders = readUInt32(bytes, optionalOffset + 60);
  const subsystem = readUInt16(bytes, optionalOffset + 68);
  const imageBase = pe32Plus ? readUInt64Hex(bytes, optionalOffset + 24) : readUInt32(bytes, optionalOffset + 28);
  const directoryCountOffset = optionalOffset + (pe32Plus ? 108 : 92);
  const directoryOffset = optionalOffset + (pe32Plus ? 112 : 96);
  const directoryCount = readUInt32(bytes, directoryCountOffset) ?? 0;
  const directoryNames = ["export", "import", "resource", "exception", "certificate", "base-reloc", "debug", "architecture", "global-ptr", "tls", "load-config", "bound-import", "iat", "delay-import", "com-descriptor"];
  const directories: Record<string, { rva: number; size: number }>[] = [];
  for (let index = 0; index < Math.min(directoryCount, directoryNames.length, 16); index += 1) {
    const rva = readUInt32(bytes, directoryOffset + index * 8);
    const size = readUInt32(bytes, directoryOffset + index * 8 + 4);
    if (rva === undefined || size === undefined || (rva === 0 && size === 0)) continue;
    directories.push({ [directoryNames[index] ?? `directory-${index}`]: { rva, size } });
  }
  const sectionTableOffset = optionalOffset + optionalSize;
  const sections: Array<Record<string, unknown>> = [];
  for (let index = 0; index < Math.min(sectionCount, 96); index += 1) {
    const offset = sectionTableOffset + index * 40;
    if (offset + 40 > bytes.length) break;
    const virtualSize = readUInt32(bytes, offset + 8);
    const virtualAddress = readUInt32(bytes, offset + 12);
    const rawSize = readUInt32(bytes, offset + 16);
    const rawPointer = readUInt32(bytes, offset + 20);
    const characteristics = readUInt32(bytes, offset + 36);
    if ([virtualSize, virtualAddress, rawSize, rawPointer, characteristics].some((value) => value === undefined)) break;
    sections.push({
      name: peString(bytes, offset, 8),
      virtualSize,
      virtualAddress,
      rawSize,
      rawPointer,
      characteristics: `0x${characteristics!.toString(16)}`,
      rawEnd: rawPointer! + rawSize!,
    });
  }
  let entryPointFileOffset: number | undefined;
  if (entryPointRva !== undefined) {
    if (entryPointRva < (sizeOfHeaders ?? 0)) {
      entryPointFileOffset = entryPointRva;
    } else {
      const section = sections.find((item) => {
        const start = Number(item.virtualAddress);
        const span = Math.max(Number(item.virtualSize), Number(item.rawSize));
        return entryPointRva >= start && entryPointRva < start + span;
      });
      if (section) entryPointFileOffset = Number(section.rawPointer) + (entryPointRva - Number(section.virtualAddress));
    }
  }
  return {
    format: "pe",
    peHeaderOffset: peOffset,
    validPeSignature: true,
    architecture: optionalMagic === 0x10b ? "PE32" : optionalMagic === 0x20b ? "PE32+" : `optional-magic-0x${(optionalMagic ?? 0).toString(16)}`,
    machine: machine === undefined ? null : `0x${machine.toString(16)}`,
    machineName: machine === undefined ? "unknown" : PE_MACHINE_NAMES[machine] ?? "unknown",
    numberOfSections: sectionCount,
    timestamp: readUInt32(bytes, coff + 4),
    characteristics: `0x${(readUInt16(bytes, coff + 18) ?? 0).toString(16)}`,
    optionalHeaderSize: optionalSize,
    imageBase: imageBase === undefined ? null : typeof imageBase === "number" ? `0x${imageBase.toString(16)}` : imageBase,
    entryPointRva: entryPointRva === undefined ? null : `0x${entryPointRva.toString(16)}`,
    entryPointFileOffset: entryPointFileOffset === undefined ? null : entryPointFileOffset,
    sectionAlignment,
    fileAlignment,
    sizeOfImage,
    sizeOfHeaders,
    subsystem,
    dataDirectories: Object.assign({}, ...directories),
    sections,
    truncatedHeaders: sections.length !== Math.min(sectionCount, 96),
  };
}

function shannonEntropy(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] = (counts[byte] ?? 0) + 1;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / bytes.length;
    entropy -= probability * Math.log2(probability);
  }
  return Number(entropy.toFixed(4));
}

function extractPrintableStrings(bytes: Buffer, limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  let current: number[] = [];
  const flush = () => {
    if (current.length >= 4) {
      const value = Buffer.from(current).toString("ascii").slice(0, 300);
      if (!seen.has(value)) {
        seen.add(value);
        output.push(value);
      }
    }
    current = [];
  };
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) current.push(byte);
    else flush();
    if (output.length >= limit) break;
  }
  if (output.length < limit) flush();
  return output.slice(0, limit);
}

async function inspectArtifactFile(
  root: string,
  inputPath: string,
  source: "workspace" | "scratch",
  maxStrings: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const path = await resolveExistingWorkspacePath(root, inputPath);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Artifact path is not a regular file");
  const inspectionBytes = Math.min(stats.size, MAX_ARTIFACT_INSPECTION_BYTES);
  const buffer = Buffer.alloc(inspectionBytes);
  const handle = await open(path, "r");
  let offset = 0;
  try {
    while (offset < inspectionBytes) {
      if (signal?.aborted) throw signal.reason ?? new Error("Artifact inspection aborted");
      const { bytesRead } = await handle.read(buffer, offset, inspectionBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const bytes = buffer.subarray(0, offset);
  const entropySample = bytes.subarray(0, Math.min(bytes.length, 65536));
  let printable = 0;
  for (const byte of entropySample) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte <= 0x7e)) printable += 1;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const hashComplete = offset === stats.size;
  const pe = parsePeHeaders(bytes);
  return {
    source,
    path: relative(root, path),
    size: stats.size,
    inspectedBytes: offset,
    truncated: !hashComplete,
    magic: identifyMagic(bytes),
    entropy: shannonEntropy(entropySample),
    printableRatio: entropySample.length === 0 ? 0 : Number((printable / entropySample.length).toFixed(4)),
    ...(hashComplete ? { sha256: hash } : { inspectedPrefixSha256: hash }),
    hashComplete,
    ...(pe ? { pe } : {}),
    strings: extractPrintableStrings(bytes, maxStrings),
  };
}

function supportedImageMimeType(bytes: Buffer): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

async function observeImageFile(
  root: string,
  inputPath: string,
  source: "workspace" | "scratch",
  maxImageBytes: number,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: Record<string, unknown> }> {
  signal?.throwIfAborted();
  const path = await resolveExistingWorkspacePath(root, inputPath);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Image path is not a regular file");
  if (stats.size > maxImageBytes) throw new Error(`Image exceeds the ${maxImageBytes}-byte observation limit`);
  const bytes = Buffer.from(await readFile(path, { signal }));
  signal?.throwIfAborted();
  const mimeType = supportedImageMimeType(bytes);
  if (!mimeType) throw new Error("Unsupported image format; expected JPEG, PNG, GIF, or WebP");
  const details = {
    source,
    path: relative(root, path),
    size: bytes.length,
    mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return {
    content: [
      { type: "text", text: `Observed bounded image ${source}:${details.path} (${mimeType}, ${bytes.length} bytes, sha256=${details.sha256})` },
      { type: "image", data: bytes.toString("base64"), mimeType },
    ],
    details,
  };
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value.subarray(0, remaining));
    total += Math.min(value.length, remaining);
    if (value.length > remaining) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function renderBytes(bytes: Uint8Array, encoding: "auto" | "utf8" | "base64" = "auto") {
  const binary = bytes.includes(0);
  const finalEncoding = encoding === "auto" ? (binary ? "base64" : "utf8") : encoding;
  const buffer = Buffer.from(bytes);
  return {
    text: finalEncoding === "base64" ? buffer.toString("base64") : new TextDecoder().decode(bytes),
    encoding: finalEncoding,
  };
}

function decodeToolData(value: string, encoding: "utf8" | "base64" = "utf8"): Buffer {
  return encoding === "base64" ? Buffer.from(value, "base64") : Buffer.from(value, "utf8");
}

async function connectTcp(input: TcpOpenInput, signal?: AbortSignal): Promise<Socket> {
  return await new Promise<Socket>((resolveSocket, reject) => {
    const socket = createConnection({ host: input.host, port: input.port });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("TCP connect timed out"));
    }, input.timeoutMs ?? 5000);
    const abort = () => socket.destroy(new Error("TCP connect aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.setNoDelay(true);
      resolveSocket(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function drainTcp(session: TcpSession, length: number): Buffer {
  const output: Buffer[] = [];
  let remaining = length;
  while (remaining > 0 && session.chunks.length > 0) {
    const chunk = session.chunks[0];
    if (!chunk) break;
    if (chunk.length <= remaining) {
      output.push(chunk);
      session.chunks.shift();
      session.bufferedBytes -= chunk.length;
      remaining -= chunk.length;
    } else {
      output.push(chunk.subarray(0, remaining));
      session.chunks[0] = chunk.subarray(remaining);
      session.bufferedBytes -= remaining;
      remaining = 0;
    }
  }
  return Buffer.concat(output);
}

async function receiveTcp(session: TcpSession, length: number, timeoutMs: number): Promise<Buffer> {
  if (session.bufferedBytes > 0 || session.closed) return drainTcp(session, length);
  return await new Promise<Buffer>((resolveReceive) => {
    const timer = setTimeout(() => {
      cleanup();
      resolveReceive(Buffer.alloc(0));
    }, timeoutMs);
    const onData = () => {
      cleanup();
      resolveReceive(drainTcp(session, length));
    };
    const onClose = () => {
      cleanup();
      resolveReceive(drainTcp(session, length));
    };
    const cleanup = () => {
      clearTimeout(timer);
      session.socket.off("data", onData);
      session.socket.off("close", onClose);
      session.socket.off("error", onClose);
    };
    session.socket.once("data", onData);
    session.socket.once("close", onClose);
    session.socket.once("error", onClose);
  });
}

export function createToolSet(context: ToolContext): ToolSet {
  const { state, scope, runtime, audit, sandboxNamespace, sharedEvidence, browser } = context;
  const executor = context.executor ?? new SandboxExecutor({
    id: `sandbox:${state.id}`,
    socketPath: runtime.sandbox.socketPath,
    connectTimeoutMs: runtime.sandbox.connectTimeoutMs,
    workspaceRoot: scope.workspaceRoot,
    scratchRoot: runtime.scratchRoot,
  });
  const externalTools = (context.externalTools ?? []).map((registration) => adaptExternalTool(registration, runtime.maxOutputBytes));
  const tcpSessions = new Map<string, TcpSession>();
  const httpSessions = new Map<string, HttpSessionMemory>();
  const httpReplays = new Map<string, HttpReplayMemory>();
  const httpResponses = new Map<string, HttpResponseMemory>();
  const browserRuntime = state.webReasoning?.browser ? new ControlledBrowserRuntime({ runId: state.id, scope, state: state.webReasoning.browser, ...(browser ? { config: browser } : {}) }) : undefined;
  if (browserRuntime) void audit.append(browserRuntime.capability.available ? "BROWSER_CAPABILITY_DETECTED" : "BROWSER_CAPABILITY_UNAVAILABLE", { provider: browserRuntime.capability.provider, browserType: browserRuntime.capability.browserType, reason: browserRuntime.capability.reason });

  const closeTcpSession = async (id: string): Promise<boolean> => {
    const session = tcpSessions.get(id);
    if (!session) return false;
    session.closed = true;
    session.socket.destroy();
    tcpSessions.delete(id);
    return true;
  };

  const cleanup = async () => {
    await Promise.all([...tcpSessions.keys()].map((id) => closeTcpSession(id)));
    await browserRuntime?.cleanup();
    httpSessions.clear();
    httpReplays.clear();
    httpResponses.clear();
    await executor.dispose();
  };

  const tools: ToolShape[] = [
    {
      name: "browser",
      label: "Controlled browser",
      description: "Perform one registered, scope-checked browser action. Use the exact action names: create_session, open_page, navigate, reload, go_back, capture_dom, capture_network_summary, assert_state, click, fill, select, check, uncheck, submit_form, wait_for, capture_screenshot, close_page, close_session. Browser results are bounded and persisted as structured evidence.",
      parameters: Type.Object({
        action: Type.String(),
        sessionId: Type.Optional(Type.String()),
        pageId: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        target: Type.Optional(Type.Unknown()),
        value: Type.Optional(Type.String()),
        expectedText: Type.Optional(Type.String({ maxLength: 2000 })),
        expectedUrl: Type.Optional(Type.String({ maxLength: 500 })),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal) {
        if (!browserRuntime) throw new Error("Browser runtime is unavailable for this run");
        try {
          const result = await browserRuntime.execute(params as BrowserToolInput, signal);
          await audit.append("BROWSER_ACTION_COMPLETED", { action: (params as { action?: unknown }).action, details: result.details });
          return textResult(result.content, result.details);
        } catch (error) {
          await audit.append("BROWSER_ACTION_FAILED", { action: (params as { action?: unknown }).action, failureSummary: String(error).slice(0, 240) });
          throw error;
        }
      },
    },
    {
      name: "submit_plan",
      label: "Submit plan",
      description: "Submit an evidence-driven execution plan before investigative actions.",
      parameters: Type.Object({
        goal: Type.String({ minLength: 1 }),
        assumptions: Type.Array(Type.String()),
        hypotheses: Type.Array(Type.String()),
        steps: Type.Array(
          Type.Object({
            id: Type.String({ minLength: 1 }),
            objective: Type.String({ minLength: 1 }),
            successCriteria: Type.Array(Type.String()),
            tools: Type.Array(Type.String()),
          }),
          { minItems: 1 },
        ),
      }),
      async execute(_id, params, signal) {
        const input = params as RunPlan;
        state.plan = input;
        const now = new Date().toISOString();
        state.hypotheses = input.hypotheses.map((statement, index) => ({
          id: `H${index + 1}`,
          statement,
          status: "open",
          evidence: [],
          updatedAt: now,
        }));
        state.phase = "exploration";
        await audit.append("plan.submitted", { ...input, hypothesisLedger: state.hypotheses });
        return textResult(`Plan accepted with ${input.steps.length} steps and ${state.hypotheses.length} hypotheses.`, {
          ...input,
          hypothesisLedger: state.hypotheses,
        });
      },
    },
    {
      name: "checkpoint",
      label: "Decision checkpoint",
      description: "Record observations, contradictions, strategy changes, and the next action.",
      parameters: Type.Object({
        observations: Type.Array(Type.String(), { minItems: 1 }),
        assessment: Type.String({ minLength: 1 }),
        planChanges: Type.Array(Type.String()),
        nextAction: Type.String({ minLength: 1 }),
        failureClassification: Type.Optional(Type.Union([
          Type.Literal("none"),
          Type.Literal("tool"),
          Type.Literal("policy"),
          Type.Literal("evidence"),
          Type.Literal("assumption"),
          Type.Literal("scope"),
          Type.Literal("infrastructure"),
        ])),
        nextActionRationale: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        hypotheses: Type.Optional(Type.Array(Type.Object({
          hypothesis: Type.String({ minLength: 1, maxLength: 500 }),
          status: Type.Union([
            Type.Literal("open"),
            Type.Literal("supported"),
            Type.Literal("contradicted"),
            Type.Literal("confirmed"),
          ]),
          evidence: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 10 }),
        }), { maxItems: 12 })),
      }),
      async execute(_id, params) {
        const input = params as CheckpointInput;
        const now = new Date().toISOString();
        for (const update of input.hypotheses ?? []) {
          let record = state.hypotheses.find((item) => item.statement === update.hypothesis);
          if (!record) {
            record = {
              id: `H${state.hypotheses.length + 1}`,
              statement: update.hypothesis,
              status: update.status,
              evidence: [...update.evidence],
              updatedAt: now,
            } satisfies HypothesisRecord;
            state.hypotheses.push(record);
          } else {
            record.status = update.status;
            record.evidence = [...new Set([...record.evidence, ...update.evidence])].slice(0, 20);
            record.updatedAt = now;
          }
        }
        const resolvedFailure = state.lastFailure;
        const failureClassification = input.failureClassification && input.failureClassification !== "none"
          ? input.failureClassification
          : resolvedFailure?.classification;
        let strategyRevision: StrategyRevision | undefined;
        if (failureClassification && input.planChanges.length > 0) {
          strategyRevision = {
            id: randomUUID(),
            classification: failureClassification,
            planChanges: [...input.planChanges],
            nextAction: input.nextAction,
            rationale: input.nextActionRationale ?? input.assessment,
            createdAt: now,
          };
          state.strategyRevisions.push(strategyRevision);
        }
        state.strategyRevisionRequired = false;
        delete state.lastFailure;
        state.lastCheckpoint = {
          observations: input.observations.slice(0, 12),
          assessment: input.assessment,
          nextAction: input.nextAction,
          updatedAt: now,
        };
        // A checkpoint records a concrete strategy change. Let the revised
        // strategy revisit an action whose previous signature was exhausted,
        // while keeping the repeated-action guard active within each strategy.
        state.repeatedActions = {};
        state.phase = "analysis";
        const checkpoint = {
          ...input,
          hypothesisLedger: state.hypotheses,
          ...(strategyRevision ? { strategyRevision } : {}),
          ...(resolvedFailure ? { resolvedFailure } : {}),
        };
        await audit.append("decision.checkpoint", checkpoint);
        if ((input.hypotheses?.length ?? 0) > 0) {
          await audit.append("hypothesis.updated", {
            updates: input.hypotheses,
            ledger: state.hypotheses,
          });
        }
        if (sharedEvidence) {
          for (const update of input.hypotheses ?? []) {
            if (update.evidence.length === 0 || update.status === "open") continue;
            const published = sharedEvidence.publish(state.id, {
              kind: update.status === "contradicted" ? "dead-end" : update.status === "confirmed" ? "fact" : "candidate",
              claim: update.hypothesis,
              evidence: update.evidence,
              confidence: update.status === "confirmed" ? 0.9 : update.status === "supported" ? 0.7 : 0.8,
            });
            await audit.append("collaboration.evidence_published", {
              entry: published.entry,
              deduplicated: published.deduplicated,
              evicted: published.evicted,
              source: "checkpoint",
            });
          }
        }
        if (strategyRevision) {
          await audit.append("strategy.revised", {
            revision: strategyRevision,
            ...(resolvedFailure ? { resolvedFailure } : {}),
          });
        }
        return textResult("Checkpoint recorded; action counter reset and the hypothesis ledger was updated.", checkpoint);
      },
    },
    ...(sharedEvidence ? [
      {
        name: "read_shared_evidence",
        label: "Read shared evidence",
        description:
          "Read a bounded same-task race board of teammate facts, candidates, and dead ends. Shared entries are hints and must be independently verified.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, default: 24 })),
          kinds: Type.Optional(Type.Array(Type.Union([
            Type.Literal("fact"),
            Type.Literal("candidate"),
            Type.Literal("dead-end"),
          ]), { minItems: 1, maxItems: 3 })),
        }),
        executionMode: "parallel" as const,
        async execute(_id: string, params: unknown, signal?: AbortSignal) {
          signal?.throwIfAborted();
          const input = params as ReadSharedEvidenceInput;
          const snapshot = sharedEvidence.snapshot(input.limit ?? 24, runtime.maxOutputBytes);
          const kinds = new Set(input.kinds ?? ["fact", "candidate", "dead-end"]);
          const result = {
            ...snapshot,
            entries: snapshot.entries.filter((entry) => kinds.has(entry.kind)),
          };
          await audit.append("collaboration.evidence_read", {
            returnedEntries: result.entries.length,
            totalEntries: result.totalEntries,
            truncated: result.truncated,
            kinds: [...kinds],
          });
          return textResult(JSON.stringify(result, null, 2), result);
        },
      },
      {
        name: "publish_shared_evidence",
        label: "Publish shared evidence",
        description:
          "Publish one concise direct observation, candidate, or evidenced dead end to the bounded same-task race board. Do not publish secrets or hidden reasoning.",
        parameters: Type.Object({
          kind: Type.Union([Type.Literal("fact"), Type.Literal("candidate"), Type.Literal("dead-end")]),
          claim: Type.String({ minLength: 1, maxLength: 600 }),
          evidence: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), { minItems: 1, maxItems: 8 }),
          confidence: Type.Number({ minimum: 0, maximum: 1 }),
        }),
        executionMode: "sequential" as const,
        async execute(_id: string, params: unknown, signal?: AbortSignal) {
          signal?.throwIfAborted();
          const published = sharedEvidence.publish(state.id, params as PublishSharedEvidenceToolInput);
          await audit.append("collaboration.evidence_published", {
            entry: published.entry,
            deduplicated: published.deduplicated,
            evicted: published.evicted,
            source: "tool",
          });
          return textResult(
            `${published.deduplicated ? "Merged" : "Published"} shared ${published.entry.kind}: ${published.entry.id}`,
            published,
          );
        },
      },
    ] satisfies ToolShape[] : []),
    {
      name: "list_files",
      label: "List workspace files",
      description: "List files under the authorized workspace without following symbolic links.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ default: "." })),
        depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, default: 2 })),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const input = params as ListFilesInput;
        const files = await listFiles(scope.workspaceRoot, input.path ?? ".", input.depth ?? 2);
        return textResult(files.join("\n") || "[empty directory]", { count: files.length, truncated: files.length >= 500 });
      },
    },
    {
      name: "read_file",
      label: "Read workspace file",
      description: "Read a bounded text or binary preview from the authorized workspace.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        length: Type.Optional(Type.Integer({ minimum: 1, maximum: 131072, default: 32768 })),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const input = params as ReadFileInput;
        const result = await readBoundedFile(
          scope.workspaceRoot,
          input.path,
          input.offset ?? 0,
          input.length ?? 32768,
          runtime.maxOutputBytes,
        );
        return textResult(result.display, {
          path: result.path,
          encoding: result.encoding,
          offset: result.offset,
          bytes: result.bytes,
          truncated: result.truncated,
          ...(result.preview ? { preview: result.preview } : {}),
        });
      },
    },
    {
      name: "inspect_artifact",
      label: "Inspect artifact",
      description:
        "Deterministically triage one workspace or scratch artifact: size, bounded hash, magic, entropy, printable ratio, and bounded strings.",
      parameters: Type.Object({
        source: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("scratch")])),
        path: Type.String({ minLength: 1 }),
        maxStrings: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 40 })),
      }),
      executionMode: "parallel",
      async execute(_id, params, signal) {
        const input = params as InspectArtifactInput;
        const source = input.source ?? "workspace";
        if (source === "scratch") await mkdir(runtime.scratchRoot, { recursive: true });
        const result = await inspectArtifactFile(
          source === "scratch" ? runtime.scratchRoot : scope.workspaceRoot,
          input.path,
          source,
          input.maxStrings ?? 40,
          signal,
        );
        return textResult(JSON.stringify(result, null, 2), result);
      },
    },
    {
      name: "extract_archive",
      label: "Extract archive to scratch",
      description:
        "Safely extract a bounded ZIP archive from workspace or scratch into this run's scratch namespace. Rejects traversal, absolute paths, duplicates, and excessive output.",
      parameters: Type.Object({
        source: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("scratch")])),
        path: Type.String({ minLength: 1 }),
        destination: Type.String({ minLength: 1 }),
        maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 33554432, default: 16777216 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as ExtractArchiveInput;
        const source = input.source ?? "workspace";
        await mkdir(runtime.scratchRoot, { recursive: true });
        const sourceRoot = source === "scratch" ? runtime.scratchRoot : scope.workspaceRoot;
        const archivePath = await resolveExistingWorkspacePath(sourceRoot, input.path);
        const result = await extractZipArchive(
          archivePath,
          `${source}:${input.path}`,
          runtime.scratchRoot,
          input.destination,
          input.maxEntries ?? 200,
          input.maxBytes ?? 16 * 1024 * 1024,
          signal,
        );
        await audit.append("artifact.archive_extracted", {
          source,
          path: result.source,
          destination: result.destination,
          entries: result.entries.length,
          bytes: result.bytes,
          truncated: result.truncated,
        });
        return textResult(JSON.stringify(result, null, 2), result);
      },
    },
    {
      name: "search_artifact",
      label: "Search binary artifact",
      description:
        "Search a bounded workspace or scratch artifact for a UTF-8 or hex byte pattern and return offsets with bounded context.",
      parameters: Type.Object({
        source: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("scratch")])),
        path: Type.String({ minLength: 1 }),
        pattern: Type.String({ minLength: 1, maxLength: 8192 }),
        encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("hex")])),
        maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
        contextBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 256, default: 64 })),
      }),
      executionMode: "parallel",
      async execute(_id, params, signal) {
        const input = params as SearchArtifactInput;
        const source = input.source ?? "workspace";
        if (source === "scratch") await mkdir(runtime.scratchRoot, { recursive: true });
        const root = source === "scratch" ? runtime.scratchRoot : scope.workspaceRoot;
        const result = await searchArtifact(
          root,
          input.path,
          input.pattern,
          input.encoding ?? "utf8",
          input.maxMatches ?? 20,
          input.contextBytes ?? 64,
          signal,
        );
        await audit.append("artifact.searched", {
          source,
          path: result.path,
          encoding: result.encoding,
          inspectedBytes: result.inspectedBytes,
          matches: result.matches.length,
          truncated: result.truncated,
          matchLimitReached: result.matchLimitReached,
        });
        return textResult(JSON.stringify(result, null, 2), result);
      },
    },
    {
      name: "observe_image",
      label: "Observe image",
      description:
        "Return one bounded JPEG, PNG, GIF, or WebP workspace/scratch image to the model for visual inspection. Read-only; image bytes are omitted from persisted audit and transcript artifacts.",
      parameters: Type.Object({
        source: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("scratch")])),
        path: Type.String({ minLength: 1 }),
      }),
      executionMode: "parallel",
      async execute(_id, params, signal) {
        const input = params as ObserveImageInput;
        const source = input.source ?? "workspace";
        if (source === "scratch") await mkdir(runtime.scratchRoot, { recursive: true });
        const result = await observeImageFile(
          source === "scratch" ? runtime.scratchRoot : scope.workspaceRoot,
          input.path,
          source,
          runtime.maxImageBytes,
          signal,
        );
        await audit.append("image.observed", result.details);
        return result;
      },
    },
    {
      name: "list_scratch_files",
      label: "List scratch files",
      description: "List files under the writable scratch root where generated scripts and artifacts live.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ default: "." })),
        depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, default: 2 })),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const input = params as ListFilesInput;
        await mkdir(runtime.scratchRoot, { recursive: true });
        const files = await listFiles(runtime.scratchRoot, input.path ?? ".", input.depth ?? 2);
        return textResult(files.join("\n") || "[empty scratch directory]", {
          count: files.length,
          truncated: files.length >= 500,
          scratchRoot: runtime.scratchRoot,
        });
      },
    },
    {
      name: "read_scratch_file",
      label: "Read scratch file",
      description: "Read a bounded text or binary preview from the writable scratch root.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        length: Type.Optional(Type.Integer({ minimum: 1, maximum: 131072, default: 32768 })),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const input = params as ReadFileInput;
        await mkdir(runtime.scratchRoot, { recursive: true });
        const result = await readBoundedFile(
          runtime.scratchRoot,
          input.path,
          input.offset ?? 0,
          input.length ?? 32768,
          runtime.maxOutputBytes,
        );
        return textResult(result.display, {
          path: result.path,
          encoding: result.encoding,
          offset: result.offset,
          bytes: result.bytes,
          truncated: result.truncated,
          ...(result.preview ? { preview: result.preview } : {}),
        });
      },
    },
    {
      name: "write_scratch_file",
      label: "Write scratch file",
      description: "Write a bounded generated file under scratchRoot for solve scripts, notes, payloads, or decoded artifacts.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        content: Type.String({ maxLength: 1048576 }),
        encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
        append: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as ScratchWriteInput;
        await mkdir(runtime.scratchRoot, { recursive: true });
        const target = await resolveScratchPath(runtime.scratchRoot, input.path);
        const data = decodeToolData(input.content, input.encoding ?? "utf8");
        let existingSize = 0;
        try {
          const stats = await lstat(target);
          if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Scratch target is not a regular file");
          existingSize = stats.size;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
        }
        if (data.length + (input.append ? existingSize : 0) > runtime.maxScratchFileBytes) {
          throw new Error("Scratch file size budget exceeded");
        }
        await mkdir(dirname(target), { recursive: true });
        const [realRoot, realParent] = await Promise.all([realpath(runtime.scratchRoot), realpath(dirname(target))]);
        if (!isPathInside(realRoot, realParent)) throw new Error("Scratch target parent escapes scratchRoot");
        await writeFile(target, data, { flag: input.append ? "a" : "w" });
        await audit.append("scratch.written", {
          path: relative(runtime.scratchRoot, target),
          bytes: data.length,
          append: Boolean(input.append),
        });
        return textResult(`Wrote ${data.length} bytes to scratch:${relative(runtime.scratchRoot, target)}`, {
          path: relative(runtime.scratchRoot, target),
          bytes: data.length,
          append: Boolean(input.append),
        });
      },
    },
    {
      name: "run_command",
      label: "Run sandbox command",
      description:
        "Run an allowlisted analysis program in the CTF sandbox via structured program/args/stdin. No shell is used.",
      parameters: Type.Object({
        program: Type.String({ minLength: 1 }),
        args: Type.Array(Type.String()),
        cwd: Type.Optional(Type.Union([Type.Literal("scratch"), Type.Literal("workspace")])),
        stdin: Type.Optional(Type.String({ maxLength: 1048576 })),
        stdinEncoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as RunCommandInput;
        const result = await executor.exec(
          {
            program: basename(input.program),
            args: input.args,
            ...(sandboxNamespace ? { namespace: sandboxNamespace } : {}),
            cwd: input.cwd ?? "scratch",
            ...(input.stdin !== undefined ? { stdin: input.stdin, stdinEncoding: input.stdinEncoding ?? "utf8" } : {}),
            timeoutMs: Math.min(input.timeoutMs ?? runtime.commandTimeoutMs, runtime.commandTimeoutMs),
            maxOutputBytes: Math.min(runtime.maxOutputBytes, MAX_COMMAND_OUTPUT_CHARS),
          },
          signal,
        );
        const publicResult = {
          ...result,
          stdout: boundedCommandOutput(result.stdout),
          stderr: boundedCommandOutput(result.stderr),
          ...(result.truncated ? { truncated: true } : {}),
        };
        return textResult(
          [
            `exitCode=${publicResult.exitCode}`,
            `signal=${publicResult.signal ?? "none"}`,
            `timedOut=${publicResult.timedOut}`,
            `stdout:\n${publicResult.stdout}`,
            `stderr:\n${publicResult.stderr}`,
          ].join("\n"),
          publicResult,
        );
      },
    },
    {
      name: "web_collect_baseline",
      label: "Collect Web baseline",
      description: "Perform one bounded GET against an authorized Web target and return structured response evidence.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        includeBody: Type.Optional(Type.Boolean({ default: true })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as WebBaselineInput;
        const timeoutSignal = AbortSignal.timeout(runtime.httpTimeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const startedAt = Date.now();
        const response = await fetch(input.url, { method: "GET", redirect: "manual", signal: combined });
        const body = await boundedResponseBytes(response, runtime.maxOutputBytes);
        const rendered = input.includeBody === false ? { encoding: "utf8", text: "[body omitted]" } : renderBytes(body.bytes, "auto");
        const headers = safeResponseHeaders(response.headers);
        const responseSha256 = createHash("sha256").update(body.bytes).digest("hex");
        const durationMs = Date.now() - startedAt;
        return textResult(
          [
            `url=${input.url}`,
            `status=${response.status}`,
            `headers=${JSON.stringify(headers)}`,
            `bodyEncoding=${rendered.encoding}`,
            `bodyBytes=${body.bytes.length}`,
            `bodySha256=${responseSha256}`,
            `durationMs=${durationMs}`,
            `body:\n${rendered.text}`,
          ].join("\n"),
          { url: input.url, status: response.status, headers, encoding: rendered.encoding, bytes: body.bytes.length, truncated: body.truncated, responseSha256, durationMs },
        );
      },
    },
    {
      name: "web_knowledge_lookup",
      label: "Lookup Web knowledge",
      description: "Search the reviewed Web vulnerability knowledge base for evidence signals, bounded tests, and verification requirements.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 5 })),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const input = params as WebKnowledgeInput;
        const matches = searchWebKnowledge(input.query, input.limit ?? 5);
        return textResult(JSON.stringify({ query: input.query, matches }, null, 2), { query: input.query, count: matches.length });
      },
    },
    {
      name: "web_compare_responses",
      label: "Compare Web responses",
      description: "Compare two bounded response bodies and report deterministic differences without making a vulnerability claim.",
      parameters: Type.Object({
        baseline: Type.String({ maxLength: 65536 }),
        candidate: Type.String({ maxLength: 65536 }),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const input = params as WebCompareInput;
        const baselineLines = input.baseline.split(/\r?\n/);
        const candidateLines = input.candidate.split(/\r?\n/);
        const changedLines = Math.abs(candidateLines.length - baselineLines.length) + baselineLines.reduce(
          (count, line, index) => count + (candidateLines[index] === line ? 0 : 1),
          0,
        );
        const details = {
          baselineSha256: createHash("sha256").update(input.baseline).digest("hex"),
          candidateSha256: createHash("sha256").update(input.candidate).digest("hex"),
          baselineBytes: Buffer.byteLength(input.baseline),
          candidateBytes: Buffer.byteLength(input.candidate),
          baselineLines: baselineLines.length,
          candidateLines: candidateLines.length,
          changedLines,
          different: input.baseline !== input.candidate,
        };
        return textResult(JSON.stringify(details, null, 2), details);
      },
    },
    {
      name: "http_request",
      label: "Scoped HTTP request",
      description: "Send one bounded HTTP request to an explicitly authorized host. Supports an in-memory per-run Cookie Jar, form or string-only multipart fields, bounded redirect following, and replay of a prior request. Cookie values never appear in results or artifacts.",
      parameters: Type.Object({
        method: Type.Union([
          Type.Literal("GET"),
          Type.Literal("HEAD"),
          Type.Literal("POST"),
          Type.Literal("PUT"),
          Type.Literal("PATCH"),
          Type.Literal("DELETE"),
          Type.Literal("OPTIONS"),
        ]),
        url: Type.String({ minLength: 1 }),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        body: Type.Optional(Type.String({ maxLength: 65536 })),
        bodyEncoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
        responseEncoding: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("utf8"), Type.Literal("base64")])),
        sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        followRedirects: Type.Optional(Type.Boolean({ default: false })),
        form: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 8192 }))),
        multipart: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 8192 }))),
        replayOf: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        compareTo: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as HttpRequestInput;
        const timeoutSignal = AbortSignal.timeout(runtime.httpTimeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const replay = input.replayOf ? httpReplays.get(input.replayOf) : undefined;
        if (input.replayOf && !replay) throw new Error("Unknown HTTP replay id");
        const sessionId = input.sessionId ?? "default";
        const session = sessionId ? (httpSessions.get(sessionId) ?? (() => { const created = { cookies: new Map<string, string>() }; httpSessions.set(sessionId, created); return created; })()) : undefined;
        const requestHeaders: Record<string, string> = { ...(replay?.headers ?? {}), ...(input.headers ?? {}) };
        if (session && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "cookie") && session.cookies.size > 0) {
          requestHeaders.Cookie = [...session.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
        }
        let bodyBytes = input.body === undefined ? replay?.body : decodeToolData(input.body, input.bodyEncoding ?? "utf8");
        if (input.form) {
          bodyBytes = new TextEncoder().encode(new URLSearchParams(input.form).toString());
          requestHeaders["content-type"] ??= "application/x-www-form-urlencoded";
        }
        if (input.multipart) {
          const multipart = new FormData();
          for (const [key, value] of Object.entries(input.multipart)) multipart.append(key, value);
          const multipartResponse = new Response(multipart);
          const encoded = await multipartResponse.arrayBuffer();
          bodyBytes = new Uint8Array(encoded);
          requestHeaders["content-type"] = multipartResponse.headers.get("content-type") ?? "multipart/form-data";
        }
        const initialMethod = replay?.method ?? input.method;
        const initialUrl = replay?.url ?? input.url;
        const requestInit: RequestInit = { method: initialMethod, redirect: "manual", signal: combined };
        if (Object.keys(requestHeaders).length > 0) requestInit.headers = requestHeaders;
        if (bodyBytes !== undefined) {
          requestInit.body = bodyBytes.buffer.slice(
            bodyBytes.byteOffset,
            bodyBytes.byteOffset + bodyBytes.byteLength,
          ) as ArrayBuffer;
        }
        const startedAt = Date.now();
        let currentUrl = initialUrl;
        let currentMethod = initialMethod;
        let currentBody = bodyBytes;
        const redirects: string[] = [];
        let response: Response;
        for (let redirectCount = 0; ; redirectCount += 1) {
          const nextInit: RequestInit = { ...requestInit, method: currentMethod };
          if (currentBody) nextInit.body = currentBody.buffer.slice(currentBody.byteOffset, currentBody.byteOffset + currentBody.byteLength) as ArrayBuffer;
          else delete nextInit.body;
          response = await fetch(currentUrl, nextInit);
          if (!input.followRedirects || response.status < 300 || response.status >= 400) break;
          if (redirectCount >= 5) throw new Error("HTTP redirect limit exceeded");
          const location = response.headers.get("location");
          if (!location) break;
          const nextUrl = new URL(location, currentUrl);
          const allowed = (host: string) => scope.allowedHosts.some((pattern) => hostMatches(host, pattern));
          if (!allowed(nextUrl.host) && !allowed(nextUrl.hostname)) throw new Error(`Redirect target is outside the authorized scope: ${nextUrl.host}`);
          redirects.push(nextUrl.toString());
          currentUrl = nextUrl.toString();
          if (response.status === 301 || response.status === 302 || response.status === 303) {
            currentMethod = "GET";
            currentBody = undefined;
          }
        }
        const body = await boundedResponseBytes(response, runtime.maxOutputBytes);
        const rendered = renderBytes(body.bytes, input.responseEncoding ?? "auto");
        const headers = safeResponseHeaders(response.headers);
        if (session) for (const cookie of setCookieHeaders(response.headers)) { const first = cookie.split(";", 1)[0] ?? ""; const separator = first.indexOf("="); if (separator > 0) session.cookies.set(first.slice(0, separator).trim(), first.slice(separator + 1)); }
        const requestId = randomUUID();
        httpReplays.set(requestId, { method: currentMethod, url: currentUrl, headers: requestHeaders, ...(currentBody ? { body: currentBody } : {}) });
        const responseSha256 = createHash("sha256").update(body.bytes).digest("hex");
        const durationMs = Date.now() - startedAt;
        const currentResponse: HttpResponseMemory = { status: response.status, headers, body: rendered.text, bodySha256: responseSha256, bytes: body.bytes.length };
        const comparison = input.compareTo ? (() => { const baseline = httpResponses.get(input.compareTo as string); if (!baseline) throw new Error("Unknown HTTP response comparison id"); return { statusChanged: baseline.status !== currentResponse.status, bodyLengthChanged: baseline.bytes !== currentResponse.bytes, bodyChanged: baseline.bodySha256 !== currentResponse.bodySha256, headerChanges: Object.keys({ ...baseline.headers, ...currentResponse.headers }).filter((key) => baseline.headers[key] !== currentResponse.headers[key]).slice(0, 40) }; })() : undefined;
        httpResponses.set(requestId, currentResponse);
        return textResult(
          [
            `requestId=${requestId}`,
            `sessionId=${sessionId}`,
            `status=${response.status}`,
            `headers=${JSON.stringify(headers)}`,
            `bodyEncoding=${rendered.encoding}`,
            `bodyBytes=${body.bytes.length}`,
            `bodySha256=${responseSha256}`,
            ...(redirects.length ? [`redirects=${JSON.stringify(redirects)}`] : []),
            ...(comparison ? [`comparison=${JSON.stringify(comparison)}`] : []),
            `durationMs=${durationMs}`,
            `body:\n${rendered.text}`,
          ].join("\n"),
          {
            requestId,
            sessionId,
            status: response.status,
            headers,
            cookieNames: cookieNames(response.headers),
            redirect: response.redirected,
            redirects,
            ...(comparison ? { comparison } : {}),
            encoding: rendered.encoding,
            bytes: body.bytes.length,
            truncated: body.truncated,
            responseSha256,
            durationMs,
          },
        );
      },
    },
    {
      name: "web_timing_stats",
      label: "Analyze Web timing samples",
      description: "Compute bounded deterministic timing statistics for samples already collected through authorized requests. This is an analysis helper, not a network scanner.",
      parameters: Type.Object({
        samples: Type.Array(Type.Number({ minimum: 0, maximum: 300000 }), { minItems: 2, maxItems: 30 }),
        baselineSamples: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 300000 }), { minItems: 2, maxItems: 30 })),
      }),
      executionMode: "parallel",
      async execute(_id, params) {
        const input = params as WebTimingInput;
        const stats = (values: number[]) => {
          const sorted = [...values].sort((left, right) => left - right);
          const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
          const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
          return { count: values.length, min: sorted[0], max: sorted.at(-1), mean, median: sorted[Math.floor(sorted.length / 2)], stddev: Math.sqrt(variance) };
        };
        const result = { samples: stats(input.samples), ...(input.baselineSamples ? { baseline: stats(input.baselineSamples), meanDeltaMs: stats(input.samples).mean - stats(input.baselineSamples).mean } : {}) };
        return textResult(JSON.stringify(result), result);
      },
    },
    {
      name: "tcp_open",
      label: "Open scoped TCP session",
      description: "Open a stateful TCP connection to an explicitly authorized host:port.",
      parameters: Type.Object({
        host: Type.String({ minLength: 1 }),
        port: Type.Integer({ minimum: 1, maximum: 65535 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as TcpOpenInput;
        const socket = await connectTcp({ ...input, timeoutMs: input.timeoutMs ?? runtime.httpTimeoutMs }, signal);
        const session: TcpSession = {
          id: randomUUID(),
          host: input.host,
          port: input.port,
          socket,
          chunks: [],
          bufferedBytes: 0,
          receivedBytes: 0,
          sentBytes: 0,
          closed: false,
        };
        socket.on("data", (chunk: Buffer) => {
          const remaining = runtime.maxTcpBytes - session.receivedBytes;
          if (remaining <= 0) {
            session.lastError = "TCP receive byte budget exhausted";
            socket.destroy();
            return;
          }
          const accepted = chunk.subarray(0, remaining);
          session.chunks.push(accepted);
          session.bufferedBytes += accepted.length;
          session.receivedBytes += accepted.length;
          if (chunk.length > remaining) {
            session.lastError = "TCP receive byte budget exhausted";
            socket.destroy();
          }
        });
        socket.once("close", () => {
          session.closed = true;
        });
        socket.once("error", (error) => {
          session.lastError = error.message;
          session.closed = true;
        });
        tcpSessions.set(session.id, session);
        return textResult(`TCP session opened: ${session.id}`, {
          sessionId: session.id,
          host: session.host,
          port: session.port,
        });
      },
    },
    {
      name: "tcp_send",
      label: "Send TCP data",
      description: "Send bounded UTF-8 or base64 data over an existing scoped TCP session.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        data: Type.String({ maxLength: 1048576 }),
        encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
        newline: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as TcpSendInput;
        const session = tcpSessions.get(input.sessionId);
        if (!session || session.closed) throw new Error("TCP session is not open");
        const data = decodeToolData(input.data, input.encoding ?? "utf8");
        const payload = input.newline ? Buffer.concat([data, Buffer.from("\n")]) : data;
        if (session.sentBytes + payload.length > runtime.maxTcpBytes) throw new Error("TCP send byte budget exhausted");
        await new Promise<void>((resolveWrite, reject) => {
          session.socket.write(payload, (error) => (error ? reject(error) : resolveWrite()));
        });
        session.sentBytes += payload.length;
        return textResult(`Sent ${payload.length} bytes on TCP session ${session.id}.`, {
          sessionId: session.id,
          bytes: payload.length,
          totalSentBytes: session.sentBytes,
        });
      },
    },
    {
      name: "tcp_receive",
      label: "Receive TCP data",
      description: "Receive bounded UTF-8 or base64 data from an existing scoped TCP session.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        length: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536, default: 4096 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 10, maximum: 30000, default: 1000 })),
        encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as TcpReceiveInput;
        const session = tcpSessions.get(input.sessionId);
        if (!session) throw new Error("TCP session does not exist");
        const data = await receiveTcp(
          session,
          Math.min(input.length ?? 4096, runtime.maxOutputBytes),
          input.timeoutMs ?? 1000,
        );
        const rendered = renderBytes(data, input.encoding ?? "auto");
        return textResult(rendered.text, {
          sessionId: session.id,
          encoding: rendered.encoding,
          bytes: data.length,
          closed: session.closed,
          lastError: session.lastError,
          bufferedBytes: session.bufferedBytes,
          totalReceivedBytes: session.receivedBytes,
        });
      },
    },
    {
      name: "tcp_close",
      label: "Close TCP session",
      description: "Close an existing scoped TCP session and release its buffers.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as TcpCloseInput;
        const closed = await closeTcpSession(input.sessionId);
        return textResult(closed ? `Closed TCP session ${input.sessionId}.` : "TCP session was already absent.", {
          sessionId: input.sessionId,
          closed,
        });
      },
    },
    {
      name: "record_finding",
      label: "Record finding",
      description: "Record an evidence-backed security or operational finding. Confidence is between 0 and 1.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        severity: Type.Union([
          Type.Literal("info"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("critical"),
        ]),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        description: Type.String({ minLength: 1 }),
        evidence: Type.Array(Type.String(), { minItems: 1 }),
        remediation: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const input = params as FindingInput;
        const finding: Finding = { id: randomUUID(), ...input };
        state.findings.push(finding);
        state.phase = "verification";
        await audit.append("finding.recorded", finding);
        if (sharedEvidence) {
          const published = sharedEvidence.publish(state.id, {
            kind: finding.confidence >= 0.8 ? "fact" : "candidate",
            claim: `${finding.title}: ${finding.description}`,
            evidence: finding.evidence,
            confidence: finding.confidence,
          });
          await audit.append("collaboration.evidence_published", {
            entry: published.entry,
            deduplicated: published.deduplicated,
            evicted: published.evicted,
            source: "finding",
          });
        }
        return textResult(`Finding recorded: ${finding.id}`, finding);
      },
    },
    {
      name: "record_lesson",
      label: "Record reusable lesson",
      description:
        "Capture a generic, evidence-backed lesson for later validation. Never include challenge IDs, flags, credentials, fixed addresses, or memorized answers.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 160 }),
        applicableWhen: Type.Array(Type.String({ minLength: 1, maxLength: 320 }), { minItems: 1, maxItems: 8 }),
        strategy: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
        verification: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 8 }),
        pitfalls: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
        tools: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 }),
      }),
      async execute(_id, params) {
        const input = params as ExperienceLessonInput;
        const lesson: ExperienceLesson = { id: randomUUID(), ...input };
        state.lessons.push(lesson);
        await audit.append("lesson.captured", lesson);
        return textResult(`Reusable lesson candidate captured: ${lesson.id}`, lesson);
      },
    },
    {
      name: "finish_task",
      label: "Finish task",
      description: "End the run with a concise summary and explicit completed or blocked status.",
      parameters: Type.Object({
        status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
        summary: Type.String({ minLength: 1 }),
        submission: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        evidence: Type.Array(Type.String()),
        remainingRisks: Type.Array(Type.String()),
        nextSteps: Type.Array(Type.String()),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        verification: Type.Array(Type.String({ minLength: 1, maxLength: 1000 })),
        independentlyVerified: Type.Boolean(),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as FinishTaskInput;
        state.status = input.status;
        state.summary = input.summary;
        state.verification = [...input.verification];
        state.independentlyVerified = input.independentlyVerified;
        state.remainingRisks = [...input.remainingRisks].slice(0, 20);
        state.nextSteps = [...input.nextSteps].slice(0, 20);
        if (input.submission) {
          state.submission = input.submission.trim();
        }
        state.stopReason = input.status === "completed" ? "Agent declared task complete" : "Agent reported a blocker";
        state.phase = "done";
        await audit.append("run.finished_by_agent", input);
        return { ...textResult(input.summary, input), terminate: true };
      },
    },
  ];

  for (const registration of externalTools) tools.push(registration.tool);

  return { tools, cleanup };
}

export function createTools(context: ToolContext): ToolShape[] {
  return createToolSet(context).tools;
}

import { lstat, mkdir, open as openFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import { isPathInside } from "./policy.js";

const MAX_ARCHIVE_ENTRIES = 500;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_PATTERN_BYTES = 4096;

export interface ArchiveExtractionResult {
  source: string;
  destination: string;
  entries: string[];
  bytes: number;
  truncated: boolean;
}

export interface ArtifactSearchResult {
  path: string;
  pattern: string;
  encoding: "utf8" | "hex";
  inspectedBytes: number;
  truncated: boolean;
  matches: Array<{ offset: number; context: string; contextEncoding: "utf8" | "base64" }>;
  matchLimitReached: boolean;
}

function openZipFile(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    openZip(path, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) rejectZip(error ?? new Error("Unable to open ZIP archive"));
      else resolveZip(zipFile);
    });
  });
}

function safeEntryPath(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Archive entry escapes extraction root: ${fileName}`);
  }
  return normalized.replace(/\/+$/, "");
}

async function ensureSafeScratchDirectory(realScratchRoot: string, directory: string): Promise<string> {
  if (!isPathInside(realScratchRoot, directory)) throw new Error("Extraction directory escapes scratchRoot");
  const pathFromRoot = relative(realScratchRoot, directory);
  if (!pathFromRoot || pathFromRoot === ".") return realScratchRoot;
  let current = realScratchRoot;
  for (const segment of pathFromRoot.split(/[\\/]/)) {
    if (!segment || segment === "." || segment === "..") throw new Error("Invalid extraction directory");
    const next = resolve(current, segment);
    try {
      const stats = await lstat(next);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Extraction directory is not a regular directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(next);
      const created = await lstat(next);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("Extraction directory is not a regular directory");
    }
    const realCurrent = await realpath(next);
    if (!isPathInside(realScratchRoot, realCurrent)) throw new Error("Extraction directory escapes scratchRoot");
    current = realCurrent;
  }
  return current;
}

function readEntry(entry: Entry, zipFile: ZipFile, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolveEntry, rejectEntry) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        rejectEntry(error ?? new Error(`Unable to read archive entry: ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        if (signal?.aborted) {
          stream.destroy(signal.reason ?? new DOMException("Archive extraction aborted", "AbortError"));
          return;
        }
        size += chunk.length;
        if (size > maximumBytes) {
          stream.destroy(new Error("Archive entry exceeds the extraction budget"));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", rejectEntry);
      stream.once("end", () => resolveEntry(Buffer.concat(chunks)));
    });
  });
}

export async function extractZipArchive(
  sourcePath: string,
  sourceLabel: string,
  scratchRoot: string,
  destinationPath: string,
  maxEntries: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ArchiveExtractionResult> {
  signal?.throwIfAborted();
  const sourceStats = await lstat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) throw new Error("Archive source is not a regular file");
  await mkdir(scratchRoot, { recursive: true });
  const realScratchRoot = await realpath(scratchRoot);
  const destination = resolve(realScratchRoot, destinationPath);
  if (!isPathInside(realScratchRoot, destination)) throw new Error("Extraction destination escapes scratchRoot");
  const realDestination = await ensureSafeScratchDirectory(realScratchRoot, destination);

  const entryLimit = Math.min(Math.max(1, maxEntries), MAX_ARCHIVE_ENTRIES);
  const byteLimit = Math.min(Math.max(1, maxBytes), MAX_ARCHIVE_BYTES);
  const zipFile = await openZipFile(sourcePath);
  const entries: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    await new Promise<void>((resolveArchive, rejectArchive) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveArchive();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        rejectArchive(error instanceof Error ? error : new Error(String(error)));
      };
      zipFile.once("error", fail);
      zipFile.on("entry", (entry: Entry) => {
        void (async () => {
          signal?.throwIfAborted();
          if (entries.length >= entryLimit) {
            truncated = true;
            zipFile.close();
            finish();
            return;
          }
          const relativeEntry = safeEntryPath(entry.fileName);
          if (!relativeEntry) {
            zipFile.readEntry();
            return;
          }
          const target = resolve(realDestination, relativeEntry);
          if (!isPathInside(realDestination, target)) throw new Error("Archive entry escapes extraction root");
          if (entry.fileName.endsWith("/")) {
            await ensureSafeScratchDirectory(realScratchRoot, target);
            entries.push(`${relativeEntry}/`);
            zipFile.readEntry();
            return;
          }
          const remainingBytes = byteLimit - totalBytes;
          if (entry.uncompressedSize > remainingBytes) {
            truncated = true;
            zipFile.close();
            finish();
            return;
          }
          const data = await readEntry(entry, zipFile, remainingBytes, signal);
          if (data.length > remainingBytes) {
            truncated = true;
            zipFile.close();
            finish();
            return;
          }
          await ensureSafeScratchDirectory(realScratchRoot, dirname(target));
          await writeFile(target, data, { flag: "wx" });
          totalBytes += data.length;
          entries.push(relativeEntry);
          zipFile.readEntry();
        })().catch(fail);
      });
      zipFile.once("end", finish);
      zipFile.readEntry();
    });
  } finally {
    if (zipFile.isOpen) zipFile.close();
  }

  return {
    source: sourceLabel,
    destination: relative(realScratchRoot, realDestination),
    entries,
    bytes: totalBytes,
    truncated,
  };
}

function parsePattern(pattern: string, encoding: "utf8" | "hex"): Buffer {
  if (encoding === "utf8") {
    const data = Buffer.from(pattern, "utf8");
    if (data.length === 0 || data.length > MAX_PATTERN_BYTES) throw new Error("Search pattern is outside the size limit");
    return data;
  }
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(pattern)) throw new Error("Hex search patterns must contain complete bytes");
  const data = Buffer.from(pattern, "hex");
  if (data.length > MAX_PATTERN_BYTES) throw new Error("Search pattern is outside the size limit");
  return data;
}

export async function searchArtifact(
  root: string,
  inputPath: string,
  pattern: string,
  encoding: "utf8" | "hex",
  maxMatches: number,
  contextBytes: number,
  signal?: AbortSignal,
): Promise<ArtifactSearchResult> {
  signal?.throwIfAborted();
  const path = resolve(root, inputPath);
  const realRoot = await realpath(root);
  const realPath = await realpath(path);
  if (!isPathInside(realRoot, realPath)) throw new Error("Search path escapes the artifact root");
  const stats = await lstat(realPath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Search path is not a regular file");
  const inspectedBytes = Math.min(stats.size, MAX_SEARCH_BYTES);
  const handle = await openFile(realPath, "r");
  const buffer = Buffer.alloc(inspectedBytes);
  let offset = 0;
  try {
    while (offset < inspectedBytes) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, offset, inspectedBytes - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  const bytes = buffer.subarray(0, offset);
  const needle = parsePattern(pattern, encoding);
  const matches: ArtifactSearchResult["matches"] = [];
  let cursor = 0;
  const matchLimit = Math.min(Math.max(1, maxMatches), 100);
  while (matches.length < matchLimit) {
    signal?.throwIfAborted();
    const found = bytes.indexOf(needle, cursor);
    if (found < 0) break;
    const boundedContext = Math.min(Math.max(0, contextBytes), 256);
    const start = Math.max(0, found - boundedContext);
    const end = Math.min(bytes.length, found + needle.length + boundedContext);
    const context = bytes.subarray(start, end);
    const printable = [...context].every((value) => value === 9 || value === 10 || value === 13 || (value >= 0x20 && value <= 0x7e));
    matches.push({
      offset: found,
      context: printable ? context.toString("utf8") : context.toString("base64"),
      contextEncoding: printable ? "utf8" : "base64",
    });
    cursor = found + Math.max(1, needle.length);
  }
  return {
    path: relative(realRoot, realPath),
    pattern,
    encoding,
    inspectedBytes: offset,
    truncated: offset < stats.size,
    matches,
    matchLimitReached: matches.length >= matchLimit,
  };
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { NormalizedAttachment, NormalizedTask, TaskRequest } from "./types.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".c",
  ".conf",
  ".cpp",
  ".cs",
  ".csv",
  ".go",
  ".har",
  ".html",
  ".java",
  ".js",
  ".json",
  ".log",
  ".md",
  ".py",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function isSafeArchivePath(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("\\") && !path.split(/[\\/]/).includes("..");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function listDirectory(root: string): Promise<{ entries: string[]; truncated: boolean }> {
  const queue = [root];
  const entries: string[] = [];
  while (queue.length > 0 && entries.length < MAX_DIRECTORY_ENTRIES) {
    const directory = queue.shift();
    if (!directory) break;
    for await (const item of await opendir(directory)) {
      const absolute = resolve(directory, item.name);
      const relativePath = relative(root, absolute).replaceAll("\\", "/");
      entries.push(relativePath + (item.isDirectory() ? "/" : ""));
      if (item.isDirectory()) queue.push(absolute);
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
    }
  }
  return { entries, truncated: queue.length > 0 || entries.length >= MAX_DIRECTORY_ENTRIES };
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Unable to open ZIP archive"));
      else resolveZip(zip);
    });
  });
}

function readZipEntry(zip: ZipFile, entry: Entry): Promise<string> {
  return new Promise((resolveEntry, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read ZIP entry: ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        if (size >= MAX_PREVIEW_BYTES) return;
        const remaining = MAX_PREVIEW_BYTES - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
      });
      stream.once("error", reject);
      stream.once("end", () => resolveEntry(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

async function inspectZip(path: string): Promise<{ entries: string[]; previews: string[]; truncated: boolean }> {
  const zip = await openZip(path);
  return new Promise((resolveArchive, reject) => {
    const entries: string[] = [];
    const previews: string[] = [];
    let totalUncompressed = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.once("error", fail);
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveArchive({ entries, previews, truncated: entries.length >= MAX_ARCHIVE_ENTRIES });
    };
    zip.once("end", finish);
    zip.once("close", finish);
    zip.on("entry", async (entry: Entry) => {
      try {
        if (!isSafeArchivePath(entry.fileName)) throw new Error(`Unsafe ZIP entry path: ${entry.fileName}`);
        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error("ZIP uncompressed-size limit exceeded");
        entries.push(entry.fileName);
        const isFile = !entry.fileName.endsWith("/");
        if (
          isFile &&
          entry.uncompressedSize <= MAX_PREVIEW_BYTES &&
          TEXT_EXTENSIONS.has(extname(entry.fileName).toLowerCase()) &&
          previews.join("").length < MAX_PREVIEW_BYTES
        ) {
          previews.push(`--- ${entry.fileName} ---\n${await readZipEntry(zip, entry)}`);
        }
        if (entries.length >= MAX_ARCHIVE_ENTRIES) zip.close();
        else zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

async function normalizeAttachment(source: string): Promise<NormalizedAttachment> {
  const path = resolve(source);
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`Symbolic-link attachments are not accepted: ${source}`);
  if (stats.isDirectory()) {
    const listing = await listDirectory(path);
    return {
      source: path,
      kind: "directory",
      size: stats.size,
      summary: `Directory with ${listing.entries.length} visible entries`,
      entries: listing.entries,
      truncated: listing.truncated,
    };
  }
  if (!stats.isFile()) throw new Error(`Unsupported attachment type: ${source}`);
  if (stats.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes: ${source}`);
  const extension = extname(path).toLowerCase();
  const sha256 = await sha256File(path);
  const magic = await readPrefix(path, 4);
  const zipMagic =
    magic.length >= 4 &&
    magic[0] === 0x50 &&
    magic[1] === 0x4b &&
    ((magic[2] === 0x03 && magic[3] === 0x04) ||
      (magic[2] === 0x05 && magic[3] === 0x06) ||
      (magic[2] === 0x07 && magic[3] === 0x08));
  if (extension === ".zip" && zipMagic) {
    if (stats.size > MAX_FILE_BYTES) throw new Error(`ZIP exceeds ${MAX_FILE_BYTES} compressed bytes: ${source}`);
    const archive = await inspectZip(path);
    return {
      source: path,
      kind: "archive",
      size: stats.size,
      sha256,
      summary: `ZIP archive with ${archive.entries.length} inspected entries`,
      content: archive.previews.join("\n\n").slice(0, MAX_PREVIEW_BYTES),
      entries: archive.entries,
      truncated: archive.truncated || archive.previews.join("").length >= MAX_PREVIEW_BYTES,
    };
  }
  if (TEXT_EXTENSIONS.has(extension) || stats.size === 0) {
    const bytes = await readPrefix(path, MAX_PREVIEW_BYTES);
    const content = bytes.toString("utf8");
    const structured = [".csv", ".har", ".json", ".toml", ".xml", ".yaml", ".yml"].includes(extension);
    return {
      source: path,
      kind: structured ? "structured" : "text",
      size: stats.size,
      sha256,
      summary: `${structured ? "Structured" : "Text"} file (${stats.size} bytes)`,
      content,
      truncated: stats.size > MAX_PREVIEW_BYTES,
    };
  }
  return {
    source: path,
    kind: "binary",
    size: stats.size,
    sha256,
    summary: `Binary file (${stats.size} bytes); inspect it with scoped local tools`,
    truncated: false,
  };
}

export async function normalizeTask(request: TaskRequest): Promise<NormalizedTask> {
  const task = request.task.trim();
  if (!task) throw new Error("Task must not be empty");
  if (task.length > 100_000) throw new Error("Task exceeds 100000 characters");
  if ((request.attachments?.length ?? 0) > 20) throw new Error("A task may contain at most 20 attachments");
  const attachments: NormalizedAttachment[] = [];
  for (const source of request.attachments ?? []) attachments.push(await normalizeAttachment(source));
  return { task, attachments, metadata: { ...(request.metadata ?? {}) } };
}

export function renderTaskContext(task: NormalizedTask): string {
  const attachments = task.attachments.map((attachment, index) => {
    const details = [
      `Attachment ${index + 1}: ${attachment.source}`,
      `kind=${attachment.kind} size=${attachment.size} sha256=${attachment.sha256 ?? "n/a"}`,
      attachment.summary,
      attachment.entries?.length ? `entries:\n${attachment.entries.join("\n")}` : "",
      attachment.content ? `preview:\n${attachment.content}` : "",
      attachment.truncated ? "[preview truncated]" : "",
    ].filter(Boolean);
    return details.join("\n");
  });
  return [`TASK\n${task.task}`, attachments.length ? `INPUTS\n${attachments.join("\n\n")}` : "INPUTS\nNone"].join(
    "\n\n",
  );
}

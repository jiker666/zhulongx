import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { sanitizeSensitiveText } from "./sanitize.js";

/**
 * Deterministic attachment triage, borrowed from ARTEX's non-AI enrich layer:
 * the engine computes the boring-but-universal first observations (file type,
 * entropy, printable share, notable strings, leading bytes for unrecognized
 * data) before turn 1, so no run burns its opening turns re-deriving them.
 * No LLM calls; output is bounded and sanitized.
 */

export interface ArtifactTriage {
  name: string;
  bytes: number;
  sha256?: string;
  type: string;
  entropy: number;
  printableRatio: number;
  notableStrings: string[];
  headHex?: string;
}

const SAMPLE_BYTES = 64 * 1024;
const STRINGS_BYTES = 256 * 1024;
const MIN_STRING_RUN = 6;
const MAX_STRINGS_PER_FILE = 10;
const MAX_FILES = 20;

const NOTABLE_STRING = /flag\{|ctf\{|password|secret|token|api[-_]?key|https?:\/\/|\.(?:internal|local|com|net|org|io)\b|[A-Za-z]:\\|\.{0,2}\/[A-Za-z0-9_.-]{3,}/i;

function shannonEntropy(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer.readUInt8(index);
    counts[byte] = (counts[byte] ?? 0) + 1;
  }
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / buffer.length;
    entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 100) / 100;
}

function printableRatio(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) printable += 1;
  }
  return Math.round((printable / buffer.length) * 100) / 100;
}

function detectType(head: Buffer, printable: number): { type: string; headHex?: string } {
  const hex8 = (buffer: Buffer): string => buffer.subarray(0, 8).toString("hex");
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    const bits = head[4] === 2 ? "64-bit" : "32-bit";
    const endian = head[5] === 2 ? "big-endian" : "little-endian";
    const kind = head.length >= 18 ? ({ 1: "relocatable", 2: "executable", 3: "shared-object" } as Record<number, string>)[head.readUInt16LE(16)] ?? "elf" : "elf";
    return { type: `ELF ${bits} ${endian} (${kind})` };
  }
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return { type: "PE executable (MZ)" };
  if (head.length >= 4 && (head.readUInt32BE(0) === 0xfeedface || head.readUInt32BE(0) === 0xcefaedfe || head.readUInt32BE(0) === 0xfeedfacf || head.readUInt32BE(0) === 0xcffaedfe)) return { type: "Mach-O binary" };
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "PK\x03\x04") return { type: "zip archive" };
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return { type: "gzip stream" };
  if (head.length >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return { type: "tar archive" };
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return { type: "PDF document" };
  if (head.subarray(0, 4).toString("latin1") === "\x89PNG") return { type: "PNG image" };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { type: "JPEG image" };
  if (head.subarray(0, 6).toString("latin1") === "SQLITE") return { type: "SQLite database" };
  if (head.length >= 4 && (head.readUInt32LE(0) === 0xa1b2c3d4 || head.readUInt32BE(0) === 0xa1b2c3d4)) return { type: "pcap packet capture" };
  if (head.length >= 4 && head.readUInt32BE(0) === 0x0a0d0d0a) return { type: "pcapng packet capture" };
  if (printable >= 0.95) return { type: `text (printable ${(printable * 100).toFixed(0)}%)` };
  return { type: "unrecognized binary data", headHex: hex8(head) };
}

function extractNotableStrings(handle: import("node:fs/promises").FileHandle): Promise<string[]> {
  return (async () => {
    const strings: string[] = [];
    let offset = 0;
    outer: while (strings.length < 400 && offset < STRINGS_BYTES) {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, offset);
      if (bytesRead === 0) break;
      let run = "";
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        if (byte === undefined) break;
        if (byte >= 0x20 && byte <= 0x7e) {
          run += String.fromCharCode(byte);
        } else {
          if (run.length >= MIN_STRING_RUN) {
            if (NOTABLE_STRING.test(run)) strings.push(run.slice(0, 90));
            if (strings.length >= 400) break outer;
          }
          run = "";
        }
      }
      offset += bytesRead;
    }
    const notable = strings.filter((value, index) => strings.indexOf(value) === index);
    return notable.slice(0, MAX_STRINGS_PER_FILE);
  })();
}

export async function triageFile(input: { path: string; name?: string; sha256?: string }): Promise<ArtifactTriage | undefined> {
  try {
    const stats = await stat(input.path);
    if (!stats.isFile()) return undefined;
    const handle = await open(input.path, "r");
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(SAMPLE_BYTES), 0, SAMPLE_BYTES, 0);
      const sample = buffer.subarray(0, bytesRead);
      const printable = printableRatio(sample);
      const { type, headHex } = detectType(sample, printable);
      const notableStrings = printable >= 0.2 ? await extractNotableStrings(handle) : [];
      return {
        name: input.name ?? basename(input.path),
        bytes: stats.size,
        ...(input.sha256 ? { sha256: input.sha256.slice(0, 16) } : {}),
        type,
        entropy: shannonEntropy(sample),
        printableRatio: printable,
        notableStrings: notableStrings.map((value) => sanitizeSensitiveText(value)),
        ...(headHex ? { headHex } : {}),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function triageAttachments(files: Array<{ path: string; name?: string; sha256?: string }>): Promise<ArtifactTriage[]> {
  const results: ArtifactTriage[] = [];
  for (const file of files.slice(0, MAX_FILES)) {
    const triaged = await triageFile(file);
    if (triaged) results.push(triaged);
  }
  return results;
}

const PER_FILE_CHARS = 420;
const TOTAL_CHARS = 6_000;

export function renderTriageSection(results: ArtifactTriage[]): string {
  if (results.length === 0) return "";
  const lines = [
    "DETERMINISTIC ARTIFACT TRIAGE (engine-computed before turn 1; hashes, types, entropy, and notable strings — no model calls involved)",
    "Use as the starting inventory. It replaces the mechanical first pass, not your own precise measurements when they matter.",
  ];
  let total = lines.join("\n").length;
  for (const item of results) {
    const strings = item.notableStrings.length ? ` strings: ${item.notableStrings.join(" | ")}` : "";
    const head = item.headHex ? ` first8=${item.headHex}` : "";
    const line = `- ${item.name}: ${item.bytes}B, ${item.type}, entropy ${item.entropy}/8, printable ${(item.printableRatio * 100).toFixed(0)}%${item.sha256 ? `, sha256[:16]=${item.sha256}` : ""}${head}${strings}`;
    const bounded = line.slice(0, PER_FILE_CHARS);
    if (total + bounded.length > TOTAL_CHARS) break;
    lines.push(bounded);
    total += bounded.length;
  }
  return sanitizeSensitiveText(lines.join("\n"));
}

import { createHash, randomUUID } from "node:crypto";
import { sanitizeSensitiveText } from "./sanitize.js";

export type SharedEvidenceKind = "fact" | "candidate" | "dead-end";

export interface SharedEvidenceEntry {
  id: string;
  kind: SharedEvidenceKind;
  claim: string;
  evidence: string[];
  confidence: number;
  sourceRunIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishSharedEvidenceInput {
  kind: SharedEvidenceKind;
  claim: string;
  evidence: string[];
  confidence: number;
}

export interface SharedEvidencePublishResult {
  entry: SharedEvidenceEntry;
  deduplicated: boolean;
  evicted: number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_CLAIM_LENGTH = 600;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LENGTH = 600;
const MAX_SOURCE_RUNS = 8;

function boundedText(value: string, maximum: number): string {
  const sanitized = sanitizeSensitiveText(value).replace(/\s+/g, " ").trim();
  return sanitized.length <= maximum ? sanitized : `${sanitized.slice(0, maximum - 12)} [truncated]`;
}

function entrySignature(kind: SharedEvidenceKind, claim: string): string {
  return createHash("sha256").update(`${kind}:${claim.toLowerCase()}`).digest("hex").slice(0, 20);
}

function cloneEntry(entry: SharedEvidenceEntry): SharedEvidenceEntry {
  return {
    ...entry,
    evidence: [...entry.evidence],
    sourceRunIds: [...entry.sourceRunIds],
  };
}

export class SharedEvidenceBoard {
  private readonly entries: Array<SharedEvidenceEntry & { signature: string }> = [];

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("Shared evidence maxEntries must be positive");
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error("Shared evidence maxBytes must be at least 1024");
  }

  get size(): number {
    return this.entries.length;
  }

  publish(sourceRunId: string, input: PublishSharedEvidenceInput): SharedEvidencePublishResult {
    const claim = boundedText(input.claim, MAX_CLAIM_LENGTH);
    if (!claim) throw new Error("Shared evidence claim must not be empty");
    const evidence = [...new Set(input.evidence
      .map((item) => boundedText(item, MAX_EVIDENCE_LENGTH))
      .filter(Boolean))]
      .slice(0, MAX_EVIDENCE_ITEMS);
    if (evidence.length === 0) throw new Error("Shared evidence requires at least one evidence reference");
    const confidence = Math.max(0, Math.min(1, input.confidence));
    const signature = entrySignature(input.kind, claim);
    const existing = this.entries.find((entry) => entry.signature === signature);
    const now = new Date().toISOString();

    if (existing) {
      existing.evidence = [...new Set([...existing.evidence, ...evidence])].slice(0, MAX_EVIDENCE_ITEMS);
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.sourceRunIds = [...new Set([...existing.sourceRunIds, sourceRunId])].slice(-MAX_SOURCE_RUNS);
      existing.updatedAt = now;
      const evicted = this.enforceBounds();
      return { entry: cloneEntry(existing), deduplicated: true, evicted };
    }

    const entry: SharedEvidenceEntry & { signature: string } = {
      id: randomUUID(),
      signature,
      kind: input.kind,
      claim,
      evidence,
      confidence,
      sourceRunIds: [sourceRunId],
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    const evicted = this.enforceBounds();
    return { entry: cloneEntry(entry), deduplicated: false, evicted };
  }

  snapshot(limit = DEFAULT_MAX_ENTRIES, maxOutputBytes = DEFAULT_MAX_BYTES): {
    entries: SharedEvidenceEntry[];
    totalEntries: number;
    truncated: boolean;
  } {
    const maximum = Math.max(1, Math.min(DEFAULT_MAX_ENTRIES, Math.floor(limit)));
    const byteLimit = Math.max(1024, Math.min(this.maxBytes, Math.floor(maxOutputBytes)));
    const selected: SharedEvidenceEntry[] = [];
    let bytes = 2;
    for (const entry of this.entries.slice().reverse()) {
      if (selected.length >= maximum) break;
      const cloned = cloneEntry(entry);
      const entryBytes = Buffer.byteLength(JSON.stringify(cloned), "utf8") + 1;
      if (selected.length > 0 && bytes + entryBytes > byteLimit) break;
      if (entryBytes > byteLimit) continue;
      selected.push(cloned);
      bytes += entryBytes;
    }
    selected.reverse();
    return {
      entries: selected,
      totalEntries: this.entries.length,
      truncated: selected.length < this.entries.length,
    };
  }

  private enforceBounds(): number {
    let evicted = 0;
    while (this.entries.length > this.maxEntries || this.serializedBytes() > this.maxBytes) {
      this.entries.shift();
      evicted += 1;
    }
    return evicted;
  }

  private serializedBytes(): number {
    return Buffer.byteLength(JSON.stringify(this.entries), "utf8");
  }
}

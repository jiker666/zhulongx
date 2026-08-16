import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeSecrets } from "./sanitize.js";
import { inferTrajectorySource, type AuditEventMetadata } from "./session-trajectory.js";
import type { AuditRecord } from "./types.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface AuditValidation {
  valid: boolean;
  records: number;
  previousHash: string;
  error?: string;
}

function validateAuditContent(content: string, expectedRunId?: string): AuditValidation {
  const lines = content.split("\n").filter(Boolean);
  let previousHash = "0".repeat(64);
  let expectedSequence = 1;
  let chainRunId = expectedRunId;
  for (const line of lines) {
    let record: AuditRecord;
    try {
      record = JSON.parse(line) as AuditRecord;
    } catch {
      return { valid: false, records: expectedSequence - 1, previousHash, error: `invalid JSON at line ${expectedSequence}` };
    }
    const { hash, ...unsigned } = record;
    if (record.sequence !== expectedSequence) {
      return { valid: false, records: expectedSequence - 1, previousHash, error: `sequence mismatch at line ${expectedSequence}` };
    }
    chainRunId ??= record.runId;
    if (record.runId !== chainRunId) {
      return { valid: false, records: expectedSequence - 1, previousHash, error: `run id mismatch at line ${expectedSequence}` };
    }
    if (record.previousHash !== previousHash || hash !== digest(unsigned)) {
      return { valid: false, records: expectedSequence - 1, previousHash, error: `hash mismatch at line ${expectedSequence}` };
    }
    previousHash = hash;
    expectedSequence += 1;
  }
  return { valid: true, records: lines.length, previousHash };
}

export class AuditChain {
  readonly path: string;
  readonly runId: string;
  private sequence = 0;
  private previousHash = "0".repeat(64);
  private initialized = false;
  private queue = Promise.resolve();

  constructor(path: string, runId: string) {
    this.path = path;
    this.runId = runId;
  }

  async append(
    type: string,
    data: unknown | ((position: { sequence: number; previousSequence: number }) => unknown),
    metadata: AuditEventMetadata = {},
  ): Promise<AuditRecord> {
    let result!: AuditRecord;
    this.queue = this.queue.then(async () => {
      await this.initialize();
      const previousSequence = this.sequence;
      const sequence = previousSequence + 1;
      const value = typeof data === "function" ? data({ sequence, previousSequence }) : data;
      this.sequence = sequence;
      const unsigned = {
        sequence,
        timestamp: new Date().toISOString(),
        runId: this.runId,
        type,
        source: metadata.source ?? inferTrajectorySource(type),
        ...(metadata.actor ? { actor: String(sanitizeSecrets(metadata.actor)) } : {}),
        ...(metadata.correlationId ? { correlationId: String(sanitizeSecrets(metadata.correlationId)) } : {}),
        ...(metadata.parentSequence !== undefined ? { parentSequence: metadata.parentSequence } : {}),
        data: sanitizeSecrets(value),
        previousHash: this.previousHash,
      };
      result = { ...unsigned, hash: digest(unsigned) };
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(result)}\n`, "utf8");
      this.previousHash = result.hash;
    });
    await this.queue;
    return result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.initialized = true;
      return;
    }
    const validation = validateAuditContent(content, this.runId);
    if (!validation.valid) {
      throw new Error(`Cannot append to invalid audit chain: ${validation.error ?? "unknown integrity error"}`);
    }
    this.sequence = validation.records;
    this.previousHash = validation.previousHash;
    this.initialized = true;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

export async function verifyAuditChain(path: string): Promise<{ valid: boolean; records: number; error?: string }> {
  const content = await readFile(path, "utf8");
  const { previousHash: _previousHash, ...validation } = validateAuditContent(content);
  return validation;
}

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeSecrets } from "./sanitize.js";
import type { AuditRecord } from "./types.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AuditChain {
  readonly path: string;
  readonly runId: string;
  private sequence = 0;
  private previousHash = "0".repeat(64);
  private queue = Promise.resolve();

  constructor(path: string, runId: string) {
    this.path = path;
    this.runId = runId;
  }

  async append(type: string, data: unknown): Promise<AuditRecord> {
    let result!: AuditRecord;
    this.queue = this.queue.then(async () => {
      const unsigned = {
        sequence: ++this.sequence,
        timestamp: new Date().toISOString(),
        runId: this.runId,
        type,
        data: sanitizeSecrets(data),
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

  async flush(): Promise<void> {
    await this.queue;
  }
}

export async function verifyAuditChain(path: string): Promise<{ valid: boolean; records: number; error?: string }> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  let previousHash = "0".repeat(64);
  let expectedSequence = 1;
  for (const line of lines) {
    let record: AuditRecord;
    try {
      record = JSON.parse(line) as AuditRecord;
    } catch {
      return { valid: false, records: expectedSequence - 1, error: `invalid JSON at line ${expectedSequence}` };
    }
    const { hash, ...unsigned } = record;
    if (record.sequence !== expectedSequence) {
      return { valid: false, records: expectedSequence - 1, error: `sequence mismatch at line ${expectedSequence}` };
    }
    if (record.previousHash !== previousHash || hash !== digest(unsigned)) {
      return { valid: false, records: expectedSequence - 1, error: `hash mismatch at line ${expectedSequence}` };
    }
    previousHash = hash;
    expectedSequence += 1;
  }
  return { valid: true, records: lines.length };
}

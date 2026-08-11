import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_MANUAL_UPLOAD_FILES = 20;
export const MAX_MANUAL_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_MANUAL_UPLOAD_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_UPLOAD_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ManualUploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 = 400) {
    super(message);
    this.name = "ManualUploadError";
  }
}

export interface ManualUploadFile {
  id: string;
  name: string;
  size: number;
}

export interface ManualUploadSnapshot {
  id: string;
  files: ManualUploadFile[];
  totalBytes: number;
}

interface StoredManualUploadFile extends ManualUploadFile {
  path: string;
}

interface ManualUploadSession {
  id: string;
  directory: string;
  files: StoredManualUploadFile[];
  totalBytes: number;
  updatedAt: number;
  active: boolean;
  claimed: boolean;
}

export interface ManualUploadStoreOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
}

function validateFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.length > 240) {
    throw new ManualUploadError("Attachment filename is empty or too long");
  }
  if (/[/\\\u0000-\u001f\u007f]/.test(trimmed) || basename(trimmed) !== trimmed) {
    throw new ManualUploadError("Attachment filename must be a safe leaf name");
  }
  return trimmed;
}

function storedFileName(name: string, index: number): string {
  const safe = name
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return `${String(index + 1).padStart(2, "0")}-${randomUUID()}-${safe || "attachment.bin"}`;
}

export class ManualUploadStore {
  private readonly sessions = new Map<string, ManualUploadSession>();
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly root: string, options: ManualUploadStoreOptions = {}) {
    this.maxFiles = options.maxFiles ?? MAX_MANUAL_UPLOAD_FILES;
    this.maxFileBytes = options.maxFileBytes ?? MAX_MANUAL_UPLOAD_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_MANUAL_UPLOAD_TOTAL_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TTL_MS;
    this.cleanupTimer = setInterval(() => void this.cleanupExpired().catch(() => undefined), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  async save(
    source: Readable,
    input: { fileName: string; uploadId?: string; contentLength?: number },
    signal?: AbortSignal,
  ): Promise<ManualUploadSnapshot> {
    const fileName = validateFileName(input.fileName);
    if (input.contentLength !== undefined && (!Number.isInteger(input.contentLength) || input.contentLength < 0)) {
      throw new ManualUploadError("Content-Length must be a non-negative integer");
    }
    if (input.contentLength !== undefined && input.contentLength > this.maxFileBytes) {
      throw new ManualUploadError(`Attachment exceeds ${this.maxFileBytes} bytes`, 413);
    }

    const session = await this.openSession(input.uploadId);
    if (session.active) throw new ManualUploadError("Another file is already uploading to this batch", 409);
    if (session.claimed) throw new ManualUploadError("Upload batch has already been submitted", 409);
    if (session.files.length >= this.maxFiles) {
      throw new ManualUploadError(`An upload batch may contain at most ${this.maxFiles} files`, 413);
    }
    if (input.contentLength !== undefined && session.totalBytes + input.contentLength > this.maxTotalBytes) {
      throw new ManualUploadError(`Upload batch exceeds ${this.maxTotalBytes} bytes`, 413);
    }

    session.active = true;
    const target = join(session.directory, storedFileName(fileName, session.files.length));
    let size = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.maxFileBytes) {
          callback(new ManualUploadError(`Attachment exceeds ${this.maxFileBytes} bytes`, 413));
          return;
        }
        if (session.totalBytes + size > this.maxTotalBytes) {
          callback(new ManualUploadError(`Upload batch exceeds ${this.maxTotalBytes} bytes`, 413));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, limiter, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
      await chmod(target, 0o444);
      session.files.push({ id: randomUUID(), name: fileName, size, path: target });
      session.totalBytes += size;
      session.updatedAt = Date.now();
      return this.snapshot(session);
    } catch (error) {
      await rm(target, { force: true });
      if (session.files.length === 0) await this.removeSession(session);
      if (signal?.aborted) throw new ManualUploadError("Attachment upload was aborted");
      throw error;
    } finally {
      session.active = false;
    }
  }

  paths(id: string): string[] {
    const session = this.requireSession(id);
    if (session.active) throw new ManualUploadError("Attachment upload is still in progress", 409);
    if (session.claimed) throw new ManualUploadError("Upload batch has already been submitted", 409);
    if (session.files.length === 0) throw new ManualUploadError("Upload batch is empty");
    return session.files.map((file) => file.path);
  }

  claim(id: string): void {
    const session = this.requireSession(id);
    if (session.active) throw new ManualUploadError("Attachment upload is still in progress", 409);
    if (session.claimed) throw new ManualUploadError("Upload batch has already been submitted", 409);
    session.claimed = true;
    session.updatedAt = Date.now();
  }

  async release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await this.removeSession(session);
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.all([...this.sessions.values()].map(async (session) => await this.removeSession(session)));
  }

  private async openSession(id?: string): Promise<ManualUploadSession> {
    if (id) return this.requireSession(id);
    const sessionId = randomUUID();
    const directory = join(this.root, sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const session: ManualUploadSession = {
      id: sessionId,
      directory,
      files: [],
      totalBytes: 0,
      updatedAt: Date.now(),
      active: false,
      claimed: false,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private requireSession(id: string): ManualUploadSession {
    if (!UPLOAD_ID_PATTERN.test(id)) throw new ManualUploadError("Invalid upload batch id");
    const session = this.sessions.get(id);
    if (!session) throw new ManualUploadError("Upload batch not found or expired", 404);
    return session;
  }

  private snapshot(session: ManualUploadSession): ManualUploadSnapshot {
    return {
      id: session.id,
      files: session.files.map(({ id, name, size }) => ({ id, name, size })),
      totalBytes: session.totalBytes,
    };
  }

  private async cleanupExpired(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    const expired = [...this.sessions.values()].filter(
      (session) => !session.active && !session.claimed && session.updatedAt < cutoff,
    );
    await Promise.all(expired.map(async (session) => await this.removeSession(session)));
  }

  private async removeSession(session: ManualUploadSession): Promise<void> {
    this.sessions.delete(session.id);
    await rm(session.directory, { recursive: true, force: true });
  }
}

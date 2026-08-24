import { mkdir, lstat, open, opendir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isPathInside, resolveWorkspacePath } from "./policy.js";
import { SandboxClient, type SandboxExecRequest, type SandboxExecResult } from "./sandbox.js";

export type ExecutorKind = "sandbox" | "local" | "ssh" | "connector";
export type ExecutorRoot = "workspace" | "scratch";

export interface ExecutorPath {
  root: ExecutorRoot;
  path: string;
}

export interface ExecutorDirEntry {
  path: string;
  kind: "file" | "directory" | "other";
}

export interface ExecutorFileStat {
  path: string;
  size: number;
  kind: "file" | "directory" | "other";
  symbolicLink: boolean;
}

export interface ExecutorReadResult {
  path: string;
  bytes: Uint8Array;
  offset: number;
  totalBytes: number;
  truncated: boolean;
}

export interface ExecutorExecResult extends SandboxExecResult {
  startedAt: number;
  finishedAt: number;
}

export interface ExecutorHealth {
  status: "online" | "offline";
  kind: ExecutorKind;
  networkAccess: boolean;
  network: string;
  capabilities: string[];
  allowedPrograms: string[];
  missingPrograms: string[];
  pythonModules?: string[];
  missingPythonModules?: string[];
  detail?: string;
}

export interface Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly networkAccess: boolean;
  exec(input: SandboxExecRequest, signal?: AbortSignal): Promise<ExecutorExecResult>;
  readFile(path: ExecutorPath, options: { offset?: number; maxBytes: number }, signal?: AbortSignal): Promise<ExecutorReadResult>;
  readFileBytes(path: ExecutorPath, maxBytes: number, signal?: AbortSignal): Promise<ExecutorReadResult>;
  writeFile(path: ExecutorPath, data: Uint8Array, options: { append?: boolean; maxBytes: number }, signal?: AbortSignal): Promise<void>;
  listDir(path: ExecutorPath, options: { depth: number; maxEntries: number }, signal?: AbortSignal): Promise<ExecutorDirEntry[]>;
  stat(path: ExecutorPath, signal?: AbortSignal): Promise<ExecutorFileStat>;
  health(signal?: AbortSignal): Promise<ExecutorHealth>;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxExecutorOptions {
  id: string;
  socketPath: string;
  connectTimeoutMs: number;
  workspaceRoot: string;
  scratchRoot: string;
}

function fileKind(stats: { isFile(): boolean; isDirectory(): boolean }): ExecutorFileStat["kind"] {
  return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
}

export class SandboxExecutor implements Executor {
  readonly kind = "sandbox" as const;
  readonly networkAccess = false;
  readonly id: string;
  private readonly client: SandboxClient;

  constructor(private readonly options: SandboxExecutorOptions) {
    this.id = options.id;
    this.client = new SandboxClient(options.socketPath, options.connectTimeoutMs);
  }

  async exec(input: SandboxExecRequest, signal?: AbortSignal): Promise<ExecutorExecResult> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const result = await this.client.execute(input, signal);
    return { ...result, startedAt, finishedAt: Date.now() };
  }

  async readFile(path: ExecutorPath, options: { offset?: number; maxBytes: number }, signal?: AbortSignal): Promise<ExecutorReadResult> {
    signal?.throwIfAborted();
    const target = await this.resolveExisting(path);
    const stats = await lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Path is not a regular file");
    const offset = options.offset ?? 0;
    const length = Math.max(0, Math.min(options.maxBytes, Math.max(0, stats.size - offset)));
    const handle = await open(target, "r");
    let bytes: Uint8Array;
    try {
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, offset);
      bytes = buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    return {
      path: await this.relativePath(path.root, target),
      bytes,
      offset,
      totalBytes: stats.size,
      truncated: offset + bytes.length < stats.size,
    };
  }

  async readFileBytes(path: ExecutorPath, maxBytes: number, signal?: AbortSignal): Promise<ExecutorReadResult> {
    return await this.readFile(path, { offset: 0, maxBytes }, signal);
  }

  async writeFile(path: ExecutorPath, data: Uint8Array, options: { append?: boolean; maxBytes: number }, signal?: AbortSignal): Promise<void> {
    if (path.root !== "scratch") throw new Error("Executor writes are restricted to scratch");
    signal?.throwIfAborted();
    const root = this.root("scratch");
    await mkdir(root, { recursive: true });
    const target = resolveWorkspacePath(root, path.path);
    let existingSize = 0;
    try {
      const stats = await lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Scratch target is not a regular file");
      existingSize = stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (data.byteLength + (options.append ? existingSize : 0) > options.maxBytes) {
      throw new Error("Scratch file size budget exceeded");
    }
    await mkdir(dirname(target), { recursive: true });
    const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(target))]);
    if (!isPathInside(realRoot, realParent)) throw new Error("Scratch target parent escapes scratchRoot");
    signal?.throwIfAborted();
    await writeFile(target, data, { flag: options.append ? "a" : "w" });
  }

  async listDir(path: ExecutorPath, options: { depth: number; maxEntries: number }, signal?: AbortSignal): Promise<ExecutorDirEntry[]> {
    const start = await this.resolveExisting(path);
    const stats = await lstat(start);
    if (!stats.isDirectory()) return [{ path: await this.relativePath(path.root, start), kind: fileKind(stats) }];
    const canonicalRoot = await realpath(this.root(path.root));
    const result: ExecutorDirEntry[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }];
    while (queue.length > 0 && result.length < options.maxEntries) {
      signal?.throwIfAborted();
      const current = queue.shift();
      if (!current) break;
      for await (const item of await opendir(current.path)) {
        signal?.throwIfAborted();
        const absolute = resolve(current.path, item.name);
        const kind = item.isFile() ? "file" : item.isDirectory() ? "directory" : "other";
        result.push({ path: relative(canonicalRoot, absolute), kind });
        if (kind === "directory" && current.depth < options.depth) queue.push({ path: absolute, depth: current.depth + 1 });
        if (result.length >= options.maxEntries) break;
      }
    }
    return result;
  }

  async stat(path: ExecutorPath, signal?: AbortSignal): Promise<ExecutorFileStat> {
    signal?.throwIfAborted();
    const target = await this.resolveExisting(path);
    const stats = await lstat(target);
    return { path: await this.relativePath(path.root, target), size: stats.size, kind: fileKind(stats), symbolicLink: stats.isSymbolicLink() };
  }

  async health(signal?: AbortSignal): Promise<ExecutorHealth> {
    try {
      const health = await this.client.health(signal);
      return {
        status: "online",
        kind: this.kind,
        networkAccess: health.network !== "none",
        network: health.network,
        capabilities: ["structured-exec", "workspace-read", "scratch-read", "scratch-write", "abort"],
        allowedPrograms: [...health.allowedPrograms],
        missingPrograms: [...health.missingPrograms],
        pythonModules: [...(health.pythonModules ?? [])],
        missingPythonModules: [...(health.missingPythonModules ?? [])],
      };
    } catch (error) {
      return {
        status: "offline",
        kind: this.kind,
        networkAccess: false,
        network: "unknown",
        capabilities: ["workspace-read", "scratch-read", "scratch-write", "abort"],
        allowedPrograms: [],
        missingPrograms: [],
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async dispose(): Promise<void> {}

  private root(kind: ExecutorRoot): string {
    return kind === "workspace" ? this.options.workspaceRoot : this.options.scratchRoot;
  }

  private async relativePath(kind: ExecutorRoot, target: string): Promise<string> {
    return relative(await realpath(this.root(kind)), target);
  }

  private async resolveExisting(path: ExecutorPath): Promise<string> {
    if (isAbsolute(path.path)) throw new Error("Executor paths must be relative");
    const root = this.root(path.root);
    if (path.root === "scratch") await mkdir(root, { recursive: true });
    const lexical = resolveWorkspacePath(root, path.path);
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexical)]);
    if (!isPathInside(realRoot, realTarget)) throw new Error(`Resolved path escapes ${path.root}: ${path.path}`);
    return realTarget;
  }
}

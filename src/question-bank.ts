import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { AppConfig, TaskRequest } from "./types.js";

const MAX_LIST_BYTES = 256 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PROMPT_LENGTH = 8 * 1024;
const MAX_COMPOSE_FILES = 4;

const HIDDEN_COMPONENTS = new Set([
  ".git",
  ".github",
  "__pycache__",
  "metadata",
  "solution",
  "solutions",
  "writeup",
  "writeups",
  "answers",
  "answer",
  "secrets",
  "secret",
]);

function isReferenceFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (/^readme(?:\.|$)/i.test(name)) return true;
  return /(?:^|[-_.])(flag|answer|solution|solve|secret)(?:[-_.]|$)/i.test(lower);
}

function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function safeRelativePath(value: string, label: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return normalized;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 12)}\n[truncated]`;
}

function questionCategory(relativePath: string, listFile: string): string {
  const listStem = basename(listFile).replace(/\.[^.]+$/, "");
  const listParts = listStem.split(/[-_]+/).filter(Boolean);
  const listCategory = listParts.length > 1 ? listParts.at(-1) : undefined;
  if (listCategory && !["list", "tasks", "questions"].includes(listCategory.toLowerCase())) {
    return listCategory.toLowerCase();
  }
  const parts = relativePath.split("/").filter(Boolean);
  return parts.length > 1 ? (parts.at(-2) ?? "unknown").toLowerCase() : "unknown";
}

export interface QuestionBankQuestion {
  id: string;
  title: string;
  category: string;
  root: string;
  attachments: string[];
  fingerprint: string;
  prompt?: string;
  instance?: QuestionBankInstanceSpec;
}

export interface QuestionBankInstanceSpec {
  composeFile: string;
  service: string;
  containerPort: number;
  hostPort: number;
  externalNetworks: string[];
  buildContext?: string;
}

export interface QuestionBankQuestionSummary {
  id: string;
  title: string;
  category: string;
  attachmentCount: number;
  instanceAvailable?: boolean;
  status?: "pending" | "solved";
  solvedAt?: string;
}

export interface QuestionBankSnapshot {
  enabled: boolean;
  configured: boolean;
  root?: string;
  count: number;
  solvedCount?: number;
  pendingCount?: number;
  questions: QuestionBankQuestionSummary[];
  error?: string;
}

async function collectPublicFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    assertNotAborted(signal);
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertNotAborted(signal);
      if (entry.name.startsWith(".") || HIDDEN_COMPONENTS.has(entry.name.toLowerCase())) continue;
      const path = resolve(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!stats.isFile() || isReferenceFile(entry.name) || stats.size > MAX_ATTACHMENT_BYTES) continue;
      files.push(path);
      if (files.length >= MAX_ATTACHMENTS) return;
    }
  };
  await walk(root);
  return files.slice(0, MAX_ATTACHMENTS);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseTargetHost(value: unknown): { service: string; port: number } | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = value.trim().match(/^([A-Za-z0-9][A-Za-z0-9_.-]{0,127}):(\d{1,5})$/);
  if (!match?.[1] || !match[2]) return undefined;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? { service: match[1], port } : undefined;
}

async function loadPublicMetadata(
  questionRoot: string,
  signal?: AbortSignal,
): Promise<{ prompt?: string; target?: { service: string; port: number } }> {
  assertNotAborted(signal);
  const metadataPath = resolve(questionRoot, "metadata", "metadata.json");
  try {
    const stats = await lstat(metadataPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_METADATA_BYTES) return {};
    const value = objectRecord(JSON.parse(await readFile(metadataPath, "utf8")));
    if (!value) return {};
    const hardPrompt = typeof value.hard_prompt === "string" ? value.hard_prompt.trim() : "";
    const prompt = hardPrompt && hardPrompt.length <= MAX_PROMPT_LENGTH ? hardPrompt : undefined;
    const target = parseTargetHost(value.target_host);
    return { ...(prompt ? { prompt } : {}), ...(target ? { target } : {}) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

async function findComposeFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 2 || files.length >= MAX_COMPOSE_FILES) return;
    assertNotAborted(signal);
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || HIDDEN_COMPONENTS.has(entry.name.toLowerCase())) continue;
      const path = resolve(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await walk(path, depth + 1);
      } else if (
        stats.isFile() &&
        stats.size <= MAX_METADATA_BYTES &&
        /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/i.test(entry.name)
      ) {
        files.push(path);
      }
      if (files.length >= MAX_COMPOSE_FILES) return;
    }
  };
  await walk(root, 0);
  return files;
}

function numericPort(value: unknown): number | undefined {
  const port = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function publishedPort(value: unknown, containerPort: number): number | undefined {
  const record = objectRecord(value);
  if (record) {
    const target = numericPort(record.target);
    return target === containerPort ? numericPort(record.published) : undefined;
  }
  if (typeof value === "number") return value === containerPort ? value : undefined;
  if (typeof value !== "string") return undefined;
  const withoutProtocol = value.trim().replace(/\/(?:tcp|udp)$/i, "");
  const parts = withoutProtocol.split(":");
  if (parts.length === 1) return numericPort(parts[0]) === containerPort ? containerPort : undefined;
  const target = numericPort(parts.at(-1));
  return target === containerPort ? numericPort(parts.at(-2)) : undefined;
}

function externalNetworkNames(compose: Record<string, unknown>): string[] {
  const networks = objectRecord(compose.networks);
  if (!networks) return [];
  return Object.entries(networks).flatMap(([key, raw]) => {
    const network = objectRecord(raw);
    if (!network || network.external !== true) return [];
    return [typeof network.name === "string" && network.name.trim() ? network.name.trim() : key];
  });
}

function buildContextPath(composeFile: string, service: Record<string, unknown>): string | undefined {
  const build = service.build;
  const context = typeof build === "string" ? build : objectRecord(build)?.context;
  if (typeof context !== "string" || !context.trim()) return undefined;
  return resolve(dirname(composeFile), context);
}

async function loadInstanceSpec(
  questionRoot: string,
  target: { service: string; port: number } | undefined,
  signal?: AbortSignal,
): Promise<QuestionBankInstanceSpec | undefined> {
  if (!target) return undefined;
  for (const composeFile of await findComposeFiles(questionRoot, signal)) {
    assertNotAborted(signal);
    let compose: Record<string, unknown> | undefined;
    try {
      compose = objectRecord(parse(await readFile(composeFile, "utf8")));
    } catch {
      continue;
    }
    const services = objectRecord(compose?.services);
    const service = objectRecord(services?.[target.service]);
    const ports = service?.ports;
    if (!compose || !service || !Array.isArray(ports)) continue;
    const hostPort = ports.map((port) => publishedPort(port, target.port)).find((port) => port !== undefined);
    if (!hostPort) continue;
    const buildContext = buildContextPath(composeFile, service);
    return {
      composeFile,
      service: target.service,
      containerPort: target.port,
      hostPort,
      externalNetworks: externalNetworkNames(compose),
      ...(buildContext ? { buildContext } : {}),
    };
  }
  return undefined;
}

function questionTask(question: QuestionBankQuestion): string {
  return [
    `Analyze the authorized local security task "${question.title}" in category "${question.category}".`,
    "Use only the attached operator-provided materials and the scoped local tools.",
    "Establish the result with reproducible evidence; do not guess or read reference-answer material.",
    "If the evidence is insufficient or the task cannot be completed within the run budget, finish as blocked so the batch can mark this item skipped.",
    "When completed, finish the task with the exact final result and a concise verification summary.",
  ].join("\n");
}

async function questionFingerprint(root: string, attachments: string[], signal?: AbortSignal): Promise<string> {
  const materials: string[] = [];
  for (const attachment of attachments) {
    assertNotAborted(signal);
    const stats = await lstat(attachment);
    const path = relative(root, attachment).replaceAll("\\", "/");
    materials.push(`${path}\u0000${stats.size}\u0000${Math.trunc(stats.mtimeMs)}`);
  }
  return createHash("sha256").update(materials.sort().join("\n")).digest("hex");
}

export function questionToTaskRequest(
  question: QuestionBankQuestion,
  endpoint?: { host: string; port: number },
): TaskRequest {
  const serviceContext = endpoint
    ? `\nThe operator-started challenge instance is available at exactly ${endpoint.host}:${endpoint.port} for this run. This is the only authorized service endpoint; use scoped HTTP or TCP tools as the protocol requires.`
    : "";
  return {
    task: `${question.prompt ? `${question.prompt}\n\n` : ""}${questionTask(question)}${serviceContext}`,
    attachments: [...question.attachments],
    ...(endpoint ? { scope: { mode: "controlled", allowedHosts: [`${endpoint.host}:${endpoint.port}`] } } : {}),
    metadata: {
      source: "question-bank",
      questionId: question.id,
      category: question.category,
    },
  };
}

export class QuestionBank {
  constructor(private readonly config: AppConfig["questionBank"]) {}

  private rootPath(): string {
    if (!this.config?.enabled) throw new Error("Question bank is disabled");
    const configured = this.config.root ?? (this.config.rootEnv ? process.env[this.config.rootEnv] : undefined);
    if (!configured) {
      const name = this.config.rootEnv ?? "XUANSHU_QUESTION_BANK_ROOT";
      throw new Error(`Missing question-bank root in ${name}`);
    }
    return resolve(configured);
  }

  async load(signal?: AbortSignal): Promise<QuestionBankQuestion[]> {
    const root = this.rootPath();
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("Question-bank root must be a regular directory");
    const questions: QuestionBankQuestion[] = [];
    const seen = new Set<string>();
    for (const listFile of this.config?.listFiles ?? []) {
      assertNotAborted(signal);
      const listPath = resolve(root, safeRelativePath(listFile, "questionBank.listFiles"));
      if (!listPath.startsWith(`${root}${sep}`)) throw new Error("Question-bank list file escapes its root");
      const listStats = await lstat(listPath);
      if (!listStats.isFile() || listStats.size > MAX_LIST_BYTES) throw new Error(`Invalid question-bank list: ${listFile}`);
      const content = await readFile(listPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        assertNotAborted(signal);
        const candidate = line.replace(/(?:^|\s+)#.*$/, "").trim();
        if (!candidate) continue;
        const relativePath = safeRelativePath(candidate, "question-bank entry");
        if (seen.has(relativePath)) continue;
        const questionRoot = resolve(root, relativePath);
        if (!questionRoot.startsWith(`${root}${sep}`)) throw new Error("Question-bank entry escapes its root");
        const stats = await lstat(questionRoot);
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Question-bank entry is not a directory: ${relativePath}`);
        const attachments = await collectPublicFiles(questionRoot, signal);
        const metadata = await loadPublicMetadata(questionRoot, signal);
        const instance = await loadInstanceSpec(questionRoot, metadata.target, signal);
        const fingerprint = await questionFingerprint(questionRoot, attachments, signal);
        seen.add(relativePath);
        questions.push({
          id: relativePath,
          title: basename(questionRoot),
          category: questionCategory(relativePath, listFile),
          root: questionRoot,
          attachments,
          fingerprint,
          ...(metadata.prompt ? { prompt: metadata.prompt } : {}),
          ...(instance ? { instance } : {}),
        });
        if (questions.length >= (this.config?.maxQuestions ?? 20)) return questions;
      }
    }
    return questions;
  }

  async snapshot(signal?: AbortSignal): Promise<QuestionBankSnapshot> {
    const enabled = Boolean(this.config?.enabled);
    if (!enabled) return { enabled: false, configured: false, count: 0, questions: [] };
    try {
      const root = this.rootPath();
      const questions = await this.load(signal);
      return {
        enabled: true,
        configured: true,
        root,
        count: questions.length,
        questions: questions.map(({ id, title, category, attachments, instance }) => ({
          id,
          title,
          category,
          attachmentCount: attachments.length,
          instanceAvailable: Boolean(instance),
        })),
      };
    } catch (error) {
      return {
        enabled: true,
        configured: false,
        count: 0,
        questions: [],
        error: bounded(error instanceof Error ? error.message : String(error), 600),
      };
    }
  }
}

import { readFile } from "node:fs/promises";
import type { Executor } from "./executor.js";
import { sanitizeSensitiveText } from "./sanitize.js";
import type { NormalizedTask, VerificationVerdict } from "./types.js";

/**
 * Post-settlement replay verifier, adapted from ARTEX's retester agent: a run
 * that claims success must be re-executed, not re-read. The solver's own
 * verification commands (successful run_command calls whose output contained
 * the exact submission candidate) are replayed in the same sandbox namespace
 * with a fresh process. Verdicts follow the retester's three-way discipline:
 * reproduced / contradicted / unverifiable — a single historical observation
 * is never accepted as proof, and commands that no longer reproduce the
 * candidate contradict the completion claim.
 */

interface ReplaySource {
  toolCallId: string;
  program: string;
  args: string[];
  cwd?: "scratch" | "workspace";
  stdin?: string;
  stdinEncoding?: "utf8" | "base64";
}

const MAX_REPLAYS = 3;
/** Local-analysis categories: replaying their commands re-runs local
 * computation. Web/osint/ai-ml solves ride network tools, so replay would
 * re-issue remote requests — excluded unless the task opts in. */
const REPLAY_ELIGIBLE_CATEGORIES = new Set(["crypto", "reverse", "forensics", "malware", "misc", "pwn"]);

export function replayVerdictEligible(task: Pick<NormalizedTask, "metadata">): boolean {
  const override = task.metadata.verifier?.trim().toLowerCase();
  if (override === "off" || override === "false" || override === "no") return false;
  if (override === "on" || override === "force" || override === "replay") return true;
  const category = task.metadata.category?.trim().toLowerCase();
  if (!category) return true;
  return REPLAY_ELIGIBLE_CATEGORIES.has(category);
}

function commandOutputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Successful run_command calls whose output contained the exact candidate, newest last. */
export async function replayableVerificationCommands(auditPath: string, candidate: string): Promise<ReplaySource[]> {
  let raw: string;
  try {
    raw = await readFile(auditPath, "utf8");
  } catch {
    return [];
  }
  const needle = candidate.trim();
  if (!needle) return [];
  const sources: ReplaySource[] = [];
  for (const line of raw.split("\n")) {
    if (sources.length >= MAX_REPLAYS) break;
    if (!line.includes('"tool.result"')) continue;
    let record: { data?: unknown };
    try {
      record = JSON.parse(line) as { data?: unknown };
    } catch {
      continue;
    }
    const data = record.data;
    if (!data || typeof data !== "object") continue;
    const entry = data as {
      toolName?: unknown;
      isError?: unknown;
      args?: unknown;
      content?: unknown;
      toolCallId?: unknown;
    };
    if (entry.toolName !== "run_command" || entry.isError === true) continue;
    const args = entry.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    const request = args as {
      program?: unknown;
      args?: unknown;
      cwd?: unknown;
      stdin?: unknown;
      stdinEncoding?: unknown;
    };
    if (typeof request.program !== "string" || !Array.isArray(request.args) || request.args.some((item) => typeof item !== "string")) continue;
    if (!commandOutputText(entry.content).includes(needle)) continue;
    sources.push({
      toolCallId: typeof entry.toolCallId === "string" ? entry.toolCallId : "",
      program: request.program,
      args: request.args as string[],
      ...(request.cwd === "scratch" || request.cwd === "workspace" ? { cwd: request.cwd } : {}),
      ...(typeof request.stdin === "string" ? { stdin: request.stdin } : {}),
      ...(request.stdinEncoding === "utf8" || request.stdinEncoding === "base64" ? { stdinEncoding: request.stdinEncoding } : {}),
    });
  }
  return sources;
}

export async function replayVerifySubmission(input: {
  auditPath: string;
  candidate: string;
  exec: Executor["exec"];
  namespace?: string;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<VerificationVerdict> {
  const checkedAt = new Date().toISOString();
  const needle = input.candidate.trim();
  const sources = needle ? await replayableVerificationCommands(input.auditPath, needle) : [];
  if (sources.length === 0) {
    return {
      verdict: "unverifiable",
      evidence: [needle
        ? "No successful local run_command output contained the exact candidate; nothing deterministic to replay (typical for network-tool solves)."
        : "No submission candidate was declared; the replay verifier has nothing to test."],
      replayed: 0,
      checkedAt,
    };
  }
  const evidence: string[] = [];
  let reproduced = 0;
  let replayed = 0;
  for (const source of sources) {
    if (input.signal?.aborted) break;
    const rendered = [source.program, ...source.args].join(" ").slice(0, 120);
    try {
      const result = await input.exec({
        program: source.program,
        args: source.args,
        ...(input.namespace ? { namespace: input.namespace } : {}),
        cwd: source.cwd ?? "scratch",
        ...(source.stdin !== undefined ? { stdin: source.stdin, stdinEncoding: source.stdinEncoding ?? "utf8" } : {}),
        timeoutMs: input.commandTimeoutMs,
        maxOutputBytes: input.maxOutputBytes,
      }, input.signal);
      replayed += 1;
      const fresh = `${result.stdout}\n${result.stderr}`;
      const found = fresh.includes(needle);
      if (found) reproduced += 1;
      evidence.push(`replayed: ${rendered} -> exit=${result.exitCode}${result.timedOut ? " (timed out)" : ""}, candidate ${found ? "reproduced" : "absent"}`);
    } catch (error) {
      evidence.push(`replay failed: ${rendered} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const verdict: VerificationVerdict["verdict"] = replayed === 0
    ? "unverifiable"
    : reproduced > 0
      ? "reproduced"
      : "contradicted";
  return {
    verdict,
    evidence: evidence.map((item) => sanitizeSensitiveText(item).slice(0, 300)),
    replayed,
    checkedAt,
  };
}

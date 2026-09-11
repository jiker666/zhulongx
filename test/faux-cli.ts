import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/faux-claude-cli.mjs", import.meta.url));

export interface FauxCliLogEntry {
  dir: "in" | "out";
  msg: Record<string, unknown>;
}

export interface FauxCliHandle {
  /** Path to the executable faux CLI (pass via RuntimeOverrides.sdk.pathToClaudeCodeExecutable). */
  executablePath: string;
  scriptPath: string;
  logPath: string;
  /** Environment wiring (script/log/cursor) for a subprocess pointed at this fixture. */
  env: Record<string, string>;
  setScript(steps: unknown[]): Promise<void>;
  appendScript(step: unknown): Promise<void>;
  readScript(): Promise<unknown[]>;
  readLog(): Promise<FauxCliLogEntry[]>;
  receivedUserMessages(): Promise<unknown[]>;
  cleanup(): Promise<void>;
}

export interface RegisterFauxCliOptions {
  /**
   * Share one script cursor across every subprocess spawned against this
   * handle (session + single-shot retries consume the script sequentially)
   * instead of each subprocess replaying from step 0.
   */
  cursor?: boolean;
  /**
   * Make every scripted assistant step POST a synthetic Anthropic request to
   * ANTHROPIC_BASE_URL first, so the loopback model gateway produces
   * model.context / model.request_reserved records in faux runs.
   */
  gateway?: boolean;
}

let registrationCounter = 0;

/**
 * Register a faux Claude Code CLI. The executable copy is chmod'ed +x and the
 * script file is re-read by the CLI before every step, so setScript and
 * appendScript take effect even while a run is in flight.
 */
export async function registerFauxCli(script: unknown[] = [], options: RegisterFauxCliOptions = {}): Promise<FauxCliHandle> {
  registrationCounter += 1;
  const directory = await mkdtemp(join(tmpdir(), `xuan-faux-cli-${registrationCounter}-`));
  const executablePath = join(directory, "faux-claude-cli.mjs");
  await copyFile(FIXTURE_PATH, executablePath);
  await chmod(executablePath, 0o755);
  const scriptPath = join(directory, "script.json");
  const logPath = join(directory, "log.jsonl");
  const cursorPath = join(directory, "cursor.json");
  const fauxEnv = {
    XUANSHU_FAUX_CLI_SCRIPT: scriptPath,
    XUANSHU_FAUX_CLI_LOG: logPath,
    ...(options.cursor ? { XUANSHU_FAUX_CLI_CURSOR: cursorPath } : {}),
    ...(options.gateway ? { XUANSHU_FAUX_CLI_GATEWAY: "1" } : {}),
  };
  const writeScript = async (steps: unknown[]) => {
    await writeFile(scriptPath, JSON.stringify(steps), "utf8");
  };
  const readLog = async (): Promise<FauxCliLogEntry[]> => {
    try {
      const raw = await readFile(logPath, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as FauxCliLogEntry);
    } catch {
      return [];
    }
  };
  await writeScript(script);
  await mkdir(directory, { recursive: true });
  return {
    executablePath,
    scriptPath,
    logPath,
    /** Environment variables wiring a subprocess to this fixture instance. */
    env: fauxEnv,
    async setScript(steps) {
      await writeScript(steps);
    },
    async appendScript(step) {
      const current = JSON.parse(await readFile(scriptPath, "utf8")) as unknown[];
      await writeScript([...current, step]);
    },
    async readScript() {
      return JSON.parse(await readFile(scriptPath, "utf8")) as unknown[];
    },
    async readLog() {
      return readLog();
    },
    async receivedUserMessages() {
      const entries = await readLog();
      return entries.filter((entry) => entry.dir === "in" && entry.msg.type === "user").map((entry) => entry.msg);
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function assistantStep(content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "assistant", content, ...extra };
}

/** Assistant step issuing exactly one tool call; stop_reason defaults to tool_use. */
export function agentToolStep(id: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
  return assistantStep([toolUseBlock(id, name, input)]);
}

export function toolUseBlock(id: string, name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "tool_use", id, name, input };
}

export function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

export function successResult(result: string): Record<string, unknown> {
  return { type: "result", subtype: "success", result };
}

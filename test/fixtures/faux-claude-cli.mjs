#!/usr/bin/env node
// Faux Claude Code CLI for deterministic orchestration tests.
//
// Speaks the stream-json stdio protocol of the bundled CLI (SDK 0.3.x):
// NDJSON frames on stdout, NDJSON input on stdin, control_request/response
// handshake, MCP control frames answered by the SDK's in-process server.
// Behavior is driven by a JSON script file (XUANSHU_FAUX_CLI_SCRIPT) that is
// re-read before every step, so tests can rewrite or extend it mid-run. Every
// frame in both directions is appended as JSONL to XUANSHU_FAUX_CLI_LOG.
//
// Script step shapes:
//   { type: "assistant", content: [blocks], stopReason?: string,
//     streamEvent?: { delta: { stop_reason: string } } }
//   { type: "system", subtype: "compact_boundary", compactMetadata?: {...} }
//   { type: "system", subtype: "api_retry", attempt?, maxRetries?, retryDelayMs?, errorStatus? }
//   { type: "result", subtype?: "success" | "error_during_execution" | "error_max_turns",
//     isError?: boolean, result?: string, numTurns?: number, stopReason?: string,
//     errors?: string[] }
//   { type: "wait", ms: number } — pause before the next step (syncs subprocess spawn skew)
//   { type: "wait_log", dir: "in"|"out", msgType: string, subtype?: string, count: number } —
//     block until the shared log holds that many matching frames (syncs separate
//     subprocesses, e.g. converging two runs before their first model request)
//
// When XUANSHU_FAUX_CLI_GATEWAY=1 each assistant step first POSTs a synthetic
// Anthropic request to $ANTHROPIC_BASE_URL and awaits the response (usually a
// 502 from a dead upstream). This drives the model gateway so tests observe
// model.context / model.request_reserved / gate serialization authentically.
import readline from "node:readline";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const SESSION_ID = randomUUID();
const MCP_INIT_ID = 900;
const MCP_TOOLS_LIST_ID = 901;
let mcpRequestCounter = 901;
const mcpCallToolUseIds = new Map(); // mcp json-rpc id -> tool_use id
let stepIndex = 0;
let initialized = false;
const seenAssistantMessageIds = new Set();

const scriptPath = process.env.XUANSHU_FAUX_CLI_SCRIPT;
const logPath = process.env.XUANSHU_FAUX_CLI_LOG;
// Optional shared cursor: lets several subprocesses (e.g. session + writeup
// retries) consume one script sequentially instead of each replaying step 0.
const cursorPath = process.env.XUANSHU_FAUX_CLI_CURSOR;
if (cursorPath) {
  try {
    stepIndex = Number(JSON.parse(fs.readFileSync(cursorPath, "utf8")).step) || 0;
  } catch {
    stepIndex = 0;
  }
}
function persistCursor() {
  if (!cursorPath) return;
  try {
    fs.writeFileSync(cursorPath, JSON.stringify({ step: stepIndex }));
  } catch { /* cursor persistence is best-effort */ }
}

function send(frame) {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ dir: "out", msg: frame })}\n`);
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function readScript() {
  if (!scriptPath) return [];
  try {
    return JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  } catch {
    return [];
  }
}

// Admission probe against the loopback model gateway (opt-in via env). The
// gateway's upstream outcome is irrelevant to the scripted frames; only the
// gateway-side side effects (audit + gate serialization) matter.
async function gatewayProbe() {
  if (process.env.XUANSHU_FAUX_CLI_GATEWAY !== "1") return;
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!base) return;
  try {
    await fetch(`${base.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "faux-model",
        max_tokens: 64,
        messages: [{ role: "user", content: "faux gateway admission probe" }],
      }),
    });
  } catch { /* the upstream outcome never influences the scripted frames */ }
}

function countLoggedFrames(filter) {
  if (!logPath) return 0;
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.dir === filter.dir && entry.msg?.type === filter.msgType
        && (filter.subtype === undefined || entry.msg?.subtype === filter.subtype)) count += 1;
    } catch { /* partial tail lines from a concurrently writing sibling */ }
  }
  return count;
}

function betaMessage(content, stopReason) {
  const hasToolUse = content.some((block) => block && block.type === "tool_use");
  const resolved = stopReason === undefined ? (hasToolUse ? "tool_use" : "end_turn") : stopReason;
  return {
    id: `msg_${randomUUID().slice(0, 8)}`,
    type: "message",
    role: "assistant",
    model: "faux-model",
    content,
    stop_reason: resolved,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

async function emitAssistant(step) {
  await gatewayProbe();
  if (step.streamEvent) {
    send({ type: "stream_event", parent_tool_use_id: null, session_id: SESSION_ID, uuid: randomUUID(),
      event: { type: "message_delta", delta: { stop_reason: step.streamEvent.delta?.stop_reason ?? "max_tokens", usage: { output_tokens: 50 } } } });
  }
  const message = betaMessage(step.content, step.stopReason);
  send({ type: "assistant", parent_tool_use_id: null, session_id: SESSION_ID, uuid: randomUUID(), message });
  for (const block of step.content) {
    if (block && block.type === "tool_use") {
      mcpRequestCounter += 1;
      mcpCallToolUseIds.set(mcpRequestCounter, block.id);
      send({ type: "control_request", request_id: randomUUID(), request: {
        subtype: "mcp_message", server_name: "xuanshu",
        message: { jsonrpc: "2.0", id: mcpRequestCounter, method: "tools/call",
          params: { name: block.name.replace(/^mcp__xuanshu__/, ""), arguments: block.input ?? {}, _meta: { "claudecode/toolUseId": block.id } } },
      } });
    }
  }
}

function emitResult(step) {
  const subtype = step.subtype ?? "success";
  send({ type: "result", subtype, duration_ms: 100, duration_api_ms: 80,
    is_error: Boolean(step.isError ?? subtype !== "success"), num_turns: step.numTurns ?? 1,
    result: step.result ?? "", stop_reason: step.stopReason ?? "end_turn", total_cost_usd: 0,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], errors: step.errors ?? [],
    session_id: SESSION_ID, uuid: randomUUID() });
}

// Emit the next pending script steps. Stops after a result frame or after an
// assistant step that issued tool calls (the script resumes when the SDK
// answers the MCP call). Returns true when a result was emitted.
async function emitNextScripted() {
  const emitted = await emitNextScriptedInner();
  persistCursor();
  return emitted;
}

async function emitNextScriptedInner() {
  const script = readScript();
  while (stepIndex < script.length) {
    const step = script[stepIndex];
    stepIndex += 1;
    if (!step || typeof step !== "object") continue;
    if (step.type === "assistant") {
      await emitAssistant(step);
      if (step.content.some((block) => block && block.type === "tool_use")) return false;
      continue;
    }
    if (step.type === "wait") {
      await new Promise((resolve) => setTimeout(resolve, Math.min(Number(step.ms) || 0, 10_000)));
      continue;
    }
    if (step.type === "wait_log") {
      const filter = { dir: step.dir ?? "out", msgType: step.msgType, subtype: step.subtype };
      const want = Number(step.count) || 1;
      const deadline = Date.now() + Math.min(Number(step.timeoutMs) || 10_000, 20_000);
      while (countLoggedFrames(filter) < want && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      continue;
    }
    if (step.type === "system" && step.subtype === "compact_boundary") {
      send({ type: "system", subtype: "compact_boundary", session_id: SESSION_ID, uuid: randomUUID(),
        compact_metadata: { trigger: "auto", pre_tokens: 90_000, post_tokens: 30_000, ...(step.compactMetadata ?? {}) } });
      continue;
    }
    if (step.type === "system" && step.subtype === "api_retry") {
      send({ type: "system", subtype: "api_retry", session_id: SESSION_ID, uuid: randomUUID(),
        attempt: step.attempt ?? 1, max_retries: step.maxRetries ?? 3, retry_delay_ms: step.retryDelayMs ?? 4000,
        error_status: step.errorStatus ?? 429, error: { type: "api_error", message: step.errorMessage ?? "rate limited" } });
      continue;
    }
    if (step.type === "result") {
      emitResult(step);
      return true;
    }
  }
  return false;
}

const rl = readline.createInterface({ input: process.stdin });
// When the host configures no MCP servers, the SDK never answers our MCP
// initialize request; fall through to init after a short wait so single-shot
// (writeup-style) queries still work.
const MCP_INIT_FALLBACK_MS = 1_200;
let initFallbackTimer = null;
function sendInit(tools) {
  send({ type: "system", subtype: "init", apiKeySource: "none", claude_code_version: "2.1.268-faux",
    cwd: process.cwd(), tools, mcp_servers: tools.length ? [{ name: "xuanshu", status: "connected" }] : [],
    model: process.env.ANTHROPIC_MODEL ?? "faux-model", permissionMode: "dontAsk",
    session_id: SESSION_ID, uuid: randomUUID() });
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ dir: "in", msg })}\n`);
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [] } } });
    send({ type: "control_request", request_id: randomUUID(), request: { subtype: "mcp_message", server_name: "xuanshu",
      message: { jsonrpc: "2.0", id: MCP_INIT_ID, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "faux-claude", version: "0.0.0" } } } } });
    initFallbackTimer = setTimeout(() => {
      if (!initialized) {
        initialized = true;
        sendInit([]);
        void emitNextScripted().catch(() => {});
      }
    }, MCP_INIT_FALLBACK_MS);
    return;
  }
  if (msg.type === "control_response" && msg.response?.subtype === "success") {
    const inner = msg.response.response ?? {};
    const mcp = inner.mcp_response;
    if (mcp?.id === MCP_INIT_ID) {
      if (initFallbackTimer) clearTimeout(initFallbackTimer);
      send({ type: "control_request", request_id: randomUUID(), request: { subtype: "mcp_message", server_name: "xuanshu",
        message: { jsonrpc: "2.0", method: "notifications/initialized" } } });
      send({ type: "control_request", request_id: randomUUID(), request: { subtype: "mcp_message", server_name: "xuanshu",
        message: { jsonrpc: "2.0", id: MCP_TOOLS_LIST_ID, method: "tools/list" } } });
      return;
    }
    if (mcp?.id === MCP_TOOLS_LIST_ID) {
      const tools = (mcp.result?.tools ?? []).map((tool) => `mcp__xuanshu__${tool.name}`);
      sendInit(tools);
      initialized = true;
      void emitNextScripted().catch(() => {});
      return;
    }
    if (mcp && typeof mcp.id === "number" && mcpCallToolUseIds.has(mcp.id)) {
      const toolUseId = mcpCallToolUseIds.get(mcp.id);
      const result = mcp.result ?? { content: [] };
      send({ type: "user", parent_tool_use_id: null, session_id: SESSION_ID, uuid: randomUUID(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId,
          content: result.content ?? [], is_error: Boolean(result.isError) }] } });
      void emitNextScripted().catch(() => {});
      return;
    }
    return;
  }
  // Streaming input: each pushed user message starts a new turn. Advance the
  // script so injected recovery prompts produce scripted follow-up turns.
  if (initialized && msg.type === "user") {
    void emitNextScripted().catch(() => {});
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
rl.on("close", () => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ dir: "note", msg: { event: "stdin-closed" } })}\n`);
});
process.on("exit", (code) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ dir: "note", msg: { event: "process-exit", code } })}\n`);
});

#!/usr/bin/env node
// DASCTF CTF2 (ctf2.dasctf.com) practice-ground driver for 烛龙·玄枢.
// MCP-over-HTTP bridge: ctf2 agent tools <-> local xuanshu /v1 API.
// Runs CONCURRENTLY with the NSSCTF arena loop; both share the xuanshu API.
// Credentials come from .env (gitignored): CTF2_AGENT_TOKEN, XUANSHU_SERVER_TOKEN.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const WORK_DIR = resolve(ROOT, "workspace/ctf2");
const LOG_PATH = resolve(ROOT, ".xuan-shu/arena/ctf2-results.jsonl");
const MCP_BASE = process.env.CTF2_MCP_BASE ?? "https://ctf2.dasctf.com/api/ai/v1/mcp";
const XUANSHU_BASE = process.env.XUANSHU_BASE ?? "http://127.0.0.1:7318";

function loadEnvFile() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
loadEnvFile();

const CTF2_TOKEN = process.env.CTF2_AGENT_TOKEN;
const SERVER_TOKEN = process.env.XUANSHU_SERVER_TOKEN;

const die = (message) => { console.error(`[ctf2] ${message}`); process.exit(1); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- xuanshu API

async function xuanshu(path, options = {}, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${XUANSHU_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      ...(options.body ? { headers: { "content-type": "application/json", authorization: `Bearer ${SERVER_TOKEN}`, ...(options.headers ?? {}) } } : { headers: { authorization: `Bearer ${SERVER_TOKEN}` } }),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 800) }; }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// The gateway holds model settings session-scoped; re-assert each iteration so
// an API restart cannot silently break every run (same lesson as the arena).
async function ensureModel() {
  const apiKey = process.env.BIGMODEL_API_KEY;
  if (!apiKey) return;
  try {
    const result = await xuanshu("/v1/settings/model", {
      method: "POST",
      body: JSON.stringify({ modelId: process.env.ARENA_MODEL_ID ?? "glm-5.3", apiKey, baseUrl: process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic", reasoning: true }),
    });
    if (result.status >= 300) console.warn(`[ctf2] ensureModel -> ${result.status}`);
  } catch (error) {
    console.warn(`[ctf2] ensureModel failed (${error?.message ?? error})`);
  }
}

async function apiHealthy() {
  try {
    const probe = await xuanshu("/v1/settings/model");
    return probe.status < 500;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- MCP client

let mcpSession = null;
let mcpRequestId = 10;
// Per-lane counter of fast no-submission settles (infra-wall signature, see
// the settle guard in solveChallenge).
let fastFails = 0;

function parseMcpBody(raw) {
  try { return JSON.parse(raw); } catch { /* SSE framing */ }
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data: ")) {
      try { return JSON.parse(line.slice(6)); } catch { /* skip bad frame */ }
    }
  }
  throw new Error("unparseable MCP response");
}

async function mcpPost(payload, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(MCP_BASE, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${CTF2_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
      },
      body: JSON.stringify(payload),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) mcpSession = sessionId;
    const text = await response.text();
    if (response.status === 404 || response.status === 400) {
      // Session expired/invalid: drop it so the next call re-initializes.
      mcpSession = null;
      throw Object.assign(new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`), { sessionLost: true });
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after-ms") ?? 5_000);
      throw Object.assign(new Error("MCP rate limited"), { retryAfter });
    }
    return parseMcpBody(text);
  } finally {
    clearTimeout(timer);
  }
}

async function mcpInitialize() {
  const result = await mcpPost({
    jsonrpc: "2.0", id: mcpRequestId++,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "zhulongx-ctf2-driver", version: "1.0" } },
  });
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  return result;
}

async function mcpCall(name, args = {}) {
  if (!mcpSession) await mcpInitialize();
  try {
    const response = await mcpPost({ jsonrpc: "2.0", id: mcpRequestId++, method: "tools/call", params: { name, arguments: args } });
    if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
    const result = response.result ?? {};
    if (result.isError) {
      const structured = result.structuredContent ?? {};
      const err = new Error(`MCP tool error ${structured.code ?? "?"}: ${structured.message ?? JSON.stringify(result).slice(0, 200)}`);
      if (structured.retryable) err.retryAfter = Number(structured.retry_after_ms ?? 5_000);
      throw err;
    }
    const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* plain text result */ }
    // ctf2 wraps single resources in an envelope key ({"environment": {...}},
    // {"challenge": {...}}) — unwrap so callers see the resource directly.
    // ONLY singular-resource keys: "items"/"challenges" are the NATURAL shape
    // of list responses (next_challenges -> {"items": [...]}), and stripping
    // them turns the list into a bare array — every caller reading .items
    // then saw an empty recommendation set ("no eligible" forever).
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of ["environment", "challenge", "ground", "attachment", "url"]) {
        if (parsed[key] !== undefined) return parsed[key];
      }
    }
    return parsed ?? text;
  } catch (error) {
    if (error.sessionLost) {
      // One transparent retry after re-initialization; a second failure raises.
      if (!mcpSession) throw error;
      mcpSession = null;
      return mcpCall(name, args);
    }
    throw error;
  }
}

// ------------------------------------------------------------------ run ledger

async function record(entry) {
  await mkdir(resolve(LOG_PATH, ".."), { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// Local skip ledger: challenges already attempted (solved or twice-missed) so
// the loop always moves forward instead of re-attacking the same wall.
function ledgerPath() { return resolve(WORK_DIR, "ledger.json"); }
function readLedger() {
  try { return JSON.parse(readFileSync(ledgerPath(), "utf8")); } catch { return { done: {} }; }
}
function writeLedger(ledger) { writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2)); }
function ledgerMark(challengeId, status) {
  const ledger = readLedger();
  const prior = ledger.done[challengeId] ?? { misses: 0 };
  ledger.done[challengeId] = { ...prior, status, misses: prior.misses + (status === "miss" ? 1 : 0), at: new Date().toISOString() };
  writeLedger(ledger);
}
function ledgerMisses(challengeId) { return readLedger().done[challengeId]?.misses ?? 0; }

// Handoff carry across retries of the same challenge (arena-proven pattern).
function handoffPath(challengeId) { return resolve(WORK_DIR, `handoff-${challengeId}.json`); }
function handoffFor(challengeId) {
  try { return JSON.parse(readFileSync(handoffPath(challengeId), "utf8")); } catch { return null; }
}
// Rejected submissions persist per challenge: a warm retry that cannot see the
// burned values resubmits one verbatim and wastes the retry (arena-proven
// wrong-<id>.json pattern, ported for ctf2 after 传感器 rejected flag{FED31F...}
// and its retry inherited the value as "已验证" with no rejection warning).
function wrongPath(challengeId) { return resolve(WORK_DIR, `wrong-${challengeId}.json`); }
function rejectedValues(challengeId) {
  try {
    const raw = JSON.parse(readFileSync(wrongPath(challengeId), "utf8"));
    return Array.isArray(raw.values) ? raw.values.filter((v) => typeof v === "string") : [];
  } catch { return []; }
}
function recordRejected(challengeId, value) {
  const values = [...rejectedValues(challengeId), value].slice(-8);
  writeFileSync(wrongPath(challengeId), JSON.stringify({ challengeId, values, last: value, rejectedAt: new Date().toISOString() }, null, 2));
}
function writeHandoff(challengeId, payload) {
  const prior = handoffFor(challengeId);
  const dedupe = (items) => [...new Set(items)];
  const merged = {
    ...payload,
    findings: dedupe([...(prior?.findings ?? []), ...(payload.findings ?? [])]).slice(0, 8),
    nextSteps: dedupe([...(prior?.nextSteps ?? []), ...(payload.nextSteps ?? [])]).slice(0, 6),
    summary: payload.summary?.trim() ? payload.summary : (prior?.summary ?? ""),
    handoffText: payload.handoffText ?? prior?.handoffText,
  };
  writeFileSync(handoffPath(challengeId), JSON.stringify(merged, null, 2));
}

// ---------------------------------------------------------------- task builder

// Environment records expose their access point as access_url (a SINGLE
// string) and access_urls (an array of OBJECTS like {url, type, nc_ssl}) —
// returning the raw array made the task text interpolate "[object Object]"
// as the authorized target (WarmUp blocked after 41 turns hunting a URL the
// prompt never contained). Normalize every element to a plain string.
function envUrls(candidate) {
  const normalize = (entry) => {
    if (typeof entry === "string") return entry.trim() !== "" ? entry : null;
    if (entry && typeof entry === "object" && typeof entry.url === "string" && entry.url.trim() !== "") return entry.url;
    return null;
  };
  const raw = Array.isArray(candidate?.access_urls) ? candidate.access_urls
    : Array.isArray(candidate?.urls) ? candidate.urls
    : (typeof candidate?.access_url === "string" && candidate.access_url.trim() !== "" ? [candidate.access_url] : []);
  return raw.map(normalize).filter(Boolean);
}

function categoryOf(label) {
  const key = String(label ?? "").toLowerCase();
  const known = ["web", "crypto", "reverse", "pwn", "misc", "forensics"];
  return known.includes(key) ? key : "misc";
}

function buildTask(challenge, detail, env, annexFiles, budgetMinutes) {
  const lines = [];
  lines.push(`CTF2 平台(DASCTF)授权练习题(练习场:${challenge.practice_ground_name ?? "unknown"},类别:${challenge.category ?? "unknown"},难度:${challenge.difficulty ?? "?"})。以下是完整题面:`);
  const priorHandoff = handoffFor(challenge.id);
  if (priorHandoff) {
    lines.push("");
    lines.push("重要:这是续跑(前一轮遗留分析的延续)。严禁重新反汇编/重新下载/重新推导前一轮已验证的任何内容。开局直接读发现与遗留步骤,第一轮工具调用就该是增量实验。");
    if (priorHandoff.summary) lines.push(`前一轮总结:${priorHandoff.summary}`);
    for (const finding of priorHandoff.findings ?? []) lines.push(`- [已验证] ${finding}`);
    for (const step of priorHandoff.nextSteps ?? []) lines.push(`- [下一步] ${step}`);
    if (priorHandoff.handoffText) lines.push(`前一轮 handoff 原文:\n${priorHandoff.handoffText}`);
    lines.push("");
  }
  const rejectedList = rejectedValues(challenge.id);
  if (rejectedList.length > 0) {
    lines.push(`重要:以下值已在本题被平台判错(严禁原样重交任何一个,无论推导多确凿):${rejectedList.map((v) => `"${v}"`).join("、")}。若前轮推导已通过 artifact 级独立验证(重编码一致/校验和闭合/多条独立代码路径同值),则内容大概率正确、差异在包装或大小写形态。按序生成与已判错列表逐字符不同的候选并优先提交:(0)大小写变体(全小写/全大写);(1)去掉包装只交内部内容;(2)题面如指定其他包装则用之。每个候选提交前用工具输出逐字符确认,并对照已判错列表排除重复。`);
    lines.push("");
  }
  const body = typeof detail === "object"
    ? [detail.description ?? detail.content ?? detail.title, detail.hint].filter(Boolean).join("\n")
    : String(detail ?? "");
  lines.push(String(challenge.name ?? "").trim());
  lines.push(body.trim() || "(题面无更多文字,以附件/环境为准)");
  lines.push("");
  const urls = envUrls(env);
  if (env && urls.length > 0) {
    lines.push(`远程环境(本题唯一授权测试目标):${Array.isArray(urls) ? urls.join(", ") : urls}(环境剩余约 ${Math.round((env.remaining_seconds ?? env.remaining_minutes * 60 ?? 3600) / 60)} 分钟)。远程是脆弱的单实例:串行探测、最多 2 个连接、严禁并发扫描。续跑开局先发一个轻量请求确认存活,死亡则立即以 blocked 结束。`);
    lines.push("平台约定:重托管题的 flag 由平台生成、只存在于远程环境内;flag 必须实际从远程环境读取,网络 writeup 里的历史 flag 属于原比赛环境,不得采信或作为提交值。");
  } else if (env) {
    lines.push(`远程环境状态:${JSON.stringify(env).slice(0, 400)}`);
  }
  if (annexFiles.length > 0) lines.push(`附件(只读挂载):/workspace/input/ctf2/${challenge.id}/ 下有 ${annexFiles.join(", ")}`);
  lines.push("");
  if (budgetMinutes > 0) {
    lines.push(`时间预算:本次运行约 ${budgetMinutes} 分钟(超时会被强制中止,中止前未固化的推理即丢失)。按此预算规划路径深度:优先单条最高价值主线;临近预算时把已验证的关键值/中间结果用 record_finding 或 scratch 文件固化,便于续跑接手。`);
  }
  lines.push("目标:解出本题 flag,以题面或环境回显的实际格式逐字符提交,严禁大小写/拼写改写。要求:只测试本题给出的目标与附件;finish_task 的提交值必须来自成功工具输出且经独立验证,与验证输出逐字符一致;确实无法解出时以 blocked 结束,严禁伪造 flag。");
  return lines.join("\n");
}

// ------------------------------------------------------------------- main flow

async function fetchAttachment(name, signedUrl, dir) {
  const { basename } = await import("node:path");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream, statSync } = await import("node:fs");
  const fromPath = basename(new URL(signedUrl).pathname);
  // Signed download URLs end in a generic /download/ segment; keep the
  // platform-provided file name instead of that meaningless last segment.
  const target = resolve(dir, fromPath && !/^(download|file|files|get)$/i.test(fromPath) ? fromPath : (name || "annex.bin"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(signedUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
    if (statSync(target).size === 0) throw new Error("empty download");
    return basename(target);
  } finally {
    clearTimeout(timer);
  }
}

async function submitFlag(challenge, flag, detail) {
  const args = { practice_ground_id: challenge.practice_ground_id, challenge_id: challenge.id, flag, confirmation: true };
  const subFlagId = typeof detail === "object" ? detail?.suite?.sub_flag_id ?? detail?.sub_flag_id : undefined;
  if (subFlagId) args.sub_flag_id = subFlagId;
  const verdict = await mcpCall("ctf2_submit_flag", args);
  console.log(`[ctf2] submit verdict (${challenge.friendly_id ?? challenge.id}): ${JSON.stringify(verdict).slice(0, 400)}`);
  return verdict;
}

async function stopRun(runId) {
  const result = await xuanshu(`/v1/runs/${runId}/stop`, { method: "POST", body: "{}" });
  if (result.status >= 300) console.warn(`[ctf2] stop run ${runId} -> ${result.status}`);
}

async function watchRun(runId, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await sleep(20_000);
    let snapshot;
    try {
      snapshot = await xuanshu(`/v1/runs/${runId}`);
    } catch (error) {
      console.warn(`[ctf2] poll ${runId} failed (${error?.message ?? error}); continuing`);
      continue;
    }
    const status = snapshot.json?.status ?? snapshot.json?.state?.status;
    if (snapshot.status !== 200 || !status) continue;
    console.log(`[xuanshu] ${runId.slice(0, 8)} status=${status}`);
    if (["completed", "blocked", "failed", "aborted"].includes(status)) {
      const state = snapshot.json.state ?? snapshot.json ?? {};
      return state;
    }
  }
  return null;
}

// The agent owns exactly ONE environment slot. Track its holder in the local
// ledger so switching challenges destroys the old environment first (there is
// no global env query — only per-challenge get_environment).
async function ensureEnvironment(challenge, budgetMs) {
  const urls = envUrls;
  const ids = (target) => ({ practice_ground_id: target.practice_ground_id, challenge_id: target.id });
  const ledger = readLedger();
  const holder = ledger.currentEnvChallenge;
  if (holder && holder.id !== challenge.id) {
    console.log(`[ctf2] destroying held environment of ${holder.id} (single-slot policy)`);
    await mcpCall("ctf2_user_delete_practice_id_challenges_challengeid_environment", ids(holder)).catch((e) => console.warn(`[ctf2] destroy failed: ${e.message}`));
    ledger.currentEnvChallenge = null;
    writeLedger(ledger);
  }
  if (holder && holder.id === challenge.id) {
    const current = await mcpCall("ctf2_get_environment", ids(challenge)).catch(() => null);
    if (current && urls(current).length > 0) {
      if ((current.remaining_seconds ?? 3600) < 600) {
        await mcpCall("ctf2_extend_environment", ids(challenge)).catch(() => undefined);
      }
      return current;
    }
  }
  const started = await mcpCall("ctf2_start_challenge_environment", ids(challenge));
  ledger.currentEnvChallenge = { id: challenge.id, practice_ground_id: challenge.practice_ground_id };
  writeLedger(ledger);
  const waitDeadline = Date.now() + Math.min(budgetMs, 5 * 60_000);
  let env = started;
  while (Date.now() < waitDeadline) {
    if (env?.access_ready === true || urls(env).length > 0) return env;
    await sleep(10_000);
    env = await mcpCall("ctf2_get_environment", ids(challenge)).catch(() => env);
  }
  return env;
}

async function solveOne(challenge, options) {
  console.log(`[ctf2] challenge ${challenge.friendly_id ?? challenge.id} ${challenge.name} (${challenge.category} ${challenge.difficulty}, ${challenge.solve_count} solves)`);
  const detail = await mcpCall("ctf2_get_practice_challenge", { practice_ground_id: challenge.practice_ground_id, challenge_id: challenge.id });

  const dir = resolve(WORK_DIR, challenge.id);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "challenge.json"), JSON.stringify({ challenge, detail }, null, 2));

  const annexFiles = [];
  const attachments = typeof detail === "object" ? (detail.attachments ?? detail.files ?? []) : [];
  for (const attachment of attachments.slice(0, 6)) {
    // Attachment records carry no top-level name — the display name lives at
    // file.original_name (and file_name on the signed-URL response). Never
    // String() the raw object; that is how "[object Object]" leaked into logs.
    const name = attachment.file?.original_name ?? attachment.name ?? attachment.filename ?? attachment.file_name ?? attachment.id;
    const fileId = attachment.file_id ?? attachment.id;
    if (!fileId) continue;
    try {
      const signed = await mcpCall("ctf2_get_attachment_url", { practice_ground_id: challenge.practice_ground_id, challenge_id: challenge.id, file_id: fileId });
      const url = typeof signed === "object" ? (signed.url ?? signed.signed_url) : String(signed);
      const suggested = typeof signed === "object" && typeof signed.file_name === "string" ? signed.file_name : undefined;
      annexFiles.push(await fetchAttachment(name ?? suggested, url, dir));
    } catch (error) {
      console.warn(`[ctf2] attachment ${name} failed: ${error.message}`);
    }
  }

  const priorHandoff = handoffFor(challenge.id);
  const budgetMs = (priorHandoff ? 46 : 40) * 60_000;
  let env = null;
  if (challenge.has_container) env = await ensureEnvironment(challenge, budgetMs);
  if (challenge.has_container && env && envUrls(env).length === 0) {
    console.warn(`[ctf2] environment never became ready (${JSON.stringify(env).slice(0, 200)}); skipping challenge`);
    ledgerMark(challenge.id, "miss");
    return false;
  }

  const task = buildTask(challenge, detail, env, annexFiles, Math.round(budgetMs / 60_000));
  await writeFile(resolve(dir, "task.txt"), task);
  const attachmentPaths = annexFiles.map((name) => `/workspace/input/ctf2/${challenge.id}/${name}`);
  const created = await xuanshu("/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      task,
      attachments: attachmentPaths,
      ...(priorHandoff?.from ? { lineage: { parentRunId: priorHandoff.from } } : {}),
      metadata: { source: "question-bank", questionId: `ctf2-${challenge.id}`, category: categoryOf(challenge.category) },
    }),
  });
  if (created.status !== 202) die(`xuanshu run creation failed: ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`);
  const runId = created.json.id;
  const runStartedAt = Date.now();
  console.log(`[ctf2] xuanshu run ${runId} queued`);

  const terminal = await watchRun(runId, budgetMs);
  if (!terminal) {
    console.warn(`[ctf2] driver budget exhausted; stopping run ${runId}`);
    await stopRun(runId);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const handoff = (await xuanshu(`/v1/runs/${runId}/handoff`)).json;
        const text = handoff?.handoff ?? handoff?.data?.handoff;
        if (typeof text === "string" && text.trim() !== "") {
          writeHandoff(challenge.id, { from: runId, at: new Date().toISOString(), handoffText: text.slice(0, 4000) });
          break;
        }
      } catch { /* not written yet */ }
      await sleep(3_000);
    }
    await record({ challengeId: challenge.id, runId, name: challenge.name, outcome: "driver-timeout" });
    // Mark the miss or a too-hard challenge loops FOREVER: blocked settles and
    // driver timeouts never touched the ledger, so the candidate filter kept
    // re-picking the same challenge (only env failures and crashes marked).
    ledgerMark(challenge.id, "miss");
    return false;
  }

  const submission = terminal.submission ?? null;
  const findings = (Array.isArray(terminal.findings) ? terminal.findings : []).map((f) => (typeof f === "string" ? f : `${f.title ?? ""}: ${f.description ?? ""}`.trim()).slice(0, 600)).filter(Boolean).slice(0, 8);
  const nextSteps = (Array.isArray(terminal.nextSteps) ? terminal.nextSteps : []).filter((s) => typeof s === "string").map((s) => s.slice(0, 400)).slice(0, 6);
  writeHandoff(challenge.id, { from: runId, at: new Date().toISOString(), summary: String(terminal.summary ?? "").slice(0, 1200), findings, nextSteps });

  if (terminal.status === "completed" && submission && !/wrote \d+ bytes|permission denied/i.test(submission)) {
    const verdict = await submitFlag(challenge, submission, detail);
    // ctf2 verdict keys are accepted/is_solved (WarmUp solved but was ledger-
    // marked miss because the check read correct/solved/is_correct instead).
    const solved = typeof verdict === "object" && (verdict.accepted === true || verdict.is_solved === true || verdict.correct === true || verdict.is_correct === true);
    fastFails = 0; // any real submit outcome clears the infra-wall signature
    if (!solved) recordRejected(challenge.id, submission);
    await record({ challengeId: challenge.id, runId, name: challenge.name, outcome: "submitted", submission, verdict });
    ledgerMark(challenge.id, solved ? "solved" : "miss");
    if (solved) {
      const { rmSync } = await import("node:fs");
      try { rmSync(handoffPath(challenge.id), { force: true }); } catch { /* best effort */ }
      try { rmSync(wrongPath(challenge.id), { force: true }); } catch { /* best effort */ }
      await mcpCall("ctf2_agent_log_note", { challenge_id: challenge.id, kind: "result", content: `solved by zhulongx run ${runId}` }).catch(() => undefined);
      return true;
    }
    console.warn(`[ctf2] submission rejected for ${challenge.friendly_id ?? challenge.id}`);
    return false;
  }

  console.log(`[ctf2] run settled as ${terminal.status} without a submission`);
  await record({ challengeId: challenge.id, runId, name: challenge.name, outcome: terminal.status });
  // A settle inside 5 minutes without a submission is an infra suspect (model
  // quota wall / outage — the agent never got a real look), not a capability
  // miss. Miss caps are capability budgets; burning them on infra failures
  // starves the pool (TSec quota wall 2026-10-09 capped five healthy
  // challenges before the lane-level backoff landed).
  if (Date.now() - runStartedAt < 5 * 60_000) {
    fastFails += 1;
    console.warn(`[ctf2] fast no-submission settle (${fastFails}/3) — infra suspect, miss NOT counted`);
    if (fastFails >= 3) throw Object.assign(new Error("suspected infra wall (quota/model)"), { infraWall: true });
    return false;
  }
  ledgerMark(challenge.id, "miss");
  return false;
}

// Full unsolved pool across practice grounds, cached 10 min. The
// recommendation feed ranks by sort_order and surfaces 1-point items first —
// the whole 2026-10-04..08 idle was 10 recommendation-locked challenges at
// miss-cap while ~3.6k untouched items sat in the grounds (user directive
// 2026-10-08: grind points, so enumerate and pick by value ourselves).
let poolCache = { at: 0, items: [] };

async function poolChallenges() {
  if (poolCache.items.length > 0 && Date.now() - poolCache.at < 10 * 60_000) return poolCache.items;
  const grounds = await mcpCall("ctf2_list_practice_grounds", { limit: 50 });
  const groundItems = grounds?.items ?? grounds?.grounds ?? (Array.isArray(grounds) ? grounds : []);
  const pool = [];
  for (const ground of groundItems) {
    for (let page = 1; page <= 40; page++) {
      let list;
      try {
        list = await mcpCall("ctf2_list_practice_challenges", { practice_ground_id: ground.id, unsolved_only: true, limit: 100, page });
      } catch (error) {
        if (error.retryAfter) await sleep(error.retryAfter + 1_000);
        else console.warn(`[ctf2] pool page ${ground.name}#${page} failed (${error.message}); continuing with partial pool`);
        break;
      }
      const items = Array.isArray(list?.items) ? list.items : [];
      if (items.length === 0) break;
      pool.push(...items);
      if ((list.total_page && page >= list.total_page) || items.length < 100) break;
      await sleep(400); // stay well under the 120 reads/min quota
    }
  }
  if (pool.length > 0) poolCache = { at: Date.now(), items: pool };
  return pool;
}

// Difficulty rank for the equal-points tie-break: converting an Easy 100-pointer
// first banks the same points with the best odds per hour.
const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 };
const byValue = (a, b) => ((b.points ?? 0) - (a.points ?? 0))
  || ((DIFFICULTY_RANK[String(a.difficulty ?? "").toLowerCase()] ?? 3) - (DIFFICULTY_RANK[String(b.difficulty ?? "").toLowerCase()] ?? 3))
  || ((b.solve_count ?? 0) - (a.solve_count ?? 0));

function pickByPoints(items, ledger) {
  return items
    .filter((item) => !item.is_solved
      && (ledger.done[item.id]?.status !== "solved")
      && (ledger.done[item.id]?.misses ?? 0) < (handoffFor(item.id) ? 2 : 1))
    .sort(byValue)[0] ?? null;
}

async function cmdLoop(options) {
  if (!CTF2_TOKEN) die("CTF2_AGENT_TOKEN missing in .env");
  if (!SERVER_TOKEN) die("XUANSHU_SERVER_TOKEN missing in .env");
  let consecutiveMisses = 0;
  // Stamp at iteration END — one iteration CONTAINS a whole 40-46min solveOne,
  // so an iteration-top stamp makes every healthy solve look like a freeze
  // (arena driver burned ~1min of probes+settle per run on this false alarm).
  let lastIterationAt = Date.now();
  while (true) {
    const iterationStart = Date.now();
    // Freeze guard: a multi-minute wall-time jump means the host (or VM) was
    // suspended — the NSSCTF collapse of Oct 1-3 burned ~100 attempts in
    // wake/sleep cycles. After a freeze, verify the full stack is stable
    // before burning any platform quota.
    if (iterationStart - lastIterationAt > 15 * 60_000) {
      console.warn(`[ctf2] wall-clock jump of ${Math.round((iterationStart - lastIterationAt) / 60_000)} min detected — freeze/sleep recovery; verifying stack stability`);
      for (let probe = 0; probe < 6; probe++) {
        if (await apiHealthy()) break;
        console.warn("[ctf2] API not healthy after freeze; waiting 60s");
        await sleep(60_000);
      }
      await sleep(60_000); // one stability minute before touching the platform
    }
    try {

    if (consecutiveMisses >= 4) {
      console.warn("[ctf2] four challenges missed in a row — pausing 10 minutes");
      await sleep(600_000);
      consecutiveMisses = 0;
    }
    if (!(await apiHealthy())) {
      console.warn(`[ctf2] ${new Date().toISOString()} xuanshu API unreachable — holding (fetching would only waste quota); retrying in 60s`);
      await sleep(60_000);
      continue;
    }
    await ensureModel();

    let next = null;
    try {
      next = await mcpCall("ctf2_agent_next_challenges", {});
    } catch (error) {
      if (error.retryAfter) { console.warn(`[ctf2] rate limited; waiting ${error.retryAfter + 1000}ms`); await sleep(error.retryAfter + 1_000); continue; }
      console.warn(`[ctf2] next_challenges failed (${error.message}); continuing without recommendations`);
    }
    // Prefer our own pool scan (points-first) over the sort_order-ranked
    // recommendation feed; keep the feed as a fallback when the pool call dies.
    let items;
    try {
      items = await poolChallenges();
    } catch (error) {
      console.warn(`[ctf2] pool scan failed (${error.message}); falling back to recommendations`);
      items = [];
    }
    if (items.length === 0) {
      // Defensive: accept a bare array too (any future envelope change).
      items = (Array.isArray(next) ? next : (next?.items ?? next?.challenges ?? [])).filter((item) => !item.is_solved);
    }
    const ledger = readLedger();
    const candidate = pickByPoints(items, ledger);
    if (!candidate) {
      console.log(`[ctf2] no eligible challenge (pool=${items.length} ledgerEntries=${Object.keys(ledger.done).length}); waiting 5 minutes`);
      await sleep(300_000);
      continue;
    }
    try {
      const solved = await solveOne(candidate, options);
      consecutiveMisses = solved ? 0 : consecutiveMisses + 1;
    } catch (error) {
      if (error.retryAfter) {
        console.warn(`[ctf2] rate limited mid-challenge; waiting ${error.retryAfter + 1000}ms`);
        await sleep(error.retryAfter + 1_000);
      } else if (error.infraWall) {
        // Three fast no-submission settles in a row = quota/model wall; back
        // off long enough to cross a refresh boundary instead of burning
        // short runs against it (TSec 2026-10-09 lesson).
        console.warn("[ctf2] suspected infra wall — pausing loop 15 minutes");
        fastFails = 0;
        consecutiveMisses = 0;
        await sleep(15 * 60_000);
      } else {
        console.warn(`[ctf2] solveOne crashed: ${error?.message ?? error}; pausing 60s`);
        ledgerMark(candidate.id, "miss");
        await sleep(60_000);
      }
    }
    await sleep(10_000);
    } finally {
      lastIterationAt = Date.now();
    }
  }
}

async function main() {
  const [command] = process.argv.slice(2);
  const options = {};
  switch (command) {
    case "loop": return cmdLoop(options);
    case "whoami": {
      const profile = await mcpCall("ctf2_agent_whoami", {});
      console.log(JSON.stringify(profile, null, 2));
      return 0;
    }
    case "next": {
      const next = await mcpCall("ctf2_agent_next_challenges", {});
      console.log(JSON.stringify(next, null, 2));
      return 0;
    }
    case "pool": {
      const pool = await poolChallenges();
      const ledger = readLedger();
      const ranked = pool
        .filter((item) => !item.is_solved)
        .sort(byValue);
      for (const item of ranked.slice(0, 20)) {
        const done = ledger.done[item.id];
        console.log(`${String(item.points ?? 0).padStart(3)}pts ${String(item.solve_count ?? 0).padStart(4)}solves ${item.category}/${item.difficulty} ${item.friendly_id} ${item.name} container=${item.has_container}${done ? ` ledger=${done.status}/${done.misses ?? 0}` : ""}`);
      }
      console.log(`pool=${pool.length}`);
      return 0;
    }
    case "env": {
      // Requires a challenge context; report the ledger-held slot instead.
      const ledger = readLedger();
      console.log(JSON.stringify(ledger.currentEnvChallenge ?? { holder: null }, null, 2));
      return 0;
    }
    default:
      console.log("Usage:\n  node tools/arena/ctf2.mjs loop\n  node tools/arena/ctf2.mjs whoami\n  node tools/arena/ctf2.mjs next\n  node tools/arena/ctf2.mjs pool\n  node tools/arena/ctf2.mjs env");
      return command ? 1 : 0;
  }
}

process.exit(await main());

#!/usr/bin/env node
// TSec Benchmark Platform (TSecBench 跑分任务) driver for 烛龙·玄枢.
// Plain REST client (BENCHMARK_TOKEN header) <-> local xuanshu /v1 API.
// Runs concurrently with the NSSCTF/CTF2 loops; all share the xuanshu API.
// Credentials come from .env (gitignored): TSEC_BASE_URL + TSEC_TOKEN
// (both issued when the benchmark task is created on TSecBench).
//
// Platform quirks (CHALLENGES_API doc, 2026-10-09):
//  - Every challenge entry address (container_addr, e.g. 10.0.1.5:8080) is
//    VPN-only: the SSLVPN handed out with the task must be connected on THIS
//    host before any run is started, or the sandbox cannot reach the target.
//  - Max 3 concurrently active challenge instances; /start past that (or after
//    the task's total time limit) returns 409 invalid_state. The SAME error
//    code means "task ended" on every other endpoint, so classify by message.
//  - Multi-flag challenges: submit repeatedly until correct_flag_count ==
//    flag_count; the loop re-runs with handoff for each remaining flag.
//  - Wrong submissions carry NO penalty (user 2026-10-10). The task text
//    hands the agent the submit endpoint + token: every remote-read verified
//    flag is self-submitted for instant authoritative feedback (correct/
//    duplicate/wrong), with same-run variant retries on wrong. Driver-side
//    submission of finish_task's value and VERIFIED_FLAG findings remains as
//    the fallback gate.
//  - Re-submitting an already-correct flag returns 409 duplicate — idempotent
//    protection, NOT a rejection; never record it as a wrong value.
//  - Hints deduct score (hint_cost_ratio, charged on view). Policy (user
//    2026-10-10: 难题有必要拿 hint): the loop auto-pulls a hint at the deep
//    tier — 2 misses cold, or 1 miss on a warm challenge (round-1 stragglers
//    already proved hard) — caches it, and injects it into every later task
//    build. Fresh/easy challenges stay hint-free and full-score.
//  - Past the task time limit every endpoint returns invalid_state; the loop
//    then exits instead of spinning.
//
// Round-3 post-mortem (2026-10-11, 15/37, 5850/22210):
//  - Attempt>=3 on single-flag challenges went 0/14 — pure waste. The
//    hint-cap-4 came from R2 PARTIAL CHAINS (banked flags = sunk cost); for
//    singles the cap is 2, or 3 with a pulled hint. Chains keep 4.
//  - Hard singles were starved at 35-40min while every board showed
//    "one step from flag" timeouts (R2 hard chains converted at 46/60).
//    Hard singles now use the deep ladder: 46, then 60 after 2 misses.
// R20 (29896 post-mortem, 10-14): settle paths are leak-proofed (hardened
//    stops, isolated hint pulls, retried closes), a per-code watch registry +
//    slot watchdog reclaims orphaned containers, wall-time-stuck challenges
//    arm hints/rescue like a miss (exploration deadlock), fresh-eyes retries
//    drop inherited dead-end context, polls use the light /lite shape, and
//    driver flag relays stop on solved codes.
//  - The warm-before-fresh priority left fresh hards untouched for hours
//    (a high-value quick win sat untouched for
//    hours while retries went 0/14). Two counter-forces now: role "prospector" (fresh
//    opens only) and forced fresh after 2 consecutive retry misses.
//  - Per-run scratch wipes taxed every retry ("OCR 工件已随 scratch 清空丢失,
//    需重建" — three failed challenges rebuilt toolchains each attempt). The
//    runtime already supports lineage.parentRunId scratch inheritance; the
//    driver now threads the last run id of the same challenge into retries.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const WORK_DIR = resolve(ROOT, "workspace/tsec");
const LOG_PATH = resolve(ROOT, ".xuan-shu/arena/tsec-results.jsonl");
// Fresh containers boot without workspace/tsec (the hosted entrypoint only
// mkdirs /app/workspace): claimCode's exclusive write would ENOENT, surface
// as "lost the race", and every lane crash-loops already_claimed without a
// single claim file ever existing (bctf-2026 hosted, 17:39 boot).
mkdirSync(WORK_DIR, { recursive: true });
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

const BASE = (process.env.TSEC_BASE_URL ?? process.env.BENCHMARK_BASE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.TSEC_TOKEN ?? process.env.BENCHMARK_TOKEN;
const SERVER_TOKEN = process.env.XUANSHU_SERVER_TOKEN;

const die = (message) => { console.error(`[tsec] ${message}`); process.exit(1); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- TSec client

async function api(path, { method = "GET", body, query } = {}, timeoutMs = 30_000) {
  if (!BASE || !TOKEN) die("TSEC_BASE_URL / TSEC_TOKEN missing in .env (issued when the TSecBench task is created)");
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
  // One-shot 10h final: transient network/5xx/429 blips must never drop a
  // submission or wedge a lane. 4 attempts, ~0.75s/2.25s/6.75s(+jitter) backoff;
  // 4xx (auth/invalid-state/duplicate semantics) stays a single immediate
  // failure so the 409 classifier above keeps its meaning.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: { BENCHMARK_TOKEN: TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
      if (response.status >= 300) {
        const error = new Error(`TSec HTTP ${response.status}: ${json.code ?? "?"} ${json.message ?? text.slice(0, 200)}`);
        error.status = response.status;
        error.code = json.code;
        error.apiMessage = json.message ?? "";
        throw error;
      }
      return json;
    } catch (error) {
      const status = error?.status;
      const retriable = status === undefined || status === 429 || status >= 500;
      if (!retriable || attempt >= MAX_ATTEMPTS) throw error;
      console.warn(`[tsec] ${path} attempt ${attempt} failed (${error?.message ?? error}); retrying`);
      await sleep(750 * 3 ** (attempt - 1) + Math.random() * 400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`TSec ${path}: exhausted ${MAX_ATTEMPTS} attempts`);
}

// 409 invalid_state is overloaded: on /start it means the 3-slot limit, on
// every endpoint it also means the task ended. Distinguish by message wording.
const isTaskEnded = (error) => error.status === 409 && error.code === "invalid_state"
  && !/上限|活跃|最多|数量|limit|maximum/i.test(String(error.apiMessage ?? ""));
const isSlotLimit = (error) => error.status === 409 && error.code === "invalid_state"
  && /上限|活跃|最多|数量|limit|maximum|max active|instances reached|close an existing/i.test(String(error.apiMessage ?? ""));
const isDuplicate = (error) => error.status === 409 && error.code === "duplicate";

async function listChallenges() {
  const items = await api("/openapi/v1/challenges");
  return Array.isArray(items) ? items : (items?.items ?? items?.challenges ?? []);
}

async function closeChallenge(code) {
  try {
    const result = await api("/openapi/v1/challenges/close", { method: "POST", query: { unique_code: code } });
    console.log(`[tsec] close ${code}: ${JSON.stringify(result)}`);
    return true;
  } catch (error) {
    console.warn(`[tsec] close ${code} failed: ${error.message}`);
    return false;
  }
}

async function submitFlag(code, flag) {
  // R20: once the platform confirmed every flag, a late driver relay (e.g. a
  // finish_task value still settling when the correct answer landed) is pure
  // noise — 29896 logged post-solve wrongs on two challenges this way.
  const done = readLedger().done[code];
  if (done?.status === "solved") {
    console.log(`[tsec] ${code} already solved — dropping driver relay of "${String(flag).slice(0, 24)}"`);
    // Shape it like a fully-banked submit so the relay's verdict handling
    // settles idempotently instead of misreading undefined counters.
    const progress = done.progress ?? 0;
    return { skipped: true, correct: true, correct_flag_count: progress, total_flag_count: progress };
  }
  return api("/openapi/v1/challenges/submit", { method: "POST", body: { unique_code: code, flag } });
}

// ---------------------------------------------------------------- xuanshu API

async function xuanshu(path, options = {}, timeoutMs = 45_000, retries = 1) {
  // R20: idempotent xuanshu calls (polls, stops, handoff reads) retry once on
  // transient failure — 29896's slot leak was a settle path whose single-shot
  // stop/poll aborted against a busy server and skipped the instance close.
  // Run CREATION keeps retries=0 (a replayed create would double-run).
  for (let attempt = 0; ; attempt++) {
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
      if (response.status >= 500 && attempt < retries) { await sleep(2_000); continue; }
      return { status: response.status, json };
    } catch (error) {
      if (attempt < retries) { console.warn(`[tsec] xuanshu ${path} attempt ${attempt + 1} failed (${error?.message ?? error}); retrying`); await sleep(2_000); continue; }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Re-assert model settings every iteration: an API restart must not silently
// break every run (same lesson as the arena/ctf2 drivers).
async function ensureModel() {
  const apiKey = process.env.BIGMODEL_API_KEY;
  if (!apiKey) return;
  try {
    const result = await xuanshu("/v1/settings/model", {
      method: "POST",
      body: JSON.stringify({ modelId: process.env.ARENA_MODEL_ID ?? "glm-5.3", apiKey, baseUrl: process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic", reasoning: true }),
    });
    if (result.status >= 300) console.warn(`[tsec] ensureModel -> ${result.status}`);
  } catch (error) {
    console.warn(`[tsec] ensureModel failed (${error?.message ?? error})`);
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

async function stopRun(runId) {
  // R20: never single-shot. A budget stop that times out against a busy
  // server used to throw into the settle path and skip the instance close —
  // three of those leaked every slot and froze the whole fleet (29896).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await xuanshu(`/v1/runs/${runId}/stop`, { method: "POST", body: "{}" }, 120_000, 0);
      if (result.status < 300) return;
      console.warn(`[tsec] stop run ${runId} -> ${result.status} (attempt ${attempt}/3)`);
    } catch (error) {
      console.warn(`[tsec] stop run ${runId} attempt ${attempt}/3 failed (${error?.message ?? error})`);
    }
    if (attempt < 3) await sleep(3_000 * attempt);
  }
  // The watchdog below is the second net: even a failed stop cannot leak a
  // slot forever once the watch deadline lapses.
}

// Findings arrive as objects (Finding) or plain strings; normalize once.
function findingsTexts(findings) {
  return (Array.isArray(findings) ? findings : [])
    .map((f) => (typeof f === "string" ? f : `${f.title ?? ""}: ${f.description ?? ""}`.trim()).slice(0, 600))
    .filter(Boolean);
}

async function watchRun(runId, deadlineMs, code) {
  const deadline = Date.now() + deadlineMs;
  const banked = new Set(); // finding texts already mirrored to the board
  let bankedFrontier = ""; // last frontier note mirrored for this run
  // R20: poll the light /lite shape (status + findings + frontier). The full
  // snapshot serializes up to 1000 events plus the entire state every 20s —
  // under three heavy web grinds that load is what pushed settle-path stops
  // past their budget in 29896. Old servers without /lite fall back once.
  let liteMissing = false;
  while (Date.now() < deadline) {
    await sleep(20_000);
    let poll;
    if (!liteMissing) {
      try {
        poll = await xuanshu(`/v1/runs/${runId}/lite`);
      } catch (error) {
        console.warn(`[tsec] poll ${runId} failed (${error?.message ?? error}); continuing`);
        continue;
      }
      if (poll.status === 404) { liteMissing = true; }
    }
    if (liteMissing) {
      try {
        const full = await xuanshu(`/v1/runs/${runId}`);
        poll = { status: full.status, json: { status: full.json?.status ?? full.json?.state?.status, ...(full.json?.state ?? {}) } };
      } catch (error) {
        console.warn(`[tsec] poll ${runId} failed (${error?.message ?? error}); continuing`);
        continue;
      }
    }
    const status = poll.json?.status ?? poll.json?.state?.status;
    if (poll.status !== 200 || !status) continue;
    console.log(`[xuanshu] ${runId.slice(0, 8)} status=${status}`);
    // Watcher-lite (Cruiser lesson 2026-10-10): record_finding persists into
    // the run state IMMEDIATELY, so mirror new findings onto the board as
    // they land instead of waiting for settle — a wedged or budget-killed
    // run no longer takes its discoveries with it.
    if (code) {
      for (const text of findingsTexts(poll.json?.findings ?? poll.json?.state?.findings)) {
        if (!banked.has(text)) {
          banked.add(text);
          boardUpdate(code, { facts: [text] });
          console.log(`[tsec] live finding banked: ${text.slice(0, 90)}`);
        }
      }
      // R14: mirror the live frontier too — a budget-killed run's last
      // reasoning ("__proto__ passes the manifest check") must land on the
      // board without waiting for any settle path (29070: 7 challenges died
      // mid-breakthrough with the breakthrough only in the transcript).
      const frontier = String(poll.json?.frontierNote ?? poll.json?.state?.frontierNote ?? "");
      if (frontier && frontier !== bankedFrontier) {
        bankedFrontier = frontier;
        boardFrontier(code, frontier);
      }
    }
    if (["completed", "blocked", "failed", "aborted"].includes(status)) {
      // The settle path needs the full terminal state (submission, nextSteps,
      // summary) — one final full fetch, never the poll shape.
      try {
        const full = await xuanshu(`/v1/runs/${runId}`);
        return full.json?.state ?? full.json ?? poll.json ?? {};
      } catch {
        return poll.json ?? {}; // degraded transport: settle with what we have
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ ledger

async function record(entry) {
  await mkdir(resolve(LOG_PATH, ".."), { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function ledgerPath() { return resolve(WORK_DIR, "ledger.json"); }
function readLedger() {
  try { return JSON.parse(readFileSync(ledgerPath(), "utf8")); } catch { return { done: {}, accepted: {} }; }
}
function writeLedger(ledger) { writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2)); }
function ledgerEntry(code) { return readLedger().done[code] ?? { misses: 0 }; }
function ledgerMark(code, status, { progress } = {}) {
  const ledger = readLedger();
  const prior = ledger.done[code] ?? { misses: 0 };
  ledger.done[code] = { ...prior, status, ...(progress !== undefined ? { progress } : {}), misses: prior.misses + (status === "miss" ? 1 : 0), at: new Date().toISOString() };
  writeLedger(ledger);
}
// Progress (platform-confirmed correct_flag_count) resets the miss counter: a
// multi-flag challenge that just banked flag 2 of 3 deserves fresh attempts at
// flag 3, not the leftover misses from flag 2's grind.
function ledgerNoteProgress(code, progress) {
  const ledger = readLedger();
  const prior = ledger.done[code] ?? { misses: 0 };
  if (prior.progress === progress) return;
  ledger.done[code] = { ...prior, progress, misses: 0, at: new Date().toISOString() };
  writeLedger(ledger);
}
function recordAccepted(code, value) {
  const ledger = readLedger();
  ledger.accepted[code] = [...new Set([...(ledger.accepted[code] ?? []), value])].slice(-6);
  writeLedger(ledger);
}

// Handoff carry across retries of the same challenge (arena/ctf2-proven).
function handoffPath(code) { return resolve(WORK_DIR, `handoff-${code}.json`); }
function handoffFor(code) {
  try { return JSON.parse(readFileSync(handoffPath(code), "utf8")); } catch { return null; }
}
function wrongPath(code) { return resolve(WORK_DIR, `wrong-${code}.json`); }
// Pulled platform hint (charged once, cached forever — a second view may
// re-charge and buys nothing new). Empty string = challenge has no hint.
function hintPath(code) { return resolve(WORK_DIR, `hint-${code}.json`); }
function hintFor(code) {
  try { return JSON.parse(readFileSync(hintPath(code), "utf8")); } catch { return null; }
}
function rejectedValues(code) {
  try {
    const raw = JSON.parse(readFileSync(wrongPath(code), "utf8"));
    return Array.isArray(raw.values) ? raw.values.filter((v) => typeof v === "string") : [];
  } catch { return []; }
}
// Last run id per challenge — survives the handoff deletion a banked flag
// triggers, so retries always have a lineage parent for scratch inheritance.
function lastrunPath(code) { return resolve(WORK_DIR, `lastrun-${code}.json`); }
function writeLastrun(code, runId) {
  try { writeFileSync(lastrunPath(code), JSON.stringify({ code, runId, at: new Date().toISOString() })); } catch { /* best effort */ }
}
function lastrunFor(code) {
  try { return JSON.parse(readFileSync(lastrunPath(code), "utf8")).runId; } catch { return undefined; }
}
function recordRejected(code, value) {
  const values = [...rejectedValues(code), value].slice(-8);
  writeFileSync(wrongPath(code), JSON.stringify({ code, values, last: value, rejectedAt: new Date().toISOString() }, null, 2));
}
function writeHandoff(code, payload) {
  const prior = handoffFor(code);
  const dedupe = (items) => [...new Set(items)];
  const merged = {
    ...payload,
    findings: dedupe([...(prior?.findings ?? []), ...(payload.findings ?? [])]).slice(0, 8),
    nextSteps: dedupe([...(prior?.nextSteps ?? []), ...(payload.nextSteps ?? [])]).slice(0, 6),
    summary: payload.summary?.trim() ? payload.summary : (prior?.summary ?? ""),
    handoffText: payload.handoffText ?? prior?.handoffText,
  };
  writeFileSync(handoffPath(code), JSON.stringify(merged, null, 2));
}

// ------------------------------------------------------------------ blackboard
// Cairn/ARTEX-style shared progress record (2026-10-10). The handoff files
// above only capture a run's FINAL state — everything discovered mid-run was
// lost on any death, and lanes could only relay through end-of-run blobs.
// The board keeps three record types per challenge:
//   facts   — verified results (Cairn Fact), optionally anchored to an asset
//             label (ARTEX Anchor: portal:80, flag2, ...)
//   intents — open next steps (Cairn Intent) with an optional `needs`
//             precondition (ARTEX dependency gating: a worker that finds the
//             precondition unmet completes it first instead of redoing work)
//   hints   — operator-supplied steer notes (Cairn Hint; formalizes the
//             人工介入 loop: steer -> next run carries the correction)
function boardPath(code) { return resolve(WORK_DIR, `board-${code}.json`); }
function boardFor(code) {
  try {
    return JSON.parse(readFileSync(boardPath(code), "utf8"));
  } catch {
    // Lazy one-time migration: round-1 handoffs become board seed facts so
    // warm-start knowledge survives the format change.
    const prior = handoffFor(code);
    if (!prior) return { facts: [], intents: [], hints: [] };
    const board = {
      facts: (prior.findings ?? []).map((text) => ({ at: prior.at, from: prior.from, text })),
      intents: (prior.nextSteps ?? []).map((text) => ({ at: prior.at, text, needs: "" })),
      hints: [],
      summary: prior.summary ?? "",
    };
    try { writeFileSync(boardPath(code), JSON.stringify(board, null, 2)); } catch { /* read-only fs */ }
    return board;
  }
}
function boardWrite(code, board) { writeFileSync(boardPath(code), JSON.stringify(board, null, 2)); }
// R14 frontier slot: ONE record per challenge holding the last assistant
// reasoning of the newest killed run (single slot, overwritten — unlike
// intents it never pushes real next-steps out of the bounded board).
function boardFrontier(code, text) {
  const board = boardFor(code);
  board.frontier = { at: new Date().toISOString(), text: String(text).slice(0, 600) };
  boardWrite(code, board);
}
function boardUpdate(code, { facts = [], intents = [], hints = [], solvedIntentSubstr } = {}) {
  const board = boardFor(code);
  const factTexts = new Set(board.facts.map((f) => f.text));
  for (const text of facts) if (!factTexts.has(text)) { board.facts.push({ at: new Date().toISOString(), text }); factTexts.add(text); }
  const intentTexts = new Set(board.intents.map((i) => i.text));
  for (const intent of intents) {
    if (!intentTexts.has(intent.text)) { board.intents.push({ at: new Date().toISOString(), ...intent }); intentTexts.add(intent.text); }
  }
  const hintTexts = new Set(board.hints.map((h) => h.text));
  for (const text of hints) if (!hintTexts.has(text)) { board.hints.push({ at: new Date().toISOString(), by: "operator", text }); hintTexts.add(text); }
  // A banked flag retires every intent that names it (the run proved the step).
  if (solvedIntentSubstr) {
    for (const intent of board.intents) if (intent.text.includes(solvedIntentSubstr)) intent.done = true;
  }
  board.facts = board.facts.slice(-24);
  board.intents = board.intents.filter((i) => !i.done).slice(-8);
  board.hints = board.hints.slice(-8);
  boardWrite(code, board);
  return board;
}
function boardClear(code) {
  try { rmSync(boardPath(code), { force: true }); } catch { /* best effort */ }
}

// ── arena-wide lesson ledger (R10, user directive: 不要重做错误的事) ──────────
// Every settled run banks its GENERIC lessons (record_lesson output) into a
// shared ledger and its CONTRADICTED hypotheses onto the challenge board, so
// later task builds — other challenges included — start with the negative
// knowledge instead of repeating it. The per-challenge board already carries
// rejected flags and verified facts; this adds cross-challenge methodology.
function lessonsPath() { return resolve(WORK_DIR, "lessons.json"); }
function readArenaLessons() { try { return JSON.parse(readFileSync(lessonsPath(), "utf8")); } catch { return []; } }
function recordArenaLessons(code, state) {
  try {
    const lessons = readArenaLessons();
    const seen = new Set(lessons.map((l) => l.text));
    for (const lesson of state?.lessons ?? []) {
      const parts = [];
      if (lesson?.title) parts.push(String(lesson.title).slice(0, 160));
      const pitfalls = (lesson?.pitfalls ?? []).map((pitfall) => `坑:${String(pitfall).slice(0, 140)}`);
      if (pitfalls.length > 0) parts.push(pitfalls.join(";"));
      const when = (lesson?.applicableWhen ?? []).map((condition) => String(condition).slice(0, 100));
      if (when.length > 0) parts.push(`适用:${when.join(";")}`);
      const text = parts.join(" | ");
      if (!text || seen.has(text)) continue;
      seen.add(text);
      lessons.push({ at: new Date().toISOString(), code, text: text.slice(0, 320) });
    }
    writeFileSync(lessonsPath(), JSON.stringify(lessons.slice(-40), null, 2));
  } catch { /* best effort */ }
}
async function bankKnowledge(code, runId) {
  try {
    const state = (await xuanshu(`/v1/runs/${runId}`)).json?.state ?? {};
    const deadEnds = (state.hypotheses ?? [])
      .filter((h) => h?.status === "contradicted" && typeof h.statement === "string")
      .map((h) => `已排除假设:${h.statement.slice(0, 200)}${Array.isArray(h.evidence) && h.evidence[0] ? `(证据:${String(h.evidence[0]).slice(0, 100)})` : ""}`);
    if (deadEnds.length > 0) boardUpdate(code, { facts: deadEnds.slice(0, 6) });
    recordArenaLessons(code, state);
  } catch { /* state cold; the live mirror already covered findings */ }
}

// Cross-lane in-flight locks (user directive 2026-10-09: 并发开跑). Parallel
// loops elect the same byPriority winner within seconds of each other; a
// claim file (age-bounded) is the only coordination the local ledger gives
// us. Staleness exceeds the 46-min warm budget + container wait so a crashed
// lane's claim cannot strand a challenge for long.
const CLAIM_STALE_MS = 55 * 60_000;
function claimPath(code) { return resolve(WORK_DIR, `claim-${code}.json`); }
function claimFor(code) {
  try {
    const claim = JSON.parse(readFileSync(claimPath(code), "utf8"));
    if (Date.now() - Date.parse(claim.at) < CLAIM_STALE_MS) {
      // A SIGTERM'd lane never runs its finally — its claim is a corpse that
      // would otherwise lock a challenge for the full 55 minutes (the
      // 2026-10-10 rollovers left two). Probe the owning pid: ESRCH = dead =
      // treat as unclaimed; EPERM = alive under another user = valid hold.
      try { process.kill(claim.pid, 0); } catch (probe) { if (probe.code === "ESRCH") return null; }
      return claim;
    }
  } catch { /* absent or unreadable: unclaimed */ }
  return null;
}
function claimCode(code, lane) {
  if (claimFor(code)) return false;
  // Atomic claim: exclusive-create (wx) decides the race — the round-2 start
  // saw all three lanes pass check-then-write inside one ~100ms window and
  // triple-team a fragile single-instance container. A stale corpse (55min+)
  // must be removed first or wx would fail on it forever; only touch the file
  // when one is actually present so a fresh claim is never stolen.
  if (existsSync(claimPath(code))) {
    try { rmSync(claimPath(code), { force: true }); } catch { /* racing removal */ }
  }
  try {
    writeFileSync(claimPath(code), JSON.stringify({ lane, at: new Date().toISOString(), pid: process.pid }, null, 2), { flag: "wx" });
    return true;
  } catch {
    return false; // lost the race — another lane claimed between our check and write
  }
}
function releaseClaim(code) {
  try { rmSync(claimPath(code), { force: true }); } catch { /* best effort */ }
}
// Sweep every claim this process still holds (a task-ended exit between the
// claim and the finally would otherwise strand the challenge for 55 minutes).
function releaseOwnClaims() {
  try {
    for (const name of readdirSync(WORK_DIR).filter((f) => f.startsWith("claim-"))) {
      try {
        const claim = JSON.parse(readFileSync(resolve(WORK_DIR, name), "utf8"));
        if (claim.pid === process.pid) rmSync(resolve(WORK_DIR, name), { force: true });
      } catch { /* unreadable claim: leave for staleness */ }
    }
  } catch { /* WORK_DIR unreadable */ }
}
// ---- watch registry + slot watchdog (R20, 29896 post-mortem) ----------------
// Every episode (instance launch -> run -> settle) registers a watch file so
// ANY lane can tell, from shared disk, whether an open container still has a
// live owner. A settle path that dies before closing its instance (crash,
// wedged stop, create-timeout) leaves the container open with a stale/dead
// watch — the watchdog reclaims it instead of letting 3 leaks freeze the
// fleet behind the platform's container cap.
const WATCH_GRACE_MS = 5 * 60_000;
function watchPath(code) { return resolve(WORK_DIR, `watch-${code}.json`); }
function watchFor(code) {
  try { return JSON.parse(readFileSync(watchPath(code), "utf8")); } catch { return undefined; }
}
function registerWatch(code, runId, horizonMs) {
  try {
    writeFileSync(watchPath(code), JSON.stringify({ lane: process.env.TSEC_LANE ?? "main", pid: process.pid, runId, deadline: Date.now() + horizonMs, at: new Date().toISOString() }));
  } catch { /* registry is best-effort; the watchdog errs toward reclaiming */ }
}
function clearWatch(code) {
  try { rmSync(watchPath(code), { force: true }); } catch { /* already gone */ }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (probe) { return probe.code === "EPERM"; }
}
async function reconcileSlots(items) {
  for (const item of items) {
    const open = ["pending", "available", "stop_pending"].includes(item.container_status ?? "");
    if (!open) continue;
    const code = item.unique_code;
    if (item.is_completed) continue; // platform closes solved containers itself
    const w = watchFor(code);
    if (w && pidAlive(w.pid) && Date.now() < w.deadline + WATCH_GRACE_MS) continue; // healthy episode
    // Hint keep-warm: an intentionally parked container waiting for the
    // hint-armed revive — not a leak.
    const done = readLedger().done[code];
    if (done?.warmUntil && Date.now() < done.warmUntil) continue;
    if (done?.warmUntil && Date.now() >= done.warmUntil) ledgerMark(code, "parked"); // marker consumed
    if (!w && claimFor(code)) continue; // live lane mid-launch, watch not yet written
    console.warn(`[tsec] watchdog reclaiming orphan slot ${code} (watch=${w ? "stale" : "none"}, owner=${w ? `pid ${w.pid} alive=${pidAlive(w.pid)}` : "unclaimed"})`);
    if (w?.runId) await stopRun(w.runId);
    try {
      await closeChallenge(code);
    } catch (error) {
      if (isTaskEnded(error)) throw error;
      console.warn(`[tsec] watchdog close ${code} failed: ${error?.message ?? error}`);
    }
    clearWatch(code);
  }
}

// Per-lane counter of fast no-submission settles (infra-wall signature).
let fastFails = 0;
// R13 slot-hold joins: codes this lane already joined during the current
// hold episode — cleared when the lane wins a slot again.
const joinEpisodeCodes = new Set();

// ── phase engine (R16, AePis/Cruiser synthesis, user 2026-10-14) ────────────
// 32/42 flags scored rank 5 (AePis) vs rank 1 (Cruiser): the gap was three
// 600-1000pt tail challenges, not solve count. The loop now runs three regimes:
//   breadth — first ~45min: sweep the shallow pool under STRICT stop-loss
//             (AePis coverage: 27/30 solved inside 30 minutes);
//   value   — order by expected score rate (score x evidence bucket), not by
//             difficulty; A/B-bucket picks fan out into parallel racers;
//   endgame — <=8 unsolved (or 4h+ with <=14): Cruiser's persistent tail
//             solving — caps loosen, revive cooldowns shrink, every pick
//             fans out, nothing parks on a ledger technicality.
let currentPhase = "breadth";
// R17 coverage floor: consecutive picks that were NOT first attempts; two in
// a row forces the next pick back to a never-attempted challenge.
let warmPickStreak = 0;
let taskStartedAt = 0;
function phaseOf(items, now) {
  if (!taskStartedAt) taskStartedAt = now;
  const elapsedMin = (now - taskStartedAt) / 60_000;
  const unsolved = items.filter((item) => !item.is_completed).length;
  if (elapsedMin < 45) return "breadth";
  if (unsolved <= 8 || (elapsedMin >= 240 && unsolved <= 14)) return "endgame";
  return "value";
}
// Evidence buckets grade "how close is this challenge to a flag" from the
// board state alone: A = frontier/next-step in hand or rich board; B = facts
// accumulated, no live lead; C = attempted, nothing banked; D = untouched.
const BUCKET_WEIGHT = { A: 3, B: 2, C: 1, D: 0.5 };
function evidenceBucket(item) {
  const code = item.unique_code;
  const done = readLedger().done[code];
  if (!done) return "D";
  if (existsSync(boardPath(code))) {
    const board = boardFor(code);
    const openIntents = board.intents.filter((i) => !i.done);
    if (board.frontier?.text || openIntents.length > 0 || (board.facts?.length ?? 0) >= 3) return "A";
    if ((board.facts?.length ?? 0) > 0) return "B";
  }
  return "C";
}
// Coarse expected score rate: value x remaining-flag share x bucket weight.
// Deliberately not time-normalized (user: 不需要真的精确计算) — it only has
// to beat easy-before-hard ordering at picking time.
function expectedScoreRate(item) {
  const remaining = remainingOf(item);
  if (remaining <= 0) return 0;
  return (item.total_score ?? 0) * (remaining / Math.max(item.flag_count ?? 1, 1)) * BUCKET_WEIGHT[evidenceBucket(item)];
}
// Instance lifecycle (AePis container_bound facts): remember which container
// instance the board's facts came from; a restart downgrades session/cookie/
// temporary-address facts to "must re-verify" while stack/route conclusions
// survive. Returns the PRIOR address so callers can log the swap.
function boardContainer(code, addrs) {
  const board = boardFor(code);
  const addr = (addrs ?? [])[0] ?? "";
  if (board.containerAddr === addr) return addr;
  const prior = board.containerAddr ?? "";
  board.containerAddr = addr;
  board.containerAt = new Date().toISOString();
  try { boardWrite(code, board); } catch { /* read-only fs */ }
  return prior;
}

// ---------------------------------------------------------------- task build

const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 };
const remainingOf = (c) => Math.max((c.flag_count ?? 1) - (c.correct_flag_count ?? 0), 0);

function categoryOf(code) {
  const match = String(code).toLowerCase().match(/^(web|crypto|pwn|re|reverse|misc|forensics|osint|stego)/);
  if (!match) return undefined;
  return { re: "reverse", stego: "misc" }[match[1]] ?? match[1];
}

// ------------------------------------------------ arena discipline (R15)
// Task-AGNOSTIC playbook, injected once into the SYSTEM prompt via the
// run-creation `discipline` field — never into task bodies. 29070 review
// (user, 10-14): the 15.2k-char tasks carried the whole CTF skill index
// inline, drowning the per-run decision info, re-teaching rules 3-4x, and
// conflicting with per-challenge constraints (serial vs parallel). Tasks now
// carry only TASK / HARD CONSTRAINTS / VERIFIED FACTS / EXCLUDED / HINT /
// THIS RUN / SUCCESS; everything "how the agent works" lives here and defers
// to each task's HARD CONSTRAINTS on conflict.
const ARENA_DISCIPLINE = [
  "执行:现在开始解题,不等确认;拿到 flag 立即自交,全部确认后立即收尾。",
  "并行:互不依赖的探测(一组 http_request/文件读取/搜索)同一次回复批量发出;本地批量验证/字典/枚举用 Python 多线程或 xargs -P 并发,聚合输出只报关键差异;远程目标的连接纪律以题目 HARD CONSTRAINTS 为准(默认串行、并发≤2)。",
  "动态证据新鲜度:会话/cookie/验证码/动态签名/CSRF/一次性令牌/登录后页面,使用前确认其在本轮或最近一次状态变更(登录/提交/容器重启)之后获取,旧值一律视为过期并重取;重取被去重器拦截时加随机查询参数(?_=随机数)或唯一 header 值。",
  "假设队列:新假设按(分值×成功概率÷成本)排序入 checkpoint 队列,同一时刻只推进队首;未入队的灵感即丢弃,严禁无限 one more idea 发散。",
  "目标健康:同一入口连续≥3次 5xx/拒连/超时即停止轮询,换入口或以 blocked(原因:目标不可用)立即收尾释放槽位;调度器会在后续轮次重试。",
  "高成本探测(每点≥1分钟:WAF 限速 oracle/CI 构建周期/串行盲读):先列候选位置按可能性排序再按序取点;完成一个进行中的原语验证优先于切换思路;包装/大小写变体零信息量,放最后统一批量试。",
  "远端代码卫生:任何远端执行代码(CI payload/注入脚本)自带硬超时,严禁主动解析未验证主机名,网络探测一律带超时、并发≤4。",
  "诱饵:远程读出值被判错且带陈旧标记(轮换/生成日期早于环境开通)时,最多 2 个变体即转向找环境开通后生成的新值,严禁围绕旧值无限变体。",
  "收尾:临近时间上限把已验证关键值与当前突破点用 record_finding/checkpoint/scratch 固化;确实无法解出时以 blocked 结束(完全省略 submission 字段直接放行),严禁伪造 flag 或提交 BLOCKED/401/timeout 类标记串。",
].join("\n");

// R17 category packs: class-specific playbooks ride ONLY the runs of that
// class (server-side 6000-char bound holds: core ~1.2k + pack < 0.5k) —
// the core discipline stays lean and no challenge pays tokens for another
// class's knowledge.
const CATEGORY_PACKS = {
  web: "Web:快速题直奔最短路径(默认/弱凭据、已知 CVE、明显注入点、robots/.git/.env 泄露、报错回显、JS 内嵌密钥);优先序 SSTI→SSRF→文件包含→SQLi→命令注入→反序列化;拿到 RCE/任意读后按序排查 env、/proc/self/environ、/proc/1/environ、/proc/mounts、/flag*、/root、/home、/tmp、应用目录、配置密钥,固定路径扫不到再 find/grep 全盘。已知组件先查沙箱 /opt/kb/cve-quickref.md,再用 nuclei-templates/seclists 复核,严禁把已知产品当未知目标从头 fuzz。JS 渲染/登录页用 chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/cp --dump-dom <url>(或 --screenshot=);登录态先复现 cookie 再复用。OCR 用 tesseract <img> stdout --psm 7,失败做放大/灰度/二值化重试一次,严禁无限调参。",
  crypto: "Crypto:先识别原语与结构(hash 长度/块大小/密文格式/参数特征),已知攻击优先于自造;长计算(爆破/格)拆批持久化续算,严禁单命令超时硬扛;先试沙箱 /opt/kb 工具链与常见弱参数再看论文级攻击。",
  pwn: "Pwn:先 file/checksec/识别服务与 libc 版本,已知漏洞优先;交互脚本先本地打通再上远端,长 exploit 拆步验证(每步有可判定输出),失败点固定后逐步收敛,严禁整段盲改重跑。",
  reverse: "Reverse:先识别架构/壳/语言与已知特征;静态先 strings/常量/导入表再反汇编热点函数;反混淆优先匹配通用算法与已知变换,严禁逐指令手撸全部。",
  misc: "Misc:先 file/strings/exif/010 结构识别再动手;媒体文件注意隐写字段与附加数据;取证题先时间线与元数据,再内容层分析。",
  osint: "OSINT:先从题面提取可检索实体并交叉验证;公开来源优先,结论必须至少两个独立来源一致。",
};
function disciplineFor(code) {
  const pack = CATEGORY_PACKS[categoryOf(code) ?? ""];
  return pack ? ARENA_DISCIPLINE + "\n【本类题打法】\n" + pack : ARENA_DISCIPLINE;
}

function buildTask(challenge, budgetMinutes, direction, freshEyes = false) {
  const code = challenge.unique_code;
  const lines = [];
  const addrs = (challenge.container_addr ?? []).filter(Boolean);
  const desc = String(challenge.description ?? "").trim();
  // ---- TASK:目标、授权范围、题面、自交通道 ----
  lines.push(`# TASK`);
  lines.push(`GOAL:从远程环境实际读出本题全部 flag 并经平台自交确认(共 ${challenge.flag_count ?? 1} 个,平台已确认 ${challenge.correct_flag_count ?? 0} 个)。`);
  if (addrs.length > 0) lines.push(`授权目标:${addrs.map((addr) => `http://${addr}`).join(", ")}(VPN 内网,本题唯一授权测试范围;网络 writeup 历史 flag 不得采信)。`);
  if (direction) lines.push(`【定向任务】本运行只做这一个方向,严禁无关探索:${direction}`);
  lines.push(`题面:${desc || "(题面无更多文字,以远程环境为准)"}`);
  lines.push(`自交通道(平台唯一权威校验,沙箱可直接访问,判错不扣分):POST ${BASE}/openapi/v1/challenges/submit,header "BENCHMARK_TOKEN: ${TOKEN}",JSON 体 {"unique_code":"${code}","flag":"<值>"};409 duplicate=该值已入账,同样记 VERIFIED_FLAG 并跳过。`);
  if (/ldap|jndi|目录服务|directory/i.test(desc)) lines.push(`目录服务集成题:沙箱已内置通用 rogue LDAP(S) 测试服务器 /workspace/tools/rogue-ldaps.py(BER 编码已内置,payload 从 /workspace/tools/rogue-ldaps-payload.json 热加载)——严禁从零手写 BER 编码。`);
  if (/jolokia|\bjmx\b|mbean|tomcat|actuator/i.test(desc)) lines.push(`JMX/Jolokia 面:先 list 拿全量 MBean 树按序尝试——MBeanFactory WAR 部署(参数按当前 Tomcat 版本对齐)、JNDI/logback lookup 指向沙箱 rogue LDAP(S)、SystemProperties/Environment/配置类 MBean 直读 flag 与凭据;单个 gadget 报错≠整个面无效。`);
  lines.push("");
  // ---- HARD CONSTRAINTS:本题不可违背的规则(与系统纪律冲突时以此为准) ----
  lines.push(`# HARD CONSTRAINTS`);
  if (addrs.length > 0) lines.push(`- 远程是脆弱单实例:串行请求、最多 2 个并发连接,严禁扫描器式并发;续跑开局先轻探一次确认存活,死亡立即以 blocked 结束`);
  lines.push(`- 严禁重做/重推下方 VERIFIED FACTS 与 EXCLUDED 中的任何内容,开局即增量实验`);
  lines.push(`- flag 只认远程实际读取且复读一致,严禁提交猜测值;每个 flag 确认后立即自交,不要攒到最后`);
  lines.push(`- 平台付费提示严禁自行查看(题内已附 HINT 除外)`);
  if ((challenge.flag_count ?? 1) > 1 || (readLedger().accepted[code] ?? []).length > 0) lines.push(`- 收割模式:立足点允许的范围内枚举所有 flag 来源,逐个读出即交`);
  lines.push("");
  // ---- VERIFIED FACTS:只写结论 ----
  const board = boardFor(code);
  const priorHandoff = handoffFor(code);
  const accepted = readLedger().accepted[code] ?? [];
  if (board.facts.length > 0 || accepted.length > 0 || (priorHandoff?.summary && !freshEyes)) {
    lines.push(`# VERIFIED FACTS(前轮实际验证,直接采信,禁止重推)`);
    if (priorHandoff?.summary && !freshEyes) lines.push(`- 前轮总结:${String(priorHandoff.summary).replace(/\s+/g, " ").slice(0, 240)}`);
    for (const fact of board.facts.filter((f) => !/^已排除假设:/.test(f.text)).slice(-12)) lines.push(`- ${fact.text.slice(0, 260)}`);
    if (accepted.length > 0) lines.push(`- 已正确提交:${accepted.map((v) => `"${v}"`).join("、")}`);
    lines.push("");
  }
  // ---- EXCLUDED:已判错值 + 死端 + 跨题教训,结论式一行一条 ----
  const rejectedList = rejectedValues(code);
  const deadEnds = board.facts.filter((f) => /^已排除假设:/.test(f.text)).slice(-6);
  const arenaLessons = readArenaLessons().filter((l) => l.code !== code).slice(-4);
  if (rejectedList.length > 0 || deadEnds.length > 0 || arenaLessons.length > 0) {
    lines.push(`# EXCLUDED(已彻底排除,严禁重走)`);
    if (rejectedList.length > 0) lines.push(`- 已判错值(严禁原样重交;变体仅按序试全小写/全大写/去包装,每个提交前与列表逐字符比对):${rejectedList.map((v) => `"${v}"`).join("、")}`);
    for (const f of deadEnds) lines.push(`- ${f.text.slice(0, 200)}`);
    for (const lesson of arenaLessons) lines.push(`- ${lesson.text.slice(0, 200)}`);
    lines.push("");
  }
  // ---- HINT ----
  const pulledHint = hintFor(code)?.hint;
  if (pulledHint) {
    lines.push(`# HINT(已按比例扣分获取,必须充分利用)`);
    lines.push(pulledHint);
    lines.push("");
  }
  // ---- THIS RUN:本轮目标与方向 ----
  lines.push(`# THIS RUN`);
  if (addrs.length > 0 && board.containerAddr && board.containerAddr !== addrs[0]) {
    lines.push(`- 容器已重启(旧 ${board.containerAddr} → 新 ${addrs[0]}):黑板中的会话/cookie/临时地址类事实属旧实例,使用前必须重新获取验证;技术栈/路由/逻辑类结论仍有效`);
  }
  if (currentPhase === "endgame") lines.push(`- 尾盘攻坚:本题被调度为重点投入,禁止浅尝即弃;沿前沿笔记/优先待办推进到预算尽或解出`);
  for (const h of board.hints) lines.push(`- 操作员指令(最高优先级):${h.text.slice(0, 240)}`);
  if (freshEyes) {
    lines.push(`- 独立重审:上一方向已多轮未破,本轮刻意不继承其推理链与中间产物——从题面原文与远程环境重新独立审题,建立与黑板待办不同的新主线;EXCLUDED 中的死路仍然严禁重走`);
  } else {
    if (board.frontier?.text) lines.push(`- best_frontier(上一会话被截断时的最后推理,未验证):${board.frontier.text.slice(0, 300)}`);
    const openIntents = board.intents.filter((i) => !i.done).slice(0, 2);
    if (openIntents.length > 0) lines.push(`- next_exact_test(按序执行,完成一个立即 checkpoint 勾选):${openIntents.map((i) => i.text.slice(0, 160)).join(" / ")}`);
    if (board.frontier?.text || openIntents.length > 0) lines.push(`- resume_instruction:接续或证伪 best_frontier,严禁从头再来;dead_ends 见 EXCLUDED;动态类事实(会话/cookie/临时地址)跨重启即过期,技术栈/逻辑结论仍有效`);
  }
  const priorMisses = readLedger().done[code]?.misses ?? 0;
  if (priorMisses >= 2) {
    const angles = [
      "换非预期入口:枚举题面与接口中完全未被触及的次要功能面、边缘参数与隐藏路由",
      "换静态视角:重读题面原文、附件与历史响应差异(响应头/错误页/注释/默认凭据),寻找动态探测漏掉的逻辑线索",
      "换横向视角:若已有立足点,转向同网段关联服务、信任链与配置泄露,而非正面强攻主入口",
    ];
    lines.push(`- 本题已连续 ${priorMisses} 轮未解,黑板待办大概率已试过——必须换全新切入点:${angles[priorMisses % angles.length]}`);
  }
  if (budgetMinutes > 0) lines.push(`- 时间预算约 ${budgetMinutes} 分钟(上限非目标;超时中止前未固化的推理即丢失,临近时固化关键值与当前突破点)`);
  lines.push("");
  // ---- SUCCESS ----
  lines.push(`# SUCCESS`);
  lines.push(`flag 从远程读出 → 独立复读一致 → 立即自交 correct=true → record_finding "VERIFIED_FLAG: <值>" →(仍有剩余 flag 则继续枚举)→ finish_task(提交值=最后一个尚未确认的值;确实无法解出则 status blocked 且完全省略 submission 字段)。`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- container + VPN

function tcpProbe(host, port, timeoutMs = 2_500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// Best-effort reachability check from the HOST: sandbox traffic NATs through
// the host network stack, so if the host cannot reach the VPN address the
// sandbox certainly cannot either. A pass is not a guarantee, a fail is a
// hard blocker (never burn a 40-minute run against an unreachable target).
async function probeVpn(addrs) {
  for (const addr of addrs) {
    const [host, port] = addr.split(":");
    if (await tcpProbe(host, Number(port) || 80)) return addr;
  }
  return null;
}

async function ensureContainer(challenge) {
  const code = challenge.unique_code;
  if (challenge.container_status === "available" && (challenge.container_addr ?? []).length > 0) return challenge;
  if (challenge.container_status === "pending") {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await sleep(10_000);
      const fresh = (await listChallenges()).find((item) => item.unique_code === code);
      if (fresh?.container_status === "available" && (fresh.container_addr ?? []).length > 0) return fresh;
      if (fresh && fresh.container_status === "stopped") break;
    }
  }
  // Free a slot first if the platform is at its 3-instance limit. NEVER pick
  // a claimed (in-flight in another lane) challenge as the victim — the first
  // version closed a parked challenge's container out from under a live run. Completed
  // first, then unclaimed leftovers; if every active slot is in-flight, hold
  // and retry rather than kill someone's target.
  const active = (await listChallenges()).filter((item) => ["pending", "available", "stop_pending"].includes(item.container_status) && item.unique_code !== code);
  if (active.length >= 3) {
    const victim = active.find((item) => item.is_completed) ?? active.find((item) => !claimFor(item.unique_code));
    if (!victim) {
      throw Object.assign(new Error("all 3 active slots are in-flight (claimed); holding for a free slot"), { slotsBusy: true });
    }
    // Re-verify the victim is still unclaimed right before the close: the
    // claiming lane's write can land between the scan and this call (observed once: the close killed a live run's container).
    if (!victim.is_completed && claimFor(victim.unique_code)) {
      throw Object.assign(new Error(`victim ${victim.unique_code} got claimed mid-selection; holding for a free slot`), { slotsBusy: true });
    }
    console.log(`[tsec] 3-instance limit: closing ${victim.unique_code} to free a slot`);
    await closeChallenge(victim.unique_code);
    await sleep(5_000);
  }
  // Two lanes polling the same "free" slot both call /start; the loser gets a
  // 409 slot-limit. Surface wording varies (中文 上限/活跃 … vs English "max
  // active challenge instances reached") — convert ANY slot-limit shape into
  // the uniform hold-and-retry instead of a raw crash (and never a task-end:
  // that misread killed lane-d wholesale on 2026-10-10).
  let started;
  try {
    started = await api("/openapi/v1/challenges/start", { method: "POST", query: { unique_code: code } });
  } catch (error) {
    if (isSlotLimit(error)) throw Object.assign(new Error("start hit the 3-instance limit (lost a lane race); holding for a free slot"), { slotsBusy: true });
    throw error;
  }
  let addrs = started.container_addr ?? [];
  if (addrs.length === 0) {
    // Container provisioning is async; poll the list until addr appears.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && addrs.length === 0) {
      await sleep(10_000);
      const fresh = (await listChallenges()).find((item) => item.unique_code === code);
      addrs = fresh?.container_addr ?? [];
    }
  }
  return { ...challenge, container_status: "available", container_addr: addrs };
}

// ---------------------------------------------------------------- main flow

// -------------------------------------------------- lane-minute accounting (R6)
// Live-run 28506 context: five hard singles once burned 438 lane-minutes for
// zero flags, which produced the (now REMOVED, R17) spent/miss parking caps.
// spentMin is still recorded per challenge for post-run attribution, but it
// gates nothing — value-rate ordering decides who runs next, never a ledger.
function ledgerAddSpent(code, minutes) {
  if (minutes <= 0) return;
  try {
    const ledger = readLedger();
    const prior = ledger.done[code] ?? { misses: 0 };
    ledger.done[code] = { ...prior, spentMin: (prior.spentMin ?? 0) + minutes };
    writeLedger(ledger);
  } catch { /* ledger races are tolerated elsewhere; same here */ }
}

async function solveOne(challenge) {
  const code = challenge.unique_code;
  const lane = process.env.TSEC_LANE ?? "main";
  if (!claimCode(code, lane)) {
    console.warn(`[tsec] ${code} is claimed by lane ${claimFor(code)?.lane ?? "?"}; skipping`);
    throw Object.assign(new Error("already_claimed"), { claimed: true });
  }
  const claimedAt = Date.now();
  registerWatch(code, null, 90 * 60_000); // provisional: covers launch->build->create
  try {
    return await solveOneInner(challenge);
  } finally {
    clearWatch(code); // episode over: the watchdog must not see a stale owner
    releaseClaim(code);
    ledgerAddSpent(code, Math.round((Date.now() - claimedAt) / 60_000));
  }
}

async function solveOneInner(challenge) {
  const code = challenge.unique_code;
  const laneRole = process.env.TSEC_ROLE ?? "mixed";
  const startedAt = Date.now();
  console.log(`[tsec] challenge ${code} (${challenge.difficulty}, L${challenge.level}, ${challenge.total_score}pts, flags ${challenge.correct_flag_count}/${challenge.flag_count})`);

  const dir = resolve(WORK_DIR, code);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "challenge.json"), JSON.stringify(challenge, null, 2));

  const ready = await ensureContainer(challenge);
  const addrs = (ready.container_addr ?? []).filter(Boolean);
  if (addrs.length === 0) {
    console.warn(`[tsec] container for ${code} never became ready; skipping`);
    ledgerMark(code, "miss");
    return false;
  }
  const priorAddr = boardContainer(code, addrs); // R16 instance lifecycle
  if (priorAddr && priorAddr !== addrs[0]) console.log(`[tsec] ${code} container restarted ${priorAddr} -> ${addrs[0]}`);
  let reachable = await probeVpn(addrs);
  if (!reachable) {
    // A just-started container often needs seconds before it listens (observed once:
    // a 5-minute hold for one early probe); retry once before declaring
    // the VPN down.
    await sleep(10_000);
    reachable = await probeVpn(addrs);
  }
  if (!reachable) {
    // Do NOT mark a miss: the challenge is fine, the network is not.
    console.warn(`[tsec] VPN unreachable for ${addrs.join(", ")} — connect the task's SSLVPN on this host; holding challenge`);
    throw Object.assign(new Error("vpn_unreachable"), { vpnDown: true });
  }

  // Budget ladder (R4 tuning + Cruiser tier model + pace fix 2026-10-10):
  // - deep 60 after two burned attempts
  // - chains 46 (they serialize over runs and bank flags late)
  // - warm singles 35
  // - fresh easy 20 / fresh medium 30 / fresh hard 40 for compression
  //   (a slot held by a hopeless easy grind is 40 min stolen from a 55-single pool)
  // - prospector mode: 20 easy / 30 medium / 30 hard (surface mapping, not grind)
  //   R4: hard fresh singles use 40 because they frequently yield in one
  //   well-structured run; old 35 was cutting off critical decision points.
  const carryBoard = boardFor(code);
  const warm = handoffFor(code) || carryBoard.facts.length > 0 || carryBoard.intents.length > 0;
  const misses = ledgerEntry(code).misses ?? 0;
  const effMisses = effectiveMisses(code); // R20: wall-time-stuck counts as a miss for arming
  const rank = DIFFICULTY_RANK[String(ready.difficulty ?? "").toLowerCase()] ?? 3;
  await maybePullHint(code, effMisses); // R9: pull before the task build; misses>=1 means the unaided shot already failed
  const isChain = (ready.flag_count ?? 1) > 1;
  // R17 budget ladder: stop-loss caps are GONE (operator ruling 10-14: token
  // cost is not a constraint, parking/truncating a challenge is pure loss);
  // per-attempt budgets remain only as slot-rotation under the platform's
  // 3-slot/6h wall. Warm singles rose 35->46 — the largest 29070 miss class
  // was breakthroughs truncated by the run clock, not by difficulty.
  const deepTier = isChain || rank === 2 || laneRole === "deep";
  const budgetMin = laneRole === "prospector"
    ? (rank === 2 ? 30 : rank === 0 ? 20 : 30) // prospector: surface map budgets
    : deepTier
      ? (misses >= 1 ? 60 : 46)
      : warm ? 46 : rank === 0 ? 20 : rank === 1 ? 30 : 40;
  const budgetMs = budgetMin * 60_000;
  // R20 lifecycle registration: re-stamp the watch with the real budget
  // horizon once it is known (the provisional claim-time stamp is a ceiling).
  registerWatch(code, watchFor(code)?.runId ?? null, budgetMs + 30 * 60_000);
  // R20 fresh-eyes: from the 3rd effective miss on, every other retry is a
  // deliberate blind re-audit — no scratch inheritance, no frontier/intents
  // resume — because 29896's bctf2026-22 ground one inherited JNDI hypothesis
  // for 4h while a fresh 38-minute pass solved it in the previous round.
  const freshEyes = effMisses >= 2 && effMisses % 2 === 0;
  if (freshEyes) console.log(`[tsec] ${code} fresh-eyes retry (effective misses=${effMisses}): dropping inherited context for an independent re-audit`);
  const task = buildTask(ready, Math.round(budgetMs / 60_000), undefined, freshEyes);
  await writeFile(resolve(dir, "task.txt"), task);
  // Scratch inheritance (round-3 lesson): retries rebuilt whole toolchains
  // because each run's scratch namespace is wiped. lineage.parentRunId makes
  // the runtime copy the parent's scratch in and tell the agent to reuse it.
  const parentRunId = freshEyes ? null : lastrunFor(code);
  // No-hint finals: stuck challenges (misses past the old hint-arming point)
  // get the fallback model's lens on alternating attempts.
  const rescueRole = rescueModelRole(effMisses);
  if (rescueRole) console.log(`[tsec] rescue dispatch for ${code} (misses=${misses}): next attempt on the fallback model`);
  const created = await xuanshu("/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      task,
      metadata: { source: "question-bank", questionId: `tsec-${code}`, ...(categoryOf(code) ? { category: categoryOf(code) } : {}) },
      // R11: all runs on one challenge share the live evidence board —
      // checkpoint-contradicted hypotheses and findings broadcast to the
      // concurrent fan-out siblings of the same code.
      evidenceGroup: `tsec-${code}`,
      discipline: disciplineFor(code),
      ...(rescueRole ? { modelRole: rescueRole } : {}),
      ...(parentRunId ? { lineage: { parentRunId } } : {}),
    }),
  }, 45_000, 0);
  if (created.status !== 202) die(`xuanshu run creation failed: ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`);
  const runId = created.json.id;
  registerWatch(code, runId, budgetMs + 30 * 60_000); // now with the runId for watchdog stops
  writeLastrun(code, runId);
  console.log(`[tsec] xuanshu run ${runId} queued${parentRunId ? ` (scratch inherited from ${parentRunId.slice(0, 8)})` : ""}`);

  const terminal = await watchRun(runId, budgetMs, code);
  await bankKnowledge(code, runId); // R10: bank lessons + ruled-out hypotheses before settling
  if (!terminal) {
    console.warn(`[tsec] driver budget exhausted; stopping run ${runId}`);
    await stopRun(runId);
    // Final sweep: findings recorded in the run's last 20 seconds (the poll
    // gap before the stop) are still persisted in the run state — recover
    // them before the state goes cold alongside the handoff fetch below.
    try {
      const finalState = (await xuanshu(`/v1/runs/${runId}`)).json?.state ?? {};
      for (const text of findingsTexts(finalState.findings)) boardUpdate(code, { facts: [text] });
    } catch { /* state cold; the live mirror already covered it */ }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const handoff = (await xuanshu(`/v1/runs/${runId}/handoff`)).json;
        const text = handoff?.handoff ?? handoff?.data?.handoff;
        if (typeof text === "string" && text.trim() !== "") {
          writeHandoff(code, { from: runId, at: new Date().toISOString(), handoffText: text.slice(0, 4000) });
          break;
        }
      } catch { /* not written yet */ }
      await sleep(3_000);
    }
    // Completion pre-check (observed in round 3): the agent may have
    // self-submitted everything in the poll gap before the stop — a timeout
    // is not a miss if the platform already counts the challenge done.
    try {
      const freshTimeout = (await listChallenges()).find((item) => item.unique_code === code);
      if (freshTimeout?.is_completed) {
        console.log(`[tsec] ${code} completed by self-submission during the budget window; settling as solved`);
        ledgerMark(code, "solved", { progress: freshTimeout.correct_flag_count });
        ledgerNoteProgress(code, freshTimeout.correct_flag_count);
        boardClear(code);
        await closeChallenge(code);
        await record({ challenge: code, runId, outcome: "self-submitted-complete", submission: "timeout-settled" });
        return true;
      }
    } catch (error) {
      if (isTaskEnded(error)) throw error;
      // list hiccup: fall through to the miss mark
    }
    // R20: every await here is failure-isolated — one bad call must never
    // again skip the instance close below it (the 29896 slot-leak chain).
    await record({ challenge: code, runId, outcome: "driver-timeout" }).catch((error) => console.warn(`[tsec] timeout record failed: ${error?.message ?? error}`));
    ledgerMark(code, "miss");
    await settleMiss(code, challenge); // R9: pay the hint now; release or keep-warm the slot
    return false;
  }

  const submission = terminal.submission ?? null;
  const findings = findingsTexts(terminal.findings).slice(0, 8);
  const nextSteps = (Array.isArray(terminal.nextSteps) ? terminal.nextSteps : []).filter((s) => typeof s === "string").map((s) => s.slice(0, 400)).slice(0, 6);
  writeHandoff(code, { from: runId, at: new Date().toISOString(), summary: String(terminal.summary ?? "").slice(0, 1200), findings, nextSteps });
  // Blackboard: every terminal settle (any status) banks the run's verified
  // results and open intents — a run that dies to budget/wedge no longer
  // takes its mid-run discoveries with it.
  boardUpdate(code, { facts: findings, intents: nextSteps.map((text) => ({ text, needs: "" })) });

  if (terminal.status === "completed" && submission) {
    // Self-submit world: the agent may have banked every flag already, with
    // finish_task carrying a leftover unconfirmed value. Relaying that would
    // pollute the wrong-file and ledger on a challenge the platform already
    // counts as solved (observed: correct:false on a 1/1-complete
    // challenge). Check completion before relaying.
    try {
      const freshSelf = (await listChallenges()).find((item) => item.unique_code === code) ?? challenge;
      if (freshSelf.is_completed) {
        console.log(`[tsec] ${code} already completed by self-submission; skipping finish_task relay`);
        ledgerMark(code, "solved", { progress: freshSelf.correct_flag_count });
        ledgerNoteProgress(code, freshSelf.correct_flag_count);
        boardClear(code);
        await closeChallenge(code);
        await record({ challenge: code, runId, outcome: "self-submitted-complete", submission });
        return true;
      }
    } catch (error) {
      if (isTaskEnded(error)) throw error;
      // list hiccup: fall through to the normal relay path
    }
    let verdict;
    try {
      verdict = await submitFlag(code, submission);
    } catch (error) {
      if (isDuplicate(error)) {
        // Idempotent protection: the value is already banked. Not a rejection.
        // Bank it in the accepted list too: the platform may 409-duplicate a
        // value we never recorded (observed once: a value 409-duplicated yet
        // correct_flag_count stayed put) — whatever the cause, resubmitting it
        // earns nothing, so the next task build must exclude it.
        fastFails = 0;
        recordAccepted(code, submission);
        console.log(`[tsec] duplicate (already correct): ${submission}`);
        await record({ challenge: code, runId, outcome: "duplicate", submission });
        const fresh = (await listChallenges()).find((item) => item.unique_code === code) ?? challenge;
        ledgerNoteProgress(code, fresh.correct_flag_count ?? challenge.correct_flag_count);
        if (fresh.is_completed) await closeChallenge(code);
        return fresh.is_completed;
      }
      if (isTaskEnded(error)) {
        console.warn("[tsec] benchmark task ended mid-submit; stopping loop");
        throw Object.assign(error, { taskEnded: true });
      }
      throw error;
    }
    const solved = verdict?.correct === true;
    fastFails = 0; // any real submit outcome clears the infra-wall signature
    { // ...and the per-code metronome streak (R21)
      const ledger = readLedger();
      if (ledger.done[code]?.fastSettles) { ledger.done[code] = { ...ledger.done[code], fastSettles: 0 }; writeLedger(ledger); }
    }
    if (solved) {
      recordAccepted(code, submission);
      // A banked flag on a multi-flag challenge is NOT done: pickNext filters
      // status "solved" out entirely, and marking partial chains solved the
      // moment flag 1 lands stranded that chain's remaining 3 flags (no lane would
      // ever re-pick it, and its live container got reaped as a free slot).
      const fullyDone = verdict.correct_flag_count >= verdict.total_flag_count;
      ledgerMark(code, fullyDone ? "solved" : "partial", { progress: verdict.correct_flag_count });
      ledgerNoteProgress(code, verdict.correct_flag_count);
      boardUpdate(code, { facts: [`flag${verdict.correct_flag_count} 银行入账: ${submission} (平台确认)`], solvedIntentSubstr: submission.slice(0, 24) });
      const { rmSync } = await import("node:fs");
      try { rmSync(wrongPath(code), { force: true }); } catch { /* best effort */ }
      if (verdict.correct_flag_count >= verdict.total_flag_count) {
        try { rmSync(handoffPath(code), { force: true }); } catch { /* best effort */ }
        boardClear(code); // challenge complete: the board's job is done
        await closeChallenge(code); // completed: release the instance slot
      } else {
        try { rmSync(handoffPath(code), { force: true }); } catch { /* banked flag makes stale handoff stale */ }
      }
    } else {
      recordRejected(code, submission);
      ledgerMark(code, "miss");
      await settleMiss(code, challenge); // R9: pay the hint now; release or keep-warm the slot
    }
    await record({ challenge: code, runId, outcome: solved ? "submitted" : "rejected", submission, verdict });
    console.log(`[tsec] submit verdict (${code}): ${JSON.stringify(verdict)}`);

    // Harvest mode: after a correct primary the run has proven quality —
    // submit the agent's other re-read-verified flags (VERIFIED_FLAG findings).
    // A rejected primary disqualifies the run's verification discipline.
    if (solved) await harvestFlags(code, terminal);
    return solved;
  }

  console.log(`[tsec] run settled as ${terminal.status} without a submission`);
  await record({ challenge: code, runId, outcome: terminal.status });
  // R13: a run that died on the MODEL side (quota exhausted, rate-limit
  // retries exhausted) never evaluated the challenge — the 29070 outage
  // burned real misses this way (hung requests >5min fell past the fast-settle
  // guard). Park the lane on the existing infra-wall cooldown instead.
  if (terminal.status === "failed" && ["quota", "rate_limit"].includes(terminal.providerError?.code)) {
    console.warn(`[tsec] run failed on provider ${terminal.providerError.code} — infra wall, miss NOT counted`);
    throw Object.assign(new Error(`provider wall (${terminal.providerError.code})`), { infraWall: true });
  }
  // A no-submission settle inside 5 minutes is an infra suspect (quota wall,
  // model outage), not a capability miss — the agent never got a real look.
  // Burning miss caps on them capped five healthy challenges during the
  // 20:15-20:24 quota wall; three in a row on one lane means back off.
  if (Date.now() - startedAt < 5 * 60_000) {
    fastFails += 1;
    console.warn(`[tsec] fast no-submission settle (${fastFails}/3) — infra suspect, miss NOT counted`);
    // R21 metronome guard (30661: bctf2026-24 relapsed into an ~80s
    // launch-die-relaunch loop — a poisoned board keeps ranking the code top
    // while every episode exits without a submission, and because fast
    // settles do not count misses the fresh-eyes arming line is never
    // reached, so the same inherited context is retried forever). Two
    // consecutive fast no-submission settles bench the CODE for 25min in the
    // shared ledger — every lane sees it — instead of recycling the lane.
    {
      const ledger = readLedger();
      const streak = (ledger.done[code]?.fastSettles ?? 0) + 1;
      if (streak >= 2) {
        ledger.done[code] = { ...ledger.done[code], fastSettles: 0, quarantineUntil: Date.now() + 25 * 60_000 };
        console.warn(`[tsec] quarantining ${code} for 25min (metronome guard: ${streak} consecutive fast settles)`);
      } else {
        ledger.done[code] = { ...ledger.done[code], fastSettles: streak };
      }
      writeLedger(ledger);
    }
    if (fastFails >= 3) throw Object.assign(new Error("suspected infra wall (quota/model)"), { infraWall: true });
    return false;
  }
  ledgerMark(code, "miss");
  await settleMiss(code, challenge); // R9: pay the hint now; release or keep-warm the slot
  return false;
}

// -------------------------------------------------- directed fan-out (R7)
// bctf top-6 post-mortem (2026-10-13): the winners did not retry harder —
// they retried WIDER. One unsolved challenge carried 100-360 worker sessions,
// each spawned with a single directed sub-task (只做这一条,禁止无关探索)
// against a shared blackboard the dispatcher kept merging; unsolved challenges
// got swarmed with 25-30 concurrent workers in their final minutes. A single-
// stream 35-min retry explores one hypothesis; three concurrent directed
// workers explore three for the same lane-minutes at ~3x the token burn (the
// #1 agent spent ~1.4B tokens — token throughput correlates with rank).
// Directions are generic templates plus this challenge's own board intents
// (runtime-discovered state, never baked knowledge).
const FANOUT_WORKERS = 3;
const FANOUT_WALL_MIN = 34;
function fanoutDirections(code) {
  const board = boardFor(code);
  const dirs = [];
  const topIntent = board.intents.find((intent) => !intent.done);
  dirs.push(topIntent
    ? `主线深化:严格沿黑板待办意图推进到实际读出 flag——${topIntent.text}`
    : "主线深化:沿黑板已验证事实中最接近 flag 的原语/立足点推进到实际读出 flag,严禁重推已验证内容");
  dirs.push("横向展开:枚举题面与接口中尚未测试的次要功能面、边缘参数与隐藏路由,寻找主线之外的入口;与黑板上已排除路径严格去重");
  dirs.push("静态重审:重读题面原文、附件与历史响应差异(错误页/注释/响应头/默认凭据),结合 flag 狩猎清单从静态线索直接定位 flag 来源");
  return dirs.slice(0, FANOUT_WORKERS);
}

async function solveFanOut(challenge) {
  const code = challenge.unique_code;
  const lane = process.env.TSEC_LANE ?? "main";
  if (!claimCode(code, lane)) {
    console.warn(`[tsec] ${code} is claimed by lane ${claimFor(code)?.lane ?? "?"}; skipping`);
    throw Object.assign(new Error("already_claimed"), { claimed: true });
  }
  const claimedAt = Date.now();
  registerWatch(code, null, 90 * 60_000); // episode-wide horizon: workers + settles
  try {
    console.log(`[tsec] fan-out retry ${code} (${challenge.difficulty}, ${challenge.total_score}pts): ${FANOUT_WORKERS} directed workers`);
    const ready = await ensureContainer(challenge);
    const addrs = (ready.container_addr ?? []).filter(Boolean);
    if (addrs.length === 0) {
      console.warn(`[tsec] container for ${code} never became ready; skipping`);
      ledgerMark(code, "miss");
      return false;
    }
    boardContainer(code, addrs); // R16 instance lifecycle
    let reachable = await probeVpn(addrs);
    if (!reachable) { await sleep(10_000); reachable = await probeVpn(addrs); }
    if (!reachable) throw Object.assign(new Error("vpn_unreachable"), { vpnDown: true });

    const dirs = fanoutDirections(code);
    const deadline = Date.now() + FANOUT_WALL_MIN * 60_000;
    const parentRunId = freshEyes ? null : lastrunFor(code);
    const runIds = [];
    let solvedFlag = false;
    let stopped = false;
    const stopAll = async () => {
      if (stopped) return;
      stopped = true;
      for (const id of runIds) await stopRun(id);
    };

    // Completion poller: any worker's self-submit banks the flag platform-side
    // — the siblings must stop instead of grinding a solved challenge.
    const poller = (async () => {
      while (!stopped && !solvedFlag && Date.now() < deadline) {
        await sleep(45_000);
        if (stopped || solvedFlag) return;
        try {
          const fresh = (await listChallenges()).find((item) => item.unique_code === code);
          if (fresh?.is_completed) {
            console.log(`[tsec] fan-out ${code}: platform shows completed — stopping siblings`);
            solvedFlag = true;
            await stopAll();
          }
        } catch (error) {
          if (isTaskEnded(error)) { await stopAll(); throw error; }
        }
      }
    })();

    const worker = async (direction, index) => {
      const budgetMin = Math.max(12, Math.round((deadline - Date.now()) / 60_000));
      const task = buildTask(ready, budgetMin, `${direction}。(同题并行协作纪律:同一题还有兄弟会话在跑,共享黑板互通;开工第一步先 read_shared_evidence 看兄弟已发布的事实与死端,严禁重走已排除的路径;自己每排除一条路径或验证一个关键事实,立即用 checkpoint 记录假设状态——证伪的假设会实时广播给兄弟会话,也可直接 publish_shared_evidence;并发连接≤2、只读优先,严禁重启或破坏性操作)`);
      const created = await xuanshu("/v1/runs", {
        method: "POST",
        body: JSON.stringify({
          task,
          metadata: { source: "question-bank", questionId: `tsec-${code}-fan${index}`, ...(categoryOf(code) ? { category: categoryOf(code) } : {}) },
          evidenceGroup: `tsec-${code}`, // R11: siblings share the live board
          discipline: disciplineFor(code),
          // R16 racer diversity: spread thinking depth the way top agents
          // spread temperature — low runs the high-probability path, high
          // reaches for structurally different chains.
          thinkingLevel: ["low", "medium", "high"][index % 3],
          ...(parentRunId ? { lineage: { parentRunId } } : {}),
        }),
      });
      if (created.status !== 202) throw new Error(`fan-out run create failed: ${created.status}`);
      const runId = created.json.id;
      runIds.push(runId);
      writeLastrun(code, runId);
      console.log(`[tsec] fan-out worker ${index + 1}/${dirs.length} run ${runId.slice(0, 8)}: ${direction.slice(0, 70)}`);
      const terminal = await watchRun(runId, Math.max(60_000, deadline - Date.now()), code);
      await bankKnowledge(code, runId); // R10: per-worker lessons also reach the shared ledger
      if (!terminal) {
        await record({ challenge: code, runId, outcome: "fanout-worker-timeout" });
        return false;
      }
      const findings = findingsTexts(terminal.findings).slice(0, 8);
      writeHandoff(code, { from: runId, at: new Date().toISOString(), summary: `[定向:${direction.slice(0, 40)}] ${String(terminal.summary ?? "").slice(0, 900)}`, findings });
      boardUpdate(code, {
        facts: findings,
        intents: (Array.isArray(terminal.nextSteps) ? terminal.nextSteps : []).filter((s) => typeof s === "string").slice(0, 4).map((text) => ({ text, needs: "" })),
      });
      const submission = terminal.submission ?? null;
      if (terminal.status === "completed" && submission) {
        try {
          const verdict = await submitFlag(code, submission);
          if (verdict?.correct === true) {
            solvedFlag = true;
            recordAccepted(code, submission);
            ledgerMark(code, "solved", { progress: verdict.correct_flag_count });
            ledgerNoteProgress(code, verdict.correct_flag_count);
            await record({ challenge: code, runId, outcome: "fanout-submitted", submission });
            await stopAll();
            return true;
          }
          recordRejected(code, submission);
          await record({ challenge: code, runId, outcome: "rejected", submission, verdict });
        } catch (error) {
          if (isDuplicate(error)) {
            solvedFlag = true;
            recordAccepted(code, submission);
            await stopAll();
            return true;
          }
          if (isTaskEnded(error)) throw Object.assign(error, { taskEnded: true });
          throw error;
        }
      }
      // Settled without a correct relay — a self-submit may still have banked
      // platform-side during the run (same completion pre-check as solveOne).
      try {
        const fresh = (await listChallenges()).find((item) => item.unique_code === code);
        if (fresh?.is_completed) {
          solvedFlag = true;
          ledgerMark(code, "solved", { progress: fresh.correct_flag_count });
          ledgerNoteProgress(code, fresh.correct_flag_count);
          boardClear(code);
          await closeChallenge(code);
          await stopAll();
          return true;
        }
      } catch (error) {
        if (isTaskEnded(error)) throw Object.assign(error, { taskEnded: true });
      }
      return false;
    };

    const outcomes = await Promise.allSettled(dirs.map((direction, index) => worker(direction, index)));
    stopped = true;
    await Promise.allSettled([poller]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected" && isTaskEnded(outcome.reason)) {
        throw Object.assign(new Error("benchmark task ended"), { taskEnded: true });
      }
    }
    if (solvedFlag) return true;
    ledgerMark(code, "miss");
    await record({ challenge: code, outcome: "fanout-miss" });
    await settleMiss(code, challenge); // R9: pay the hint now; release or keep-warm the slot
    return false;
  } finally {
    clearWatch(code);
    releaseClaim(code);
    ledgerAddSpent(code, Math.round((Date.now() - claimedAt) / 60_000));
  }
}

// Order (round-2, value-density): multi-flag chains FIRST regardless of
// current progress — they serialize over several runs, so starting them late
// is how round 1 never opened the pool's highest-value
// challenge before the task ended. Within chains: more remaining flags then higher score.
// Singles keep the old shape: easier first, higher score first.
const chainOf = (c) => (c.flag_count ?? 1) > 1 && remainingOf(c) > 0;
const byPriority = (a, b) =>
  ((chainOf(b) ? 1 : 0) - (chainOf(a) ? 1 : 0))
  || (chainOf(a) && chainOf(b)
    ? ((remainingOf(b) - remainingOf(a)) || ((b.total_score ?? 0) - (a.total_score ?? 0)))
    : 0)
  || ((DIFFICULTY_RANK[String(a.difficulty ?? "").toLowerCase()] ?? 3) - (DIFFICULTY_RANK[String(b.difficulty ?? "").toLowerCase()] ?? 3))
  || (remainingOf(a) - remainingOf(b))
  || ((b.total_score ?? 0) - (a.total_score ?? 0))
  || ((a.level ?? 0) - (b.level ?? 0));

// Fallback submissions: values the agent verified but could not self-submit
// (endpoint hiccup, missed turn) surface as VERIFIED_FLAG findings. They are
// agent-derived and double-read — but a rejected harvest stops the run's
// remaining values (verification discipline suspect).
async function harvestFlags(code, terminal) {
  const acceptedSet = new Set(readLedger().accepted[code] ?? []);
  const rejectedSet = new Set(rejectedValues(code));
  const values = [];
  const sources = [...(Array.isArray(terminal.findings) ? terminal.findings : []), String(terminal.summary ?? "")];
  for (const source of sources) {
    for (const match of String(source).matchAll(/VERIFIED_FLAG:\s*([^\s"']+)/g)) {
      // findingsTexts concatenates "title: description", so the concat colon
      // rides along on the captured value (plain-string findings have none).
      const value = match[1].trim().replace(/:$/, "");
      if (value && !acceptedSet.has(value) && !rejectedSet.has(value) && !values.includes(value)) values.push(value);
    }
  }
  if (values.length === 0) return;
  console.log(`[tsec] harvest: ${values.length} verified flag value(s) from run findings`);
  for (const value of values) {
    let verdict;
    try {
      verdict = await submitFlag(code, value);
    } catch (error) {
      if (isDuplicate(error)) { recordAccepted(code, value); console.log(`[tsec] harvest duplicate (already correct): ${value}`); continue; }
      if (isTaskEnded(error)) throw Object.assign(error, { taskEnded: true });
      throw error;
    }
    await record({ challenge: code, outcome: "harvest", submission: value, verdict });
    console.log(`[tsec] harvest verdict: ${JSON.stringify(verdict)}`);
    if (verdict?.correct === true) {
      recordAccepted(code, value);
      const fullyDone = verdict.correct_flag_count >= verdict.total_flag_count;
      ledgerMark(code, fullyDone ? "solved" : "partial", { progress: verdict.correct_flag_count });
      ledgerNoteProgress(code, verdict.correct_flag_count);
      boardUpdate(code, { facts: [`flag${verdict.correct_flag_count} 收割入账: ${value} (平台确认)`], solvedIntentSubstr: value.slice(0, 24) });
      if (fullyDone) {
        try { rmSync(handoffPath(code), { force: true }); } catch { /* best effort */ }
        boardClear(code);
        await closeChallenge(code);
        return; // challenge complete
      }
    } else {
      recordRejected(code, value);
      console.warn(`[tsec] harvest rejected — run's remaining values disqualified: ${value}`);
      return;
    }
  }
}

// (R17) attemptCap/hardSpentCapped were removed with the stop-loss ruling;
// miss counts no longer gate eligibility anywhere — ordering only.
function pickNext(items, role = "mixed", forceFresh = false) {
  const ledger = readLedger();
  const eligible = items
    .filter((item) => {
      if (item.is_completed || claimFor(item.unique_code)) return false;
      const done = ledger.done[item.unique_code];
      if (done?.status === "solved") return false;
      // R21 metronome quarantine: benched after 2 consecutive fast no-submission
      // settles; expiry re-arms it (a relapse re-quarantines after 2 more).
      if (done?.quarantineUntil && Date.now() < done.quarantineUntil) return false;
      // R17: no miss/spent parking (operator ruling: budgets are pure
      // downside; unlimited tokens, solve instead of park). Ordering — not
      // eligibility — decides who runs next; reviveParked cooldowns remain
      // the only anti-spin guard for genuinely broken environments.
      return true;
    });
  // Lane roles (R4: 3 deep + 1 prospector):
  //  - deep: hard singles + chains (the long-budget grinders; scratch
  //    inheritance makes their retries cumulative). Falls back to ALL eligible
  //    when the deep pool is empty (prevents idle lanes).
  //  - prospector: fresh (never-attempted) opens only — compressed probes on
  //    ALL difficulties (not just hard): easy 20min / medium 30min / hard 30min.
  //    R4: also covers easy/medium fresh which R3's prospector skipped,
  //    leaving low-hanging fruit untouched. forceFresh is the same override
  //    applied reactively after two retry misses on one lane.
  //  - sweep: singles only (legacy); chain: chains while any remain.
  const chains = eligible.filter((c) => (c.flag_count ?? 1) > 1);
  const fresh = eligible.filter((c) => !ledger.done[c.unique_code]);
  const wantFresh = (role === "prospector" || forceFresh) && fresh.length > 0;
  const deepPool = eligible.filter((c) => (c.flag_count ?? 1) > 1
    || (DIFFICULTY_RANK[String(c.difficulty ?? "").toLowerCase()] ?? 3) >= 2);
  // Prospector priority: hard fresh first (high value quick wins), then medium,
  // then easy. This ensures the prospector doesn't waste time on easy re-probes
  // while hard fresh challenges sit untouched.
  const prospectorPool = wantFresh
    ? fresh.sort((a, b) =>
        // Hard chains first, then hard singles, then medium, then easy
        ((chainOf(b) ? 1 : 0) - (chainOf(a) ? 1 : 0))
        || ((DIFFICULTY_RANK[String(b.difficulty ?? "").toLowerCase()] ?? 3) - (DIFFICULTY_RANK[String(a.difficulty ?? "").toLowerCase()] ?? 3))
        || ((b.total_score ?? 0) - (a.total_score ?? 0)))
    : null;
  // Early-run harvest sweep (R5, live-run 28506 lesson): while ≥4 fresh
  // easy/medium singles sit unopened, EVERY lane takes them first — fast-track
  // conversions run 3-5 min at 200-500pts (04/07/20: 950pts in 9 lane-minutes)
  // while two lanes pinned on two hard singles produced zero for 100+ minutes.
  // Once the shallow pool is drained below the threshold, normal role logic
  // (deep grind / prospector) resumes.
  const sweepPool = fresh
    .filter((c) => (c.flag_count ?? 1) === 1 && (DIFFICULTY_RANK[String(c.difficulty ?? "").toLowerCase()] ?? 3) <= 1)
    .sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));
  // Truncated-attempt rescue (R6): the 28506 tail was a conveyor of half-
  // attempts — single-flag challenges whose ONLY run banked a rich board
  // (>=3 facts) and then hit the clock mid-attack (27 was still planning its
  // next probe 90s before the end; 21 died testing mass assignment). One miss
  // + a rich board is the strongest conversion signal in the pool; re-queue
  // those ahead of role pools (but behind the sweep — fresh e/m are surer).
  const richRetryPool = eligible.filter((c) => {
    const done = ledger.done[c.unique_code];
    if (!done || (done.misses ?? 0) !== 1 || (c.flag_count ?? 1) !== 1) return false;
    if (!existsSync(boardPath(c.unique_code))) return false;
    const board = boardFor(c.unique_code);
    return (board.facts?.length ?? 0) >= 3;
  }).sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));
  // Hint-armed revives (R9): the deduction is already paid — further attempts
  // must carry the hint, and must not queue behind fresh picks until the
  // endgame (the 29070 deadlock: hint due at 2 misses, container evicted 13s
  // later, pull never happened). Sits ABOVE rich-retry/prospector but BELOW
  // the fresh shallow sweep — fresh easy/medium conversions are still surer.
  const hintRetryPool = eligible.filter((c) => {
    if (!hintFor(c.unique_code)?.hint) return false;
    const done = ledger.done[c.unique_code];
    return done && (done.misses ?? 0) >= 1;
  }).sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));
  const pool = sweepPool.length >= 4
    ? sweepPool
    : hintRetryPool.length > 0 ? hintRetryPool
    : richRetryPool.length > 0 ? richRetryPool
    : prospectorPool
    ?? (role === "deep" && deepPool.length > 0 ? deepPool
    : role === "deep" ? eligible // fallback: don't idle deep lanes
    : role === "sweep" ? eligible.filter((c) => (c.flag_count ?? 1) === 1)
    : role === "chain" && chains.length > 0 ? chains
    : eligible);
  // Do NOT re-sort the sweep/prospector pools through byPriority: it orders
  // easy-before-hard, silently dead-lettering both role-specific orderings
  // (R4's prospector "hard fresh first" never actually fired — found in the
  // R5 live-run review). Those pools keep their own order; everything else
  // falls through to the shared value-density sort.
  if (sweepPool.length >= 4) return sweepPool[0];
  // R17 coverage floor: every challenge earns an initial recon slice — after
  // two consecutive warm picks, a never-attempted challenge outranks even an
  // A-bucket frontier (29070: four codes were never opened at all while warm
  // retries cycled). The prospector lane is already fresh-only.
  if (fresh.length > 0 && warmPickStreak >= 2 && role !== "prospector" && !forceFresh) {
    const top = fresh.slice().sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0))[0];
    return { ...top };
  }
  // R16 value/endgame ordering: past the opening sweep the pool is ordered by
  // expected score rate, not easy-before-hard (rank 1 vs 5 came from three
  // high-value tail flags). A/B buckets fan out into parallel racers; the
  // endgame fans out every pick (Cruiser tail solving). Breadth keeps the
  // R4-R9 pool precedence unchanged.
  if (currentPhase !== "breadth") {
    const ranked = eligible.slice().sort((a, b) => expectedScoreRate(b) - expectedScoreRate(a));
    if (ranked.length > 0) {
      const bucket = evidenceBucket(ranked[0]);
      return { ...ranked[0], fanout: currentPhase === "endgame" || bucket === "A" || bucket === "B" };
    }
  }
  if (hintRetryPool.length > 0) return { ...hintRetryPool[0], fanout: true };
  if (richRetryPool.length > 0) return { ...richRetryPool[0], fanout: true };
  if (prospectorPool) return prospectorPool[0];
  return pool.sort(byPriority)[0] ?? null;
}

// Hint gate (R9 -> R17 operator policy): prefer the no-hint full score, buy
// the hint only when genuinely stuck — TWO unaided misses (the first attempt
// might be a near-miss), or ONE in the endgame where remaining wall-clock
// outweighs the per-view deduction. Pulling still happens at settle time
// (the 29070 deadlock: hint armed at build-time only, container evicted
// before the next build). Infra suspects never reach here: fast no-submission
// settles don't count a miss upstream.
function hintDue(misses) {
  return misses >= (currentPhase === "endgame" ? 1 : 2);
}

// R20: hints and rescue dispatch used to arm ONLY on settled misses — but an
// exploration-stuck challenge never submits anything, so it can grind one
// hypothesis for hours with no miss ever recorded (29896: bctf2026-22 burned
// 4h across two attempts on a JNDI path that never fired). Wall-time invested
// with zero platform progress counts as one miss once it crosses the arm
// threshold, unlocking the hint pull and the fallback-model lens.
const STUCK_ARM_MIN = 75;
function effectiveMisses(code) {
  const done = readLedger().done[code] ?? {};
  const misses = done.misses ?? 0;
  if ((done.progress ?? 0) > 0) return misses; // partial credit = it is converting
  const w = watchFor(code);
  const liveMin = w ? Math.max(0, (Date.now() - Date.parse(w.at)) / 60_000) : 0;
  const spentMin = (done.spentMin ?? 0) + liveMin;
  return misses + (spentMin >= STUCK_ARM_MIN ? 1 : 0);
}

// No-hint finals: once the platform hint endpoint proves absent (persistent
// failure after the api() retry ladder), stop paying for the probe on every
// settle — the rescue dispatch below replaces hints as the unstick tool.
let hintsUnavailable = false;

async function maybePullHint(code, misses) {
  if (hintsUnavailable || hintFor(code) || !hintDue(misses)) return;
  try {
    const result = await api("/openapi/v1/challenges/hint", { query: { unique_code: code } });
    const text = typeof result?.hint === "string" ? result.hint.trim() : "";
    // Cache even the empty answer: "no hint exists" must not be re-queried
    // (every view of a real hint re-charges; assume the view already cost).
    writeFileSync(hintPath(code), JSON.stringify({ code, hint: text, pulledAt: new Date().toISOString() }, null, 2));
    await record({ challenge: code, outcome: "hint-pulled", hasHint: text !== "", misses });
    console.log(`[tsec] hint pulled for ${code} (misses=${misses}): ${text ? text.slice(0, 120) : "(challenge has no hint)"}`);
  } catch (error) {
    if (isTaskEnded(error)) throw error;
    console.warn(`[tsec] hint pull failed for ${code}: ${error.message}`);
    hintsUnavailable = true;
    console.warn("[tsec] hint endpoint unavailable — treating this run as a no-hint final; rescue dispatch (fallback model) replaces hints");
  }
}

// Rescue dispatch (no-hint finals): at the point hints used to arm (2 unaided
// misses; 1 in endgame), route the challenge's NEXT attempt to the fallback
// model via modelRole — a genuinely different lens, carrying the shared board
// so it does not start blind. Alternates afterwards: every other attempt gets
// the second lens while GLM keeps the majority.
function rescueModelRole(misses) {
  // No fallback provisioned (env unset or inert) → never dispatch the
  // fallback role: runtime rejects the run outright and burns the slot.
  if (!process.env.XUANSHU_FALLBACK_API_KEY) return undefined;
  if (!hintDue(misses)) return undefined;
  const past = Math.max(0, misses - (currentPhase === "endgame" ? 1 : 2));
  return past % 2 === 0 ? "fallback" : undefined;
}

// R9: pay the hint AND settle the container at miss time. The pull must not
// wait for the next task build (fresh-first picking starves 2-miss codes
// until the endgame), and the container must not squat an instance slot
// with nobody working it: hint-armed revives keep it warm, everything else
// releases immediately (run 29070: bctf2026-02 sat unclaimed on a slot
// ~30min before eviction, burning a third of the lane capacity).
async function settleMiss(code, challenge, { pullHint = true } = {}) {
  const misses = effectiveMisses(code);
  if (pullHint) {
    try {
      await maybePullHint(code, misses);
    } catch (error) {
      console.warn(`[tsec] hint pull for ${code} failed (${error?.message ?? error}); settling without`);
    }
  }
  const hint = hintFor(code)?.hint;
  const ledger = readLedger();
  if (hint) {
    console.log(`[tsec] ${code} miss settled with hint armed (${misses} misses); keeping container warm for the revive`);
    // R20: keep-warm is now an explicit, time-bounded marker — the watchdog
    // must be able to tell an intentional park from a leaked container.
    ledger.done[code] = { ...ledger.done[code], warmUntil: Date.now() + 30 * 60_000, at: new Date().toISOString() };
    writeLedger(ledger);
    return;
  }
  console.log(`[tsec] ${code} miss settled; releasing container slot`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await closeChallenge(code); return; } catch (error) {
      if (isTaskEnded(error)) throw error;
      console.warn(`[tsec] close ${code} attempt ${attempt}/3 failed: ${error?.message ?? error}`);
      await sleep(3_000 * attempt);
    }
  }
}

// ------------------------------------------- slot-hold join worker (R13)
// 29070 post-mortem: the platform's 3-container cap parked the other half of
// the fleet in 60s hold loops (145 slot-full retries in 62 minutes) while
// three single-stream runs under-used their containers. A lane stuck on a
// slot hold burns zero capacity; every second consecutive hold instead joins
// the strongest LIVE challenge as one extra directed worker — no new
// container needed, and the worker shares the challenge's R11 live evidence
// board with whatever runs are already in flight on it.
const JOIN_BUDGET_MIN = 25;
async function joinActiveWorker(items) {
  const ledger = readLedger();
  const live = items.filter((item) => {
    if (item.is_completed) return false;
    const addrs = item.container_addr ?? [];
    if (addrs.length === 0 && item.container_status !== "available") return false;
    const done = ledger.done[item.unique_code];
    // Only join fronts that are already open — a never-attempted code has no
    // live container to share; opening one from a hold would just race the
    // next slot pick for the same scarcity.
    if (!done || done.status === "solved") return false;
    return !joinEpisodeCodes.has(item.unique_code);
  }).sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));
  const target = live[0];
  if (!target) return false;
  const code = target.unique_code;
  joinEpisodeCodes.add(code);
  console.log(`[tsec] slot-hold join: extra worker on ${code} (${JOIN_BUDGET_MIN}min, shares its live board)`);
  const task = buildTask({ ...target, container_status: "available" }, JOIN_BUDGET_MIN,
    "加援产能:你是在既有工作会话之外临时加入的额外会话,选一条黑板未覆盖的独立新路,严禁重复已排除路径;开工先 read_shared_evidence。(并发连接≤2、只读优先,严禁重启或破坏性操作)");
  const created = await xuanshu("/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      task,
      metadata: { source: "question-bank", questionId: `tsec-${code}-join` },
      evidenceGroup: `tsec-${code}`, // R11: share the live board with in-flight runs
      discipline: disciplineFor(code),
      thinkingLevel: "high", // R16: the join worker hunts a NEW chain, not the obvious one
    }),
  });
  if (created.status !== 202) return false;
  const runId = created.json.id;
  const terminal = await watchRun(runId, JOIN_BUDGET_MIN * 60_000, code);
  await bankKnowledge(code, runId);
  if (!terminal) {
    console.warn(`[tsec] join worker budget exhausted on ${code}; stopping run`);
    await stopRun(runId);
  }
  return true;
}

// Cruiser tier-3 semantics: an unsolved challenge is never parked forever.
// When nothing is eligible, re-open the parked set with fresh miss budgets —
// a 30-minute per-code cooldown keeps genuinely broken environments to at
// most two probes an hour instead of burning every idle poll.
const REVIVE_COOLDOWN_MS = 30 * 60_000;
function reviveParked(items) {
  const ledger = readLedger();
  const now = Date.now();
  const revived = [];
  for (const item of items) {
    const done = ledger.done[item.unique_code];
    if (!done || done.status === "solved" || (done.misses ?? 0) < 1) continue;
    // R16: the endgame revives faster — a 30-min cooldown on the last eight
    // challenges is 1/12th of the remaining clock spent waiting.
    const cooldown = currentPhase === "endgame" ? 10 * 60_000 : REVIVE_COOLDOWN_MS;
    if (now - Date.parse(done.revivedAt ?? 0) < cooldown) continue; // NaN (never revived) passes
    ledger.done[item.unique_code] = { ...done, misses: 0, revivedAt: new Date().toISOString() };
    revived.push(item.unique_code);
  }
  if (revived.length === 0) return false;
  writeLedger(ledger);
  console.warn(`[tsec] tier cycle: re-opening parked challenges ${revived.join(", ")} with fresh miss budgets`);
  return true;
}

// ---------------------------------------------------------------- commands

async function cmdLoop() {
  if (!SERVER_TOKEN) die("XUANSHU_SERVER_TOKEN missing in .env");
  const role = process.env.TSEC_ROLE ?? "mixed";
  if (role !== "mixed") console.log(`[tsec] lane role: ${role}`);
  let consecutiveMisses = 0;
  // R13 slot-hold join: consecutive slot-full holds per lane, and the codes
  // already joined this hold episode (reset once the lane wins a slot again).
  let slotHoldStreak = 0;
  // Retry fatigue (round 3): two warm-retry misses in a row on this lane
  // force the next pick to a fresh (never-attempted) open — the drought's
  // 0/14 conversion came from lanes cycling warm retries while fresh hards
  // sat untouched.
  let retryMisses = 0;
  let lastIterationAt = Date.now();
  try {
  while (true) {
    const iterationStart = Date.now();
    // Freeze guard: a multi-minute wall-time jump means the host (or VM) was
    // suspended; verify the stack before burning any platform time.
    if (iterationStart - lastIterationAt > 15 * 60_000) {
      console.warn(`[tsec] wall-clock jump of ${Math.round((iterationStart - lastIterationAt) / 60_000)} min — freeze/sleep recovery; verifying stack stability`);
      for (let probe = 0; probe < 6; probe++) {
        if (await apiHealthy()) break;
        console.warn("[tsec] API not healthy after freeze; waiting 60s");
        await sleep(60_000);
      }
      await sleep(60_000);
    }
    try {
      if (consecutiveMisses >= 4) {
        console.warn("[tsec] four challenges missed in a row — pausing 10 minutes");
        await sleep(600_000);
        consecutiveMisses = 0;
      }
      if (!(await apiHealthy())) {
        console.warn(`[tsec] ${new Date().toISOString()} xuanshu API unreachable — holding; retrying in 60s`);
        await sleep(60_000);
        continue;
      }
      await ensureModel();

      let items;
      try {
        items = await listChallenges();
      } catch (error) {
        if (isTaskEnded(error)) {
          console.warn("[tsec] benchmark task ended (invalid_state) — loop exiting");
          return 0;
        }
        console.warn(`[tsec] list failed (${error.message}); retrying in 60s`);
        await sleep(60_000);
        continue;
      }
      // Sync platform-confirmed progress into the ledger (resets miss counts).
      for (const item of items) {
        if ((item.correct_flag_count ?? 0) > 0) ledgerNoteProgress(item.unique_code, item.correct_flag_count);
      }
      // R20 watchdog: open containers with no live owner get reclaimed here,
      // so a crashed/wedged settle can no longer freeze the fleet's slots.
      try {
        await reconcileSlots(items);
      } catch (error) {
        if (isTaskEnded(error)) {
          console.warn("[tsec] benchmark task ended (invalid_state) — loop exiting");
          return 0;
        }
        console.warn(`[tsec] slot reconcile failed (${error.message}); continuing`);
      }
      const phase = phaseOf(items, Date.now());
      if (phase !== currentPhase) {
        console.warn(`[tsec] phase shift: ${currentPhase} -> ${phase} (unsolved=${items.filter((item) => !item.is_completed).length})`);
        currentPhase = phase;
      }
      const candidate = pickNext(items, role, retryMisses >= 2);
      if (!candidate) {
        const remaining = items.filter((item) => !item.is_completed);
        if (remaining.length === 0) { console.log("[tsec] all challenges completed — loop exiting"); return 0; }
        if (reviveParked(remaining)) continue;
        console.log(`[tsec] all ${remaining.length} remaining challenges parked within revive cooldown — waiting 5 minutes`);
        await sleep(300_000);
        continue;
      }
      const wasFresh = !readLedger().done[candidate.unique_code];
      warmPickStreak = wasFresh ? 0 : warmPickStreak + 1;
      try {
        // Rich-retry picks fan out into directed workers (R7) instead of a
        // single-stream retry; everything else keeps the one-run-per-pick shape.
        const solved = candidate.fanout ? await solveFanOut(candidate) : await solveOne(candidate);
        consecutiveMisses = solved ? 0 : consecutiveMisses + 1;
        retryMisses = solved || wasFresh ? 0 : retryMisses + 1;
        slotHoldStreak = 0; // a real pick resets the hold episode
        joinEpisodeCodes.clear();
        if (!solved && !wasFresh && retryMisses >= 2) console.warn(`[tsec] ${retryMisses} warm-retry misses in a row — next pick forced fresh`);
      } catch (error) {
        if (error.taskEnded || isTaskEnded(error)) {
          console.warn("[tsec] benchmark task ended — loop exiting");
          return 0;
        }
        if (error.vpnDown) {
          console.warn("[tsec] waiting 5 minutes for the SSLVPN to come up");
          await sleep(300_000);
        } else if (error.infraWall) {
          // Three fast no-submission settles in a row = quota/model wall
          // (2026-10-09 20:15-20:24 burned six short runs against one).
          // Back off long enough to clear a refresh boundary, then resume.
          console.warn("[tsec] suspected infra wall — pausing lane 15 minutes");
          fastFails = 0;
          consecutiveMisses = 0;
          await sleep(15 * 60_000);
        } else if (error.claimed) {
          // Another lane re-claimed between our pickNext and claimCode (the
          // holder releases its claim during slot-holds, reopening the race
          // window every 60s). A short pause — a full minute per lost race
          // starved lane-c through the 20:15-20:24 window.
          console.warn("[tsec] solveOne crashed: already_claimed; re-picking in 15s");
          await sleep(15_000);
        } else if (error.slotsBusy) {
          // R13: a lane that cannot win a container slot stops idling —
          // every second consecutive hold spends 25 minutes as an extra
          // directed worker on the strongest already-live challenge (its
          // container is running; no new slot is claimed).
          slotHoldStreak += 1;
          if (slotHoldStreak >= 2) {
            try {
              await joinActiveWorker(items);
            } catch (joinError) {
              if (joinError.taskEnded || isTaskEnded(joinError)) throw joinError;
              console.warn(`[tsec] slot-hold join failed (${joinError?.message ?? joinError}); falling back to hold`);
              await sleep(60_000);
            }
          } else {
            await sleep(60_000);
          }
        } else {
          console.warn(`[tsec] solveOne crashed: ${error?.message ?? error}; pausing 60s`);
          await sleep(60_000);
        }
      }
      await sleep(10_000);
    } finally {
      lastIterationAt = Date.now();
    }
  }
  } finally {
    // Any exit path (task ended, all completed) must not strand claims this
    // lane still holds — the 55-min staleness window is a long lockout.
    releaseOwnClaims();
  }
}

async function cmdList() {
  const items = await listChallenges();
  const ledger = readLedger();
  for (const item of items.sort(byPriority)) {
    const done = ledger.done[item.unique_code];
    console.log(`${String(item.total_score ?? 0).padStart(4)}pts ${String(item.difficulty ?? "?").padStart(6)} L${item.level ?? "?"} flags ${item.correct_flag_count}/${item.flag_count} ${item.container_status.padEnd(12)} ${(item.container_addr ?? []).join(",")} ${item.unique_code}${done ? ` ledger=${done.status}/${done.misses ?? 0}` : ""}${item.is_completed ? " DONE" : ""}`);
    if (item.description) console.log(`    ${String(item.description).slice(0, 120)}`);
  }
  const active = items.filter((item) => ["pending", "available", "stop_pending"].includes(item.container_status));
  console.log(`total=${items.length} active=${active.length}/3 remaining=${items.filter((item) => !item.is_completed).length}`);
  return 0;
}

async function cmdRun(code) {
  const items = await listChallenges();
  const challenge = items.find((item) => item.unique_code === code);
  if (!challenge) die(`challenge ${code} not found`);
  const solved = await solveOne(challenge);
  return solved ? 0 : 1;
}

// ARTEX-style coverage view: the interesting question is not what is solved
// but WHICH challenges carry no test records at all — those are blind spots
// the priority sort can quietly starve (round 1 never opened the pool's highest-value challenge).
async function cmdStatus() {
  const items = await listChallenges();
  const ledger = readLedger();
  const untouched = [];
  for (const item of items.sort(byPriority)) {
    const code = item.unique_code;
    const done = ledger.done[code];
    const claim = claimFor(code);
    const board = existsSync(boardPath(code)) ? boardFor(code) : null;
    if (!done && !board && !claim && !(item.correct_flag_count > 0)) untouched.push(code);
    console.log(`${item.is_completed ? "DONE" : "    "} ${code.padEnd(6)} flags ${item.correct_flag_count}/${item.flag_count} facts=${board?.facts.length ?? 0} intents=${board?.intents.length ?? 0} hints=${board?.hints.length ?? 0} misses=${done?.misses ?? 0}${done ? ` status=${done.status}` : ""}${claim ? ` claimed=${claim.lane}` : ""}`);
  }
  console.log(`\n未触碰(无任何测试记录): ${untouched.join(", ") || "(无)"}`);
  return 0;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  // Accept both --flag=value and --flag value (the usage line shows the space
  // form; the first dry run submitted the literal "--flag" without it).
  const flag = (name) => {
    const prefix = `--${name}=`;
    const inline = args.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = args.indexOf(`--${name}`);
    const next = index >= 0 ? args[index + 1] : undefined;
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };
  switch (command) {
    case "loop": return cmdLoop();
    case "list": return cmdList();
    case "status": return cmdStatus();
    case "steer": {
      // Cairn Hint channel: the formal 人工介入 loop — an operator correction
      // banked here is carried verbatim into the next task build for the code.
      const code = flag("code") ?? args[0];
      const text = flag("text") ?? args[1];
      if (!code || !text) die('usage: tsec.mjs steer --code <unique_code> --text "..."');
      const board = boardUpdate(code, { hints: [text] });
      console.log(`[tsec] steer ${code}: hint banked (hints=${board.hints.length}, facts=${board.facts.length})`);
      return 0;
    }
    case "run": {
      const code = flag("code") ?? args[0];
      if (!code) die("usage: tsec.mjs run --code <unique_code>");
      return cmdRun(code);
    }
    case "start": {
      const code = flag("code") ?? args[0];
      if (!code) die("usage: tsec.mjs start --code <unique_code>");
      const result = await api("/openapi/v1/challenges/start", { method: "POST", query: { unique_code: code } });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case "submit": {
      const code = flag("code") ?? args[0];
      const value = flag("flag") ?? args[1];
      if (!code || !value) die("usage: tsec.mjs submit --code <unique_code> --flag <flag>");
      try {
        const verdict = await submitFlag(code, value);
        console.log(JSON.stringify(verdict, null, 2));
      } catch (error) {
        if (isDuplicate(error)) { console.log("duplicate: this flag value was already banked as correct (no award, no penalty)"); return 0; }
        throw error;
      }
      return 0;
    }
    case "close": {
      const code = flag("code") ?? args[0];
      if (!code) die("usage: tsec.mjs close --code <unique_code>");
      await closeChallenge(code);
      return 0;
    }
    case "hint": {
      const code = flag("code") ?? args[0];
      if (!code) die("usage: tsec.mjs hint --code <unique_code>  (WARNING: viewing a hint deducts score)");
      const hint = await api("/openapi/v1/challenges/hint", { query: { unique_code: code } });
      console.log(JSON.stringify(hint, null, 2));
      return 0;
    }
    case "check": {
      // VPN reachability probe for every challenge with a live container.
      const items = await listChallenges();
      let anyFail = false;
      for (const item of items) {
        const addrs = (item.container_addr ?? []).filter(Boolean);
        if (addrs.length === 0) continue;
        const reachable = await probeVpn(addrs);
        anyFail ||= !reachable;
        console.log(`${reachable ? "OK  " : "FAIL"} ${item.unique_code} ${addrs.join(",")}`);
      }
      if (anyFail) console.log("FAIL = address unreachable from this host — connect the task's SSLVPN first");
      return anyFail ? 1 : 0;
    }
    default:
      console.log("Usage:\n  node tools/arena/tsec.mjs loop\n  node tools/arena/tsec.mjs list\n  node tools/arena/tsec.mjs status                     (coverage: boards/misses/claims + untouched list)\n  node tools/arena/tsec.mjs run --code <unique_code>\n  node tools/arena/tsec.mjs start|close --code <unique_code>\n  node tools/arena/tsec.mjs submit --code <unique_code> --flag <flag>\n  node tools/arena/tsec.mjs steer --code <unique_code> --text \"...\"   (operator hint into next task build)\n  node tools/arena/tsec.mjs hint --code <unique_code>   (deducts score; operator-only)\n  node tools/arena/tsec.mjs check                       (VPN reachability probe)");
      return command ? 1 : 0;
  }
}

process.exit(await main());

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
//  - Wrong submissions carry NO penalty (user 2026-10-10). Every remote-read
//    verified flag is self-submitted for instant authoritative feedback
//    (correct/duplicate/wrong) through a LOCAL host-side submit proxy
//    (R33: BENCHMARK_TOKEN never enters task text — the agent posts
//    {"code","flag"} to loopback and the proxy holds the credential), with
//    same-run variant retries on wrong. Driver-side submission of
//    finish_task's value and VERIFIED_FLAG findings remains the fallback gate
//    when the proxy is down.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);

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
  const list = Array.isArray(items) ? items : (items?.items ?? items?.challenges ?? []);
  // R34: cache name/description/category metadata per code — categoryOf needs
  // it and prefix matching alone never fires on bctf2026-* codes (the whole
  // 34998 run ran without a single category playbook).
  for (const item of list) {
    categoryHints.set(item.unique_code, {
      category: item.category ?? item.tag ?? item.category_name ?? item.type,
      name: String(item.challenge_name ?? item.name ?? item.title ?? ""),
      desc: String(item.description ?? ""),
    });
  }
  return list;
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

// R33: closeChallenge swallows errors and returns false — the old settleMiss
// retry loop could never fire (its catch never saw a throw), so a transient
// API hiccup silently leaked the instance slot behind the 3-container cap.
// closeWithRetry reads the boolean and, after the final attempt, flags the
// ledger so the slot watchdog keeps trying instead of the settle pretending
// the release succeeded.
async function closeWithRetry(code, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await closeChallenge(code)) return true;
    console.warn(`[tsec] close ${code} attempt ${attempt}/${attempts} failed`);
    await sleep(2_000 * attempt);
  }
  try {
    ledgerUpdate((ledger) => {
      ledger.done[code] = { ...(ledger.done[code] ?? { misses: 0 }), closeFailedAt: Date.now() };
    });
  } catch { /* best effort */ }
  console.warn(`[tsec] close ${code} kept failing — flagged for the slot watchdog`);
  return false;
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

async function xuanshu(path, options = {}, timeoutMs = 45_000, retries = 1, baseUrl = XUANSHU_BASE) {
  // R20: idempotent xuanshu calls (polls, stops, handoff reads) retry once on
  // transient failure — 29896's slot leak was a settle path whose single-shot
  // stop/poll aborted against a busy server and skipped the instance close.
  // Run CREATION keeps retries=0 (a replayed create would double-run).
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${options.baseUrl ?? baseUrl}${path}`, {
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

async function stopRun(runId, baseUrl = XUANSHU_BASE) {
  // R20: never single-shot. A budget stop that times out against a busy
  // server used to throw into the settle path and skip the instance close —
  // three of those leaked every slot and froze the whole fleet (29896).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await xuanshu(`/v1/runs/${runId}/stop`, { method: "POST", body: "{}" }, 120_000, 0, baseUrl);
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

async function watchRun(runId, deadlineMs, code, baseUrl = XUANSHU_BASE) {
  const deadline = Date.now() + deadlineMs;
  const banked = new Set(); // finding texts already mirrored to the board
  let bankedFrontier = ""; // last frontier note mirrored for this run
  // R20: poll the light /lite shape (status + findings + frontier). The full
  // snapshot serializes up to 1000 events plus the entire state every 20s —
  // under three heavy web grinds that load is what pushed settle-path stops
  // past their budget in 29896. Old servers without /lite fall back once.
  let liteMissing = false;
  // R32 slot-turnover: every third cycle also poll the PLATFORM's completion
  // state for this challenge. A run that self-submits its last flag keeps
  // grinding to budget while the 3-instance cap starves every other lane
  // (live-run 34998: bctf2026-10 completed 22:08:47, slot freed ~22:20 —
  // 12 lane-minutes burned after the flag was already banked).
  let completionChecks = 0;
  while (Date.now() < deadline) {
    await sleep(20_000);
    let poll;
    if (!liteMissing) {
      try {
        poll = await xuanshu(`/v1/runs/${runId}/lite`, {}, 45_000, 1, baseUrl);
      } catch (error) {
        console.warn(`[tsec] poll ${runId} failed (${error?.message ?? error}); continuing`);
        continue;
      }
      if (poll.status === 404) { liteMissing = true; }
    }
    if (liteMissing) {
      try {
        const full = await xuanshu(`/v1/runs/${runId}`, {}, 45_000, 1, baseUrl);
        poll = { status: full.status, json: { status: full.json?.status ?? full.json?.state?.status, ...(full.json?.state ?? {}) } };
      } catch (error) {
        console.warn(`[tsec] poll ${runId} failed (${error?.message ?? error}); continuing`);
        continue;
      }
    }
    const status = poll.json?.status ?? poll.json?.state?.status;
    if (poll.status !== 200 || !status) continue;
    console.log(`[xuanshu] ${runId.slice(0, 8)} status=${status}`);
    if (code && ++completionChecks % 3 === 0) {
      try {
        const fresh = (await listChallenges()).find((item) => item.unique_code === code);
        if (fresh?.is_completed) {
          console.log(`[tsec] ${code} already complete on the platform — stopping ${runId.slice(0, 8)} early and freeing the slot`);
          try { await stopRun(runId, baseUrl); } catch { /* already finished */ }
          return { __platformCompleted: true, progress: fresh.correct_flag_count };
        }
      } catch { /* platform hiccup: keep watching the run */ }
    }
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
        const full = await xuanshu(`/v1/runs/${runId}`, {}, 45_000, 1, baseUrl);
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

// ── R33 shared-state layer: atomic writes + cross-process locks ────────────
// 8 lanes + fanout workers share ledger/board/handoff files as independent
// processes; the old read-modify-writeFileSync pattern lost updates (two
// settles racing on different codes clobbered each other's ledger row) and a
// torn mid-write read fell back to the empty default — then the next write
// PERSISTED the wipe. Two primitives fix both:
//   atomicWriteJson — tmp file + rename(2): a reader always sees the whole
//     old or the whole new document, never a half-written one.
//   withLock(name) — O_EXCL lockfile around the read-modify-write so
//     concurrent mutators serialize instead of racing. Hold times are one
//     small sync write (<1ms); a lock older than LOCK_STALE_MS is stolen
//     (owner died mid-update), and after 3s of spinning the mutator runs
//     degraded-but-atomic rather than stall a lane.
const LOCK_STALE_MS = 10_000;
function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // Linux rename(2) over an existing file is atomic; an exotic mount can
  // still refuse it (EPERM/EBUSY with concurrent readers on some fs). Short
  // retry ladder, then a direct-write fallback: state IO must never crash a
  // lane — the lock serializes writers either way, and readJsonRetry absorbs
  // the torn read a direct write can leave behind.
  try {
    for (let i = 0; i < 8; i++) {
      try { renameSync(tmp, file); return; }
      catch (e) {
        if (!["EPERM", "EBUSY", "EACCES", "EAGAIN"].includes(e?.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    console.warn(`[tsec] atomic rename kept failing for ${file} — direct write fallback`);
    writeFileSync(file, JSON.stringify(obj, null, 2));
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* renamed or gone */ }
  }
}
function withLock(name, fn) {
  const lock = resolve(WORK_DIR, `.lock-${name}`);
  // R34 hardening (external review): every acquire carries a unique owner
  // token; the stale-steal re-verifies the inode before deleting (a lock
  // released-and-reclaimed between our stat and rm has a NEW inode and must
  // survive); release deletes only on token match — never on parse failure;
  // and lock exhaustion FORCE-STEALS instead of running the mutation
  // unlocked (an unlocked read-modify-write reintroduces the lost-update
  // class the lock exists to prevent).
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const write = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, token, lane: process.env.TSEC_LANE ?? "main", at: Date.now() }), { flag: "wx" });
  let held = false;
  // R35: 8-way sustained contention can legitimately queue a waiter for tens
  // of seconds (the R35 test: 8 lanes x 200 locked updates produced steals at
  // 4.5s). Waiting is always safe here — fn bodies are sub-ms — so the budget
  // is 45s before any steal, with jitter to break the thundering herd.
  for (let spin = 0; spin < 900 && !held; spin++) {
    try { write(); held = true; }
    catch {
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            if (statSync(lock).ino === st.ino) { // still the SAME stale file
              rmSync(lock, { force: true });
              console.warn(`[tsec] lock ${name}: stole abandoned lock (age ${Math.round((Date.now() - st.mtimeMs) / 1000)}s)`);
              continue;
            }
          } catch { /* vanished: retry wx */ }
        }
      } catch { /* vanished between write-fail and stat: retry wx */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + (spin % 7) * 5);
    }
  }
  if (!held) {
    // ~4.5s of live contention with a fresh lock: the owner is wedged
    // mid-transaction (fn bodies are sync and sub-ms). Steal it — running
    // unlocked is not an option; failing the lane is worse than the
    // vanishingly rare double-entry after a steal.
    console.warn(`[tsec] lock ${name}: contended beyond spin budget — force-stealing`);
    try { rmSync(lock, { force: true }); } catch { /* gone */ }
    try { write(); held = true; } catch { /* lost the steal race too */ }
  }
  if (!held) throw new Error(`withLock(${name}): acquisition failed`);
  try { return fn(); } finally {
    try {
      if (JSON.parse(readFileSync(lock, "utf8")).token === token) rmSync(lock, { force: true });
      // parse failure or a foreign token: LEAVE the file — the stale-steal
      // path owns cleanup; deleting an unverifiable lock could kill a live
      // owner's exclusion.
    } catch { /* leave for staleness */ }
  }
}
// ── R35 SQLite state layer ──────────────────────────────────────────────────
// External review round 2: the lockfile+JSON layer (R33/R34) cannot make a
// mutation atomic against a crash mid-sequence, and its correctness rests on
// steal heuristics (stale age, inode recheck, force-steal). SQLite gives the
// real thing: every mutation runs inside BEGIN IMMEDIATE, cross-process
// contention resolves through busy_timeout inside the database, and a crash
// mid-transaction rolls back to the last committed state. The runtime is
// node:22 (node:sqlite unflagged since 22.13); if the import ever fails the
// R34 file+lock layer below stays as a fully functional fallback — same
// function names, same semantics, backend chosen once per process at first
// use. Schema is deliberately generic (kv(k, v) with JSON values, keys
// namespaced "ledger" / "board:<code>" / "claim:<code>" / ...) — the
// transaction IS the fix; a relational shape would add schema-drift risk for
// zero behavioral gain at this volume. Legacy JSON files import once, inside
// the same transaction that marks the migration done, then rename to
// .migrated-<ts> (originals kept for forensics).
const STATE_DB = resolve(WORK_DIR, "state.db");
let stateDb = null;
let stateBooted = false;
function stateInit() {
  if (stateBooted) return;
  stateBooted = true;
  try {
    const { DatabaseSync } = nodeRequire("node:sqlite");
    stateDb = new DatabaseSync(STATE_DB);
    try { stateDb.exec("PRAGMA journal_mode=WAL;"); } catch { /* fs without WAL support: default journal is still correct */ }
    stateDb.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    stateDb.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    stateTx(migrateLegacyState);
  } catch (error) {
    stateDb = null;
    console.warn(`[tsec] node:sqlite unavailable (${error?.message ?? error}) — using the R34 file+lock state layer`);
  }
}
function kvGet(key) {
  const row = stateDb.prepare("SELECT v FROM kv WHERE k = ?").get(key);
  return row === undefined ? undefined : row.v;
}
function kvPut(key, value) {
  stateDb.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(key, JSON.stringify(value));
}
function kvDel(key) {
  stateDb.prepare("DELETE FROM kv WHERE k = ?").run(key);
}
// BEGIN IMMEDIATE takes the write lock up front, so concurrent mutators
// serialize INSIDE the database (busy_timeout waits) instead of racing. The
// handle is synchronous: fn must not await.
function stateTx(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      stateDb.exec("BEGIN IMMEDIATE");
      break;
    } catch (error) {
      if (attempt < 40 && /busy|locked/i.test(String(error?.message ?? error))) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); continue; }
      throw error;
    }
  }
  try {
    const out = fn();
    stateDb.exec("COMMIT");
    return out;
  } catch (error) {
    try { stateDb.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}
const LEGACY_FILE_RE = /^(ledger|lessons|task-start|board-|claim-|watch-|handoff-|wrong-|hint-|lastrun-)([\w.-]*?)\.json$/;
function keyOfLegacyFile(name) {
  const m = LEGACY_FILE_RE.exec(name);
  if (!m) return null;
  const ns = m[1].replace(/-$/, "");
  return m[2] ? `${ns}:${m[2]}` : ns;
}
function fileOfKey(key) {
  const sep = key.indexOf(":");
  return sep < 0 ? resolve(WORK_DIR, `${key}.json`) : resolve(WORK_DIR, `${key.slice(0, sep)}-${key.slice(sep + 1)}.json`);
}
function migrateLegacyState() {
  if (kvGet("meta:migrated") !== undefined) return;
  const stamp = Date.now();
  let names = [];
  try { names = readdirSync(WORK_DIR).map((f) => keyOfLegacyFile(f) ? f : null).filter(Boolean); } catch { /* unreadable: nothing to import */ }
  for (const name of names) {
    const file = resolve(WORK_DIR, name);
    const key = keyOfLegacyFile(name);
    try {
      kvPut(key, JSON.parse(readFileSync(file, "utf8")));
    } catch {
      try { renameSync(file, `${file}.corrupt-${stamp}`); console.error(`[tsec] legacy state ${name} unparseable — quarantined`); } catch { /* unwritable */ }
      continue;
    }
    try { renameSync(file, `${file}.migrated-${stamp}`); } catch { /* row is written and re-import is idempotent */ }
  }
  kvPut("meta:migrated", { at: new Date().toISOString(), files: names.length });
  if (names.length > 0) console.log(`[tsec] migrated ${names.length} legacy state file(s) into state.db (originals kept as .migrated-*)`);
}
function stateRead(key, fallback) {
  stateInit();
  const seed = () => (typeof fallback === "function" ? fallback() : structuredClone(fallback));
  if (stateDb) {
    try {
      const raw = kvGet(key);
      if (raw === undefined) return seed();
      try {
        return JSON.parse(raw);
      } catch (parseError) {
        // a row holding non-JSON is damage (bug or tampering), not absence —
        // quarantine the payload and reseed, never silently treat as empty.
        console.error(`[tsec] state row ${key} unparseable — quarantined, reseeding`);
        try { kvPut(`quarantine:${key}:${Date.now()}`, raw); kvDel(key); } catch { /* best effort */ }
        return seed();
      }
    } catch (error) {
      console.warn(`[tsec] state read ${key} failed: ${error?.message ?? error}`);
      return seed();
    }
  }
  // file backend: R34 semantics — retry torn reads, quarantine damage.
  const file = fileOfKey(key);
  for (let i = 0; i < 4; i++) {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { /* torn or absent */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  }
  if (existsSync(file)) quarantineState(file);
  return seed();
}
function stateWrite(key, value) {
  stateInit();
  if (stateDb) { stateTx(() => kvPut(key, value)); return; }
  withLock(key.replace(":", "-"), () => atomicWriteJson(fileOfKey(key), value));
}
function stateDelete(key) {
  stateInit();
  if (stateDb) { stateTx(() => kvDel(key)); return; }
  withLock(key.replace(":", "-"), () => { try { rmSync(fileOfKey(key), { force: true }); } catch { /* best effort */ } });
}
function stateHas(key) {
  stateInit();
  if (stateDb) { try { return kvGet(key) !== undefined; } catch { return false; } }
  return existsSync(fileOfKey(key));
}
function stateKeys(prefix) {
  stateInit();
  if (stateDb) {
    try { return stateDb.prepare("SELECT k FROM kv WHERE k LIKE ?").all(`${prefix}%`).map((r) => r.k); } catch { return []; }
  }
  try {
    const filePrefix = prefix.replace(":", "-");
    return readdirSync(WORK_DIR)
      .filter((f) => f.startsWith(filePrefix) && f.endsWith(".json"))
      .map((f) => `${prefix}${f.slice(filePrefix.length, -".json".length)}`);
  } catch { return []; }
}
// THE read-modify-write: everything a comparison needs happens inside one
// transaction, so no two processes can interleave a read between another's
// read and write. mutate may return a value; stateUpdate returns it (or the
// mutated object). Runs on the synchronous handle — mutate must not await,
// but it MAY stateRead (plain SELECTs join the open transaction safely).
function stateUpdate(key, fallback, mutate) {
  stateInit();
  if (stateDb) {
    return stateTx(() => {
      const raw = kvGet(key);
      let value;
      if (raw === undefined) value = typeof fallback === "function" ? fallback() : structuredClone(fallback);
      else {
        try { value = JSON.parse(raw); }
        catch (parseError) {
          console.error(`[tsec] state row ${key} unparseable in update — quarantined, reseeding`);
          try { kvPut(`quarantine:${key}:${Date.now()}`, raw); kvDel(key); } catch { /* best effort */ }
          value = typeof fallback === "function" ? fallback() : structuredClone(fallback);
        }
      }
      const out = mutate(value);
      kvPut(key, value);
      return out === undefined ? value : out;
    });
  }
  return withLock(key.replace(":", "-"), () => {
    const value = stateRead(key, fallback);
    const out = mutate(value);
    atomicWriteJson(fileOfKey(key), value);
    return out === undefined ? value : out;
  });
}
// Shared token with staleness + pid-liveness: the only cross-process mutex
// primitive that can span an await (acquire tx -> async work -> release tx).
function stateAcquire(key, staleMs) {
  stateInit();
  if (stateDb) {
    return stateTx(() => {
      const raw = kvGet(key);
      let cur = null;
      if (raw !== undefined) { try { cur = JSON.parse(raw); } catch { cur = null; } }
      if (cur && Date.now() - Date.parse(cur.at) < staleMs) {
        try { process.kill(cur.pid, 0); } catch (probe) { if (probe.code !== "ESRCH") return false; cur = null; }
        if (cur) return false;
      }
      kvPut(key, { pid: process.pid, lane: process.env.TSEC_LANE ?? "main", at: new Date().toISOString() });
      return true;
    });
  }
  const file = fileOfKey(key);
  const stamp = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try { writeFileSync(file, stamp, { flag: "wx" }); return true; } catch { /* held, or stale below */ }
  try {
    if (Date.now() - statSync(file).mtimeMs > staleMs) {
      rmSync(file, { force: true });
      try { writeFileSync(file, stamp, { flag: "wx" }); return true; } catch { return false; }
    }
  } catch { /* vanished: the next call retries */ }
  return false;
}
function stateReleaseIfMine(key) {
  stateInit();
  if (stateDb) {
    try {
      stateTx(() => {
        const raw = kvGet(key);
        if (raw === undefined) return;
        try { if (JSON.parse(raw).pid !== process.pid) return; } catch { return; }
        kvDel(key);
      });
    } catch { /* best effort */ }
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(fileOfKey(key), "utf8"));
    if (parsed.pid === process.pid) rmSync(fileOfKey(key), { force: true });
  } catch { /* absent or unreadable */ }
}
function ledgerPath() { return fileOfKey("ledger"); }
// R34: a persistently unparseable state file is DAMAGE, not absence. The
// old fallback returned the empty default and the next write PERSISTED the
// wipe. Quarantine moves the wreck aside for forensics and starts clean.
function quarantineState(file) {
  const q = `${file}.corrupt-${Date.now()}`;
  try { renameSync(file, q); console.error(`[tsec] state file persistently unparseable — quarantined to ${q}`); } catch { /* unwritable */ }
}
function readLedger() { return stateRead("ledger", { done: {}, accepted: {} }); }
function writeLedger(ledger) { stateWrite("ledger", ledger); }
// Every ledger mutation is one transaction (R35: SQLite BEGIN IMMEDIATE, or
// the locked read→mutate→write on the file backend) — a mutation that reads
// outside it still races another lane's write.
function ledgerUpdate(mutate) {
  return stateUpdate("ledger", { done: {}, accepted: {} }, mutate);
}
function ledgerEntry(code) { return readLedger().done[code] ?? { misses: 0 }; }
function ledgerMark(code, status, { progress } = {}) {
  ledgerUpdate((ledger) => {
    const prior = ledger.done[code] ?? { misses: 0 };
    ledger.done[code] = { ...prior, status, ...(progress !== undefined ? { progress } : {}), misses: prior.misses + (status === "miss" ? 1 : 0), at: new Date().toISOString() };
  });
}
// Progress (platform-confirmed correct_flag_count) resets the miss counter: a
// multi-flag challenge that just banked flag 2 of 3 deserves fresh attempts at
// flag 3, not the leftover misses from flag 2's grind.
function ledgerNoteProgress(code, progress) {
  ledgerUpdate((ledger) => {
    const prior = ledger.done[code] ?? { misses: 0 };
    if (prior.progress === progress) return;
    ledger.done[code] = { ...prior, progress, misses: 0, at: new Date().toISOString() };
  });
}
function recordAccepted(code, value) {
  ledgerUpdate((ledger) => {
    ledger.accepted[code] = [...new Set([...(ledger.accepted[code] ?? []), value])].slice(-6);
  });
}

// Handoff carry across retries of the same challenge (arena/ctf2-proven).
function handoffPath(code) { return fileOfKey(`handoff:${code}`); }
function handoffFor(code) { return stateRead(`handoff:${code}`, null); }
function wrongPath(code) { return fileOfKey(`wrong:${code}`); }
// Pulled platform hint (charged once, cached forever — a second view may
// re-charge and buys nothing new). Empty string = challenge has no hint.
function hintPath(code) { return fileOfKey(`hint:${code}`); }
function hintFor(code) { return stateRead(`hint:${code}`, null); }
function rejectedValues(code) {
  const raw = stateRead(`wrong:${code}`, { values: [] });
  return Array.isArray(raw?.values) ? raw.values.filter((v) => typeof v === "string") : [];
}
// Last run id per challenge — survives the handoff deletion a banked flag
// triggers, so retries always have a lineage parent for scratch inheritance.
function lastrunPath(code) { return fileOfKey(`lastrun:${code}`); }
// R35 lineage (external review): lanes and fanout workers BOTH record runs —
// a single overwritten slot lost every writer but the last. The row now holds
// the last 4 runs; same-server resolution walks it newest-first.
function writeLastrun(code, runId, baseUrl = XUANSHU_BASE) {
  try {
    stateUpdate(`lastrun:${code}`, [], (runs) => {
      if (!Array.isArray(runs)) return;
      runs.push({ code, runId, baseUrl, lane: process.env.TSEC_LANE ?? "main", at: new Date().toISOString() });
      while (runs.length > 4) runs.shift();
    });
  } catch { /* best effort */ }
}
function lastrunRuns(code) {
  const runs = stateRead(`lastrun:${code}`, []);
  return Array.isArray(runs) ? runs : [];
}
function lastrunFor(code) { return lastrunRuns(code).at(-1)?.runId; }
// R28: scratch inheritance is server-local — a parent recorded on the fanout
// server must not feed a lane-server create (the run create would 404 the
// lineage and burn the slot). lastrunIdFor only returns same-server parents.
function lastrunMetaFor(code) { return lastrunRuns(code).at(-1); }
function lastrunIdFor(code, baseUrl) {
  const runs = lastrunRuns(code);
  for (let i = runs.length - 1; i >= 0; i--) {
    if ((runs[i].baseUrl ?? XUANSHU_BASE) === baseUrl) return runs[i].runId;
  }
  return undefined;
}
function recordRejected(code, value) {
  stateUpdate(`wrong:${code}`, { values: [] }, (wrong) => {
    if (typeof wrong !== "object" || wrong === null) return;
    wrong.values = [...(wrong.values ?? []), value].slice(-8);
    wrong.last = value;
    wrong.rejectedAt = new Date().toISOString();
  });
}
function writeHandoff(code, payload) {
  stateUpdate(`handoff:${code}`, {}, (merged) => {
    const prior = handoffFor(code);
    const dedupe = (items) => [...new Set(items)];
    Object.assign(merged, payload, {
      findings: dedupe([...(prior?.findings ?? []), ...(payload.findings ?? [])]).slice(0, 8),
      nextSteps: dedupe([...(prior?.nextSteps ?? []), ...(payload.nextSteps ?? [])]).slice(0, 6),
      summary: payload.summary?.trim() ? payload.summary : (prior?.summary ?? ""),
      handoffText: payload.handoffText ?? prior?.handoffText,
    });
  });
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
function boardPath(code) { return fileOfKey(`board:${code}`); }
// Round-1 handoffs seed board facts (warm-start knowledge survives the format
// change). Computed, never persisted on the read path — persisting inside a
// read would nest a transaction; the next real boardUpdate persists anyway.
function boardSeedFor(code) {
  const prior = handoffFor(code);
  if (!prior) return { facts: [], intents: [], hints: [] };
  return {
    facts: (prior.findings ?? []).map((text) => ({ at: prior.at, from: prior.from, text })),
    intents: (prior.nextSteps ?? []).map((text) => ({ at: prior.at, text, needs: [] })),
    hints: [],
    summary: prior.summary ?? "",
  };
}
function boardFor(code) {
  const board = stateRead(`board:${code}`, null);
  return board ?? boardSeedFor(code);
}
function boardWrite(code, board) { stateWrite(`board:${code}`, board); }
function boardExists(code) { return stateHas(`board:${code}`); }
// R14 frontier slot: ONE record per challenge holding the last assistant
// reasoning of the newest killed run (single slot, overwritten — unlike
// intents it never pushes real next-steps out of the bounded board).
function boardFrontier(code, text) {
  stateUpdate(`board:${code}`, boardSeedFor, (board) => {
    if (typeof board !== "object" || board === null) return;
    board.frontier = { at: new Date().toISOString(), text: String(text).slice(0, 600) };
  });
}
// R29 Cairn Step admission: a next-step may carry a `needs(<substr>;<substr>)`
// prefix declaring the prerequisite facts. Ingestion strips the prefix into
// the intent's needs array; an intent whose needs are not yet board facts is
// blocked (rendered, never dispatched as next_exact_test) — a step whose
// causal inputs do not exist yet cannot run, matching the FGS Step rule.
// Unblocks automatically the moment a matching fact lands.
function parseNeeds(text) {
  const raw = String(text ?? "").trim();
  const m = /^needs\(([^)]*)\)\s*/.exec(raw);
  if (!m) return { needs: [], text: raw };
  const needs = m[1].split(/[;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  return { needs, text: raw.slice(m[0].length).trim() || raw };
}
function needsMet(intent, board) {
  const needs = Array.isArray(intent?.needs) ? intent.needs : [];
  if (needs.length === 0) return true;
  const hay = board.facts.map((f) => String(f.text ?? "").toLowerCase()).join("\n");
  return needs.every((n) => hay.includes(String(n).toLowerCase()));
}
function boardUpdate(code, { facts = [], intents = [], hints = [], solvedIntentSubstr } = {}) {
  return stateUpdate(`board:${code}`, boardSeedFor, (board) => {
    if (typeof board !== "object" || board === null) return;
    const factTexts = new Set(board.facts.map((f) => f.text));
    // R35 evidence grading (external review): every fact carries its class —
    // observation (agent-reported, may be wrong) vs verified (platform-
    // confirmed flag, or a hypothesis the run CONTRADICTED with evidence).
    // The render marks the class so the next run knows what it may build on
    // blind and what it must re-verify before leaning on it.
    for (const fact of facts) {
      const entry = typeof fact === "string" ? { text: fact } : (fact ?? {});
      const text = String(entry.text ?? "").trim();
      if (!text || factTexts.has(text)) continue;
      board.facts.push({ at: new Date().toISOString(), grade: entry.grade ?? "observation", ...(entry.source ? { source: entry.source } : {}), text });
      factTexts.add(text);
    }
    const intentTexts = new Set(board.intents.map((i) => i.text));
    for (const intent of intents) {
      const norm = parseNeeds(intent.text);
      const carried = Array.isArray(intent.needs) ? intent.needs : [];
      const merged = { ...intent, text: norm.text, needs: norm.needs.length > 0 ? norm.needs : carried };
      if (!intentTexts.has(merged.text)) { board.intents.push({ at: new Date().toISOString(), ...merged }); intentTexts.add(merged.text); }
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
    return board;
  });
}
function boardClear(code) {
  // R35: DELETE through the state layer — same atomicity class as
  // boardUpdate, so a clear racing a sibling banking facts cannot resurrect
  // the board (the R34 bug) and cannot tear (delete-then-crash).
  stateDelete(`board:${code}`);
}

// ── arena-wide lesson ledger (R10, user directive: 不要重做错误的事) ──────────
// Every settled run banks its GENERIC lessons (record_lesson output) into a
// shared ledger and its CONTRADICTED hypotheses onto the challenge board, so
// later task builds — other challenges included — start with the negative
// knowledge instead of repeating it. The per-challenge board already carries
// rejected flags and verified facts; this adds cross-challenge methodology.
function lessonsPath() { return fileOfKey("lessons"); }
function readArenaLessons() { return stateRead("lessons", []); }
function recordArenaLessons(code, state) {
  try {
    stateUpdate("lessons", [], (lessons) => {
      if (!Array.isArray(lessons)) return;
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
        // R35 provenance (external review): a lesson is a model SELF-report
        // until a later outcome confirms it — grade it so the render can mark
        // what is safe to lean on blind. `code` is the originating run.
        lessons.push({ at: new Date().toISOString(), code, grade: "observation", text: text.slice(0, 320) });
      }
      const kept = lessons.slice(-40);
      lessons.length = 0;
      lessons.push(...kept);
    });
  } catch { /* best effort */ }
}

async function bankKnowledge(code, runId, baseUrl = XUANSHU_BASE) {
  try {
    const state = (await xuanshu(`/v1/runs/${runId}`, {}, 45_000, 1, baseUrl)).json?.state ?? {};
    const deadEnds = (state.hypotheses ?? [])
      .filter((h) => h?.status === "contradicted" && typeof h.statement === "string")
      .map((h) => `已排除假设:${h.statement.slice(0, 200)}${Array.isArray(h.evidence) && h.evidence[0] ? `(证据:${String(h.evidence[0]).slice(0, 100)})` : ""}`);
    if (deadEnds.length > 0) boardUpdate(code, { facts: deadEnds.slice(0, 6).map((text) => ({ text, grade: "verified", source: "contradicted-hypothesis" })) });
    recordArenaLessons(code, state);
  } catch { /* state cold; the live mirror already covered findings */ }
}

// Cross-lane in-flight locks (user directive 2026-10-09: 并发开跑). Parallel
// loops elect the same byPriority winner within seconds of each other; a
// claim file (age-bounded) is the only coordination the local ledger gives
// us. Staleness exceeds the 46-min warm budget + container wait so a crashed
// lane's claim cannot strand a challenge for long.
const CLAIM_STALE_MS = 55 * 60_000;
// R6/R27: cumulative lane-minutes a hard single may burn before it is done
// for good — gated in pickNext AND reviveParked (double gate).
const HARD_SPENT_CAP = 90;
function claimPath(code) { return fileOfKey(`claim:${code}`); }
function claimFor(code) {
  // single-shot read semantics, deliberately NOT stateRead: the
  // 4x-retry-then-quarantine ladder can rename a mid-write claim away on
  // exotic filesystems and hand the code to a second lane (seen in the R35
  // file-backend stress test). An unparseable/absent claim is simply
  // "unclaimed" here — claimCode's exclusive create decides the race, never
  // a quarantine.
  let claim = null;
  stateInit();
  if (stateDb) {
    try { claim = JSON.parse(kvGet(`claim:${code}`)); } catch { /* absent or unparseable: unclaimed */ }
  } else {
    try { claim = JSON.parse(readFileSync(fileOfKey(`claim:${code}`), "utf8")); } catch { /* absent or mid-write: unclaimed */ }
  }
  if (claim && Date.now() - Date.parse(claim.at) < CLAIM_STALE_MS) {
    // A SIGTERM'd lane never runs its finally — its claim is a corpse that
    // would otherwise lock a challenge for the full 55 minutes (the
    // 2026-10-10 rollovers left two). Probe the owning pid: ESRCH = dead =
    // treat as unclaimed; EPERM = alive under another user = valid hold.
    try { process.kill(claim.pid, 0); } catch (probe) { if (probe.code === "ESRCH") return null; }
    return claim;
  }
  return null;
}
function claimCode(code, lane) {
  stateInit();
  if (stateDb) {
    // R35: BEGIN IMMEDIATE decides the claim race inside the database — the
    // wx-file dance below was the same idea with weaker primitives.
    return stateTx(() => {
      const raw = kvGet(`claim:${code}`);
      let cur = null;
      if (raw !== undefined) { try { cur = JSON.parse(raw); } catch { cur = null; } }
      if (cur && Date.now() - Date.parse(cur.at) < CLAIM_STALE_MS) {
        try { process.kill(cur.pid, 0); } catch (probe) { if (probe.code !== "ESRCH") return false; cur = null; }
        if (cur) return false;
      }
      kvPut(`claim:${code}`, { lane, at: new Date().toISOString(), pid: process.pid });
      return true;
    });
  }
  if (claimFor(code)) return false;
  // Atomic claim: exclusive-create (wx) decides the race — the round-2 start
  // saw all three lanes pass check-then-write inside one ~100ms window and
  // triple-team a fragile single-instance container. A stale corpse (55min+)
  // must be removed first or wx would fail on it forever; only touch the file
  // when one is actually present so a fresh claim is never stolen.
  if (existsSync(claimPath(code))) {
    try {
      // Re-check staleness by mtime: a claim that aged past CLAIM_STALE_MS at
      // claimFor() may have been re-claimed fresh since — deleting THAT would
      // strand the new owner's exclusivity (R33).
      if (Date.now() - statSync(claimPath(code)).mtimeMs < CLAIM_STALE_MS) return false;
      rmSync(claimPath(code), { force: true });
    } catch { /* racing removal */ }
  }
  try {
    writeFileSync(claimPath(code), JSON.stringify({ lane, at: new Date().toISOString(), pid: process.pid }, null, 2), { flag: "wx" });
    return true;
  } catch {
    return false; // lost the race — another lane claimed between our check and write
  }
}
function releaseClaim(code) {
  // Owner check (R33): a lane whose stale claim was reclaimed by another lane
  // must not delete the new owner's claim from its finally block — that would
  // re-open the code for double-teaming while the new owner still runs.
  stateInit();
  if (stateDb) { stateReleaseIfMine(`claim:${code}`); return; }
  try {
    const claim = JSON.parse(readFileSync(claimPath(code), "utf8"));
    if (claim.pid !== process.pid) return;
  } catch { /* absent: fall through to the rmSync */ }
  try { rmSync(claimPath(code), { force: true }); } catch { /* best effort */ }
}
// Sweep every claim this process still holds (a task-ended exit between the
// claim and the finally would otherwise strand the challenge for 55 minutes).
function releaseOwnClaims() {
  try {
    for (const key of stateKeys("claim:")) {
      const claim = stateRead(key, null);
      if (claim?.pid === process.pid) stateDelete(key);
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
function watchPath(code) { return fileOfKey(`watch:${code}`); }
function watchFor(code) {
  const w = stateRead(`watch:${code}`, null);
  return w ?? undefined;
}
function registerWatch(code, runId, horizonMs) {
  try {
    stateWrite(`watch:${code}`, { lane: process.env.TSEC_LANE ?? "main", pid: process.pid, runId, deadline: Date.now() + horizonMs, at: new Date().toISOString() });
  } catch { /* registry is best-effort; the watchdog errs toward reclaiming */ }
}
function clearWatch(code) {
  try { stateDelete(`watch:${code}`); } catch { /* already gone */ }
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
    // R34: a failed close keeps the watch so the next cycle retries it —
    // clearing the marker on failure made the leak look reclaimed. The 5min
    // closeFailedAt window (set by closeWithRetry) throttles retry storms.
    if (readLedger().done[code]?.closeFailedAt && Date.now() - readLedger().done[code].closeFailedAt < 5 * 60_000) continue;
    if (await closeWithRetry(code)) clearWatch(code);
    else console.warn(`[tsec] watchdog: ${code} close still failing — watch kept for the next cycle`);
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
// R35 endgame exploration quota (external review): counts endgame picks on
// this lane so every third one still opens a never-attempted challenge.
let endgamePicks = 0;
let taskStartedAt = 0;
function taskStartAt(now) {
  if (taskStartedAt) return taskStartedAt;
  // R33: lanes restart under the supervisor, and a process-local clock put a
  // restarted lane back into "breadth" while the task was deep in endgame.
  // The start timestamp is shared state: first writer wins (wx), every later
  // boot — lane restarts included — re-reads it.
  const stamp = stateRead("task-start", null);
  if (stamp) taskStartedAt = Date.parse(stamp.at);
  else {
    // first writer wins, transactionally (R35): a single get-or-put inside
    // BEGIN IMMEDIATE replaces the wx-file race — no losing writer exists.
    stateInit();
    if (stateDb) {
      stateTx(() => {
        const raw = kvGet("task-start");
        taskStartedAt = raw !== undefined ? Date.parse(JSON.parse(raw).at) : now;
        if (raw === undefined) kvPut("task-start", { at: now });
      });
    } else {
      try { writeFileSync(resolve(WORK_DIR, "task-start.json"), JSON.stringify({ at: now }, null, 2), { flag: "wx" }); taskStartedAt = now; }
      catch { try { taskStartedAt = Date.parse(JSON.parse(readFileSync(resolve(WORK_DIR, "task-start.json"), "utf8")).at); } catch { taskStartedAt = now; } }
    }
  }
  if (!Number.isFinite(taskStartedAt)) taskStartedAt = now;
  return taskStartedAt;
}
function phaseOf(items, now) {
  const startedAt = taskStartAt(now);
  const elapsedMin = (now - startedAt) / 60_000;
  const unsolved = items.filter((item) => !item.is_completed).length;
  if (elapsedMin < 45) return "breadth";
  // R28 8h one-shot finals: also engage tail mode with 2h left on a
  // manageable tail (the 4h/14 gate was tuned for 6h rounds).
  if (unsolved <= 8 || (elapsedMin >= 240 && unsolved <= 14) || (elapsedMin >= 360 && unsolved <= 24)) return "endgame";
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
  if (boardExists(code)) {
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
// R34: time-normalized — expected score over expected remaining effort.
// Effort = difficulty cost + cold-instance startup penalty (provisioning is
// 1-3 real minutes inside the budget under the 3-slot cap).
const DIFFICULTY_COST = { easy: 1, medium: 2, hard: 4 };
function expectedScoreRate(item) {
  const remaining = remainingOf(item);
  if (remaining <= 0) return 0;
  const cost = (DIFFICULTY_COST[String(item.difficulty ?? "").toLowerCase()] ?? 3)
    + (item.container_status === "available" ? 0 : 1.5);
  return (item.total_score ?? 0) * (remaining / Math.max(item.flag_count ?? 1, 1)) * BUCKET_WEIGHT[evidenceBucket(item)] / cost;
}
// Instance lifecycle (AePis container_bound facts): remember which container
// instance the board's facts came from; a restart downgrades session/cookie/
// temporary-address facts to "must re-verify" while stack/route conclusions
// survive. Returns the PRIOR address so callers can log the swap.
function boardContainer(code, addrs) {
  let priorAddr = "";
  stateUpdate(`board:${code}`, boardSeedFor, (board) => {
    if (typeof board !== "object" || board === null) return;
    const addr = (addrs ?? [])[0] ?? "";
    if (board.containerAddr === addr) { priorAddr = addr; return; }
    priorAddr = board.containerAddr ?? "";
    board.containerAddr = addr;
    board.containerAt = new Date().toISOString();
  });
  return priorAddr;
}

// ── host-side submit proxy (R33) ─────────────────────────────────────────────
// The pre-R33 task text embedded the platform submit URL + BENCHMARK_TOKEN so
// the agent could self-submit; permissive sandbox scope + challenge-response
// prompt injection made that credential exfiltratable in principle. The proxy
// keeps the instant authoritative feedback loop but holds the token host-side:
// agents POST {"code","flag"} to loopback, the proxy relays to the platform
// and returns the verdict verbatim (409 duplicate becomes 200
// {correct:true, duplicate:true}). The first lane to boot owns the listener;
// later lanes see EADDRINUSE and share it. If it dies with its lane, the next
// lane restart rebinds — until then the finish_task relay and completion
// pollers remain the fallback submission paths.
const SUBMIT_PROXY_PORT = Number(process.env.TSEC_SUBMIT_PORT ?? 7320);
const SUBMIT_PROXY_URL = `http://127.0.0.1:${SUBMIT_PROXY_PORT}/submit`;
let submitProxyStarted = false;
async function startSubmitProxy() {
  if (submitProxyStarted) return;
  submitProxyStarted = true;
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const reply = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url.startsWith("/health")) return reply(200, { ok: true });
    if (req.method !== "POST" || !req.url.startsWith("/submit")) return reply(404, { error: 'POST /submit {"code":"<unique_code>","flag":"<value>"}' });
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 16_384) req.destroy(); });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const code = String(parsed.code ?? parsed.unique_code ?? "").trim();
        const flag = String(parsed.flag ?? "").trim();
        if (!code || !flag) return reply(400, { error: "code and flag required" });
        const verdict = await api("/openapi/v1/challenges/submit", { method: "POST", body: { unique_code: code, flag } });
        try { await record({ challenge: code, outcome: "proxy-submit", flag, verdict }); } catch { /* audit only */ }
        reply(200, verdict);
      } catch (error) {
        if (isDuplicate(error)) return reply(200, { correct: true, duplicate: true, message: "flag already banked" });
        if (isTaskEnded(error)) return reply(503, { error: "task ended", taskEnded: true });
        reply(502, { error: String(error?.message ?? error) });
      }
    });
  });
  await new Promise((resolve) => {
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") console.log(`[tsec] submit proxy already owned by another lane (${SUBMIT_PROXY_URL})`);
      else console.warn(`[tsec] submit proxy unavailable (${error?.message ?? error}) — finish_task relay remains the fallback path`);
      resolve();
    });
    server.listen(SUBMIT_PROXY_PORT, "127.0.0.1", () => {
      console.log(`[tsec] submit proxy listening on ${SUBMIT_PROXY_URL} (lane ${process.env.TSEC_LANE ?? "main"}, pid ${process.pid})`);
      resolve();
    });
  });
}

// ── egress gateway v1 (R34) ─────────────────────────────────────────────────
// 34998 forensics: one session hit visible 429s then ran a python loop that
// fired ~900 requests in 162s; another kept probing a WAF that had already
// rate-limited it. Prompt-level "serial, ≤2 connections" never binds scripts
// spawned through run_command. The gateway is a real boundary for the script
// class: the entrypoint exports HTTP(S)_PROXY, src/sandbox.ts passes those
// vars into run_command children (python requests/urllib and curl honor
// them), and this in-driver proxy enforces per-target concurrency, pacing,
// 429 circuit-breaking and an audit trail. Documented gap: raw sockets and
// proxy-ignoring binaries still bypass — v2 moves to nftables REDIRECT for
// full coverage. If egress-audit.jsonl stays empty while challenges are
// probed, the passthrough broke: escalate to v2.
const EGRESS_PORT = Number(process.env.TSEC_EGRESS_PORT ?? 7321);
let egressStarted = false;
async function startEgressGateway() {
  if (egressStarted) return;
  egressStarted = true;
  if (String(process.env.TSEC_EGRESS ?? "on") !== "on") { console.log("[tsec] egress gateway disabled (TSEC_EGRESS=off)"); return; }
  const { createServer, connect } = await import("node:net");
  const { appendFile } = await import("node:fs/promises");
  const auditPath = resolve(WORK_DIR, "egress-audit.jsonl");
  const audit = (entry) => { appendFile(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`).catch(() => {}); };
  // VPN challenge instances are fragile singletons: strict caps. The public
  // internet (OSINT sources, downloads) only needs light shaping.
  const isPrivateHost = (host) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  const policyFor = (host) => isPrivateHost(host)
    ? { maxConc: 2, minGapMs: 250, cooldownMs: 30_000 }
    : { maxConc: 8, minGapMs: 0, cooldownMs: 5_000 };
  const targets = new Map();
  const stateOf = (key) => {
    let s = targets.get(key);
    if (!s) { s = { conc: 0, lastConn: 0, cooldownUntil: 0, fails: 0 }; targets.set(key, s); }
    return s;
  };
  const hostOf = (dst) => String(dst).split(":")[0];
  const acquire = (dst, socket) => new Promise((resolve) => {
    const s = stateOf(dst);
    const policy = policyFor(hostOf(dst));
    let done = false;
    const tryTake = () => {
      if (done) return;
      const now = Date.now();
      if (now < s.cooldownUntil || s.conc >= policy.maxConc || now - s.lastConn < policy.minGapMs) return;
      done = true; s.conc += 1; s.lastConn = now;
      clearInterval(timer); resolve(true);
    };
    const timer = setInterval(tryTake, 100);
    tryTake();
    const bail = () => { if (!done) { done = true; clearInterval(timer); resolve(false); } };
    socket.once("close", bail);
    setTimeout(bail, 30_000).unref?.();
  });
  const release = (dst) => { const s = stateOf(dst); s.conc = Math.max(0, s.conc - 1); };
  const failTally = (dst) => {
    const s = stateOf(dst);
    s.fails += 1;
    if (s.fails >= 3) { s.cooldownUntil = Date.now() + 60_000; s.fails = 0; audit({ dst, action: "circuit-open", cooldownMs: 60_000 }); }
  };
  const note429 = (dst) => {
    const cooldownMs = policyFor(hostOf(dst)).cooldownMs;
    const s = stateOf(dst);
    s.cooldownUntil = Date.now() + cooldownMs;
    s.fails = 0;
    audit({ dst, action: "429-circuit-open", cooldownMs });
  };
  const dial = (dst, port, socket, onConnected) => {
    const origin = connect({ host: hostOf(dst), port });
    origin.setTimeout(15_000, () => origin.destroy(new Error("origin connect timeout")));
    origin.once("error", (error) => {
      failTally(dst);
      audit({ dst, action: "origin-error", error: String(error.message) });
      release(dst);
      try { socket.end("HTTP/1.1 502 Egress origin error\r\ncontent-length: 0\r\n\r\n"); } catch { /* gone */ }
    });
    origin.once("connect", () => onConnected(origin));
    socket.once("error", () => { try { origin.destroy(); } catch { /* gone */ } });
    return origin;
  };
  const trackBytes = (dst, socket, origin) => {
    let bytes = 0;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; release(dst); audit({ dst, action: "closed", bytes }); };
    socket.on("data", (c) => { bytes += c.length; });
    origin.on("data", (c) => { bytes += c.length; });
    socket.once("close", finish);
    origin.once("close", finish);
  };
  // HTTPS: CONNECT host:port — blind tunnel after admission (no SNI peek in v1).
  const handleConnect = async (socket, dst) => {
    if (!dst) { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    if (!(await acquire(dst, socket))) { audit({ dst, action: "denied-timeout" }); socket.end("HTTP/1.1 503 Egress throttled\r\ncontent-length: 0\r\n\r\n"); return; }
    const port = Number(dst.split(":")[1]) || 443;
    dial(dst, port, socket, (origin) => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      trackBytes(dst, socket, origin);
      socket.pipe(origin);
      origin.pipe(socket);
    });
  };
  // Plain HTTP: absolute-form proxy request; rewrite to origin-form, forward,
  // and peek the origin's first line for a 429 to trip the circuit.
  const handlePlain = async (socket, firstLine, head) => {
    let url;
    try { url = new URL(firstLine.split(" ")[1] ?? ""); } catch { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const dst = `${url.hostname}:${url.port || 80}`;
    if (!(await acquire(dst, socket))) { audit({ dst, action: "denied-timeout" }); socket.end("HTTP/1.1 503 Egress throttled\r\ncontent-length: 0\r\n\r\n"); return; }
    const nl = head.indexOf("\r\n");
    const originForm = `${url.pathname}${url.search}`;
    const rewritten = Buffer.concat([Buffer.from(`${firstLine.split(" ")[0]} ${originForm} HTTP/1.1\r\n`, "latin1"), head.subarray(nl + 2)]);
    dial(dst, Number(dst.split(":")[1]) || 80, socket, (origin) => {
      origin.write(rewritten);
      trackBytes(dst, socket, origin);
      origin.once("data", (first) => {
        if (/^HTTP\/[\d.]+\s+429\b/.test(first.toString("latin1").slice(0, 32))) note429(dst);
        if (!socket.destroyed) socket.write(first);
        origin.pipe(socket);
      });
      socket.pipe(origin);
    });
  };
  const server = createServer((socket) => {
    socket.once("error", () => {});
    socket.setTimeout(120_000, () => socket.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      if (!head.includes("\r\n\r\n") && head.length < 16_384) return;
      socket.removeListener("data", onData);
      const firstLine = head.toString("latin1").split("\r\n")[0] ?? "";
      if (/^CONNECT\s+/i.test(firstLine)) { void handleConnect(socket, firstLine.split(/\s+/)[1]?.trim()); }
      else if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s+/i.test(firstLine)) { void handlePlain(socket, firstLine, head); }
      else socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    };
    socket.on("data", onData);
  });
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") console.log(`[tsec] egress gateway already owned by another lane (127.0.0.1:${EGRESS_PORT})`);
    else console.warn(`[tsec] egress gateway unavailable (${error?.message ?? error}) — script traffic runs ungated`);
  });
  server.listen(EGRESS_PORT, "127.0.0.1", () => {
    console.log(`[tsec] egress gateway listening on 127.0.0.1:${EGRESS_PORT} (private targets: 2 conc / 250ms gap / 429 cooldown; lane ${process.env.TSEC_LANE ?? "main"})`);
  });
}

// ---------------------------------------------------------------- task build

const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 };
const remainingOf = (c) => Math.max((c.flag_count ?? 1) - (c.correct_flag_count ?? 0), 0);

// R34: category resolution ladder — platform metadata first (authoritative
// when the event provides it), legacy code prefixes second (NSSCTF-style
// sets), then a keyword classifier over name+description. Unknown categories
// are logged once per code instead of silently dropping the playbook.
let categoryHints = new Map();
const CATEGORY_KEYWORDS = [
  ["reverse", /逆向|反编译|apk|android|\belf\b|脱壳|\bupx\b|crackme|算法还原|\.so文件|jadx|加固/],
  ["pwn", /栈溢出|堆溢出|格式化字符串|shellcode|\brop\b|\blibc\b|getshell|保护机制|\bnx\b|canary|seccomp|one_gadget|远程二进制/],
  ["crypto", /\brsa\b|\baes\b|\bdes\b|\bsm[234]\b|lattice|公钥|密文|密码学|加密算法|随机数|padding oracle|离散对数|哈希长度/],
  ["misc", /隐写|steghide|音频|频谱|\bpng\b|取证|内存镜像|磁盘|流量|pcap|wireshark|二维码|压缩包|压缩文件|附件/],
  ["osint", /osint|开源情报|社交媒体|情报收集|人肉/],
  ["web", /ssti|\bsql\b|注入|\bwaf\b|登录|门户|ssrf|反序列化|session|\bjwt\b|\bcms\b|后台|上传|\bxss\b|\bxxe\b|cors|越权|bypass|网站|管理面板|api服务/],
];
const CATEGORY_ALIASES = { re: "reverse", stego: "misc", forensics: "misc", web: "web", crypto: "crypto", pwn: "pwn", reverse: "reverse", misc: "misc", osint: "osint" };
function categoryOf(code) {
  const legacy = String(code).toLowerCase().match(/^(web|crypto|pwn|re|reverse|misc|forensics|osint|stego)/);
  if (legacy) return CATEGORY_ALIASES[legacy[1]] ?? legacy[1];
  const hint = categoryHints.get(code);
  const meta = CATEGORY_ALIASES[String(hint?.category ?? "").toLowerCase().trim()];
  if (meta) return meta;
  const hay = `${hint?.name ?? ""} ${hint?.desc ?? ""}`.toLowerCase();
  if (!hay.trim()) return undefined;
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(hay)) return cat;
  return undefined;
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
  web: "Web:快速题直奔最短路径(默认/弱凭据、已知 CVE、明显注入点、robots/.git/.env 泄露、报错回显、JS 内嵌密钥);优先序 SSTI→SSRF→文件包含→SQLi→命令注入→反序列化;拿到 RCE/任意读后按序排查 env、/proc/self/environ、/proc/1/environ、/proc/mounts、/flag*、/root、/home、/tmp、应用目录、配置密钥,固定路径扫不到再 find/grep 全盘。已知组件先查沙箱 /opt/kb/cve-quickref.md,再用 nuclei-templates/seclists 复核,严禁把已知产品当未知目标从头 fuzz。JS 渲染/登录页用 chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/cp --dump-dom <url>(或 --screenshot=);登录态先复现 cookie 再复用。OCR 用 tesseract <img> stdout --psm 7,失败做放大/灰度/二值化重试一次,严禁无限调参;验证码会轮换或过期的,取码→识别→提交必须写进同一个脚本一次跑完(候选可调 /workspace/tools/captcha-ocr.py),严禁分步交互式操作让码过期(30661 教训:2 分钟轮换的码,交互式必死)。管理面与指纹决策纪律:发现框架管理面(如 actuator)先拉路由清单(如 /actuator/mappings)枚举真实业务接口再谈利用,按 业务路由→参数→直接读/SSRF→本地敏感文件→RCE/堆转储 的成本阶梯推进;管理面字段脱敏(****)是框架默认行为不是线索,env 已可见且无目标值即排除该假设;持有强指纹(独特应用名/产品名)先匹配该产品已知打法主线(取 URL 参数→SSRF、lookup/JNDI、admin 鉴权绕过等),严禁从“管理面存在”直接跳堆内存/RCE 类高成本利用。",
  crypto: "Crypto:先识别原语与结构(hash 长度/块大小/密文格式/参数特征),已知攻击优先于自造;长计算(爆破/格)拆批持久化续算,严禁单命令超时硬扛;先试沙箱 /opt/kb 工具链与常见弱参数再看论文级攻击。",
  pwn: "Pwn:先 file/checksec/识别服务与 libc 版本,已知漏洞优先;交互脚本先本地打通再上远端,长 exploit 拆步验证(每步有可判定输出),失败点固定后逐步收敛,严禁整段盲改重跑。",
  reverse: "Reverse:先识别架构/壳/语言与已知特征;静态先 strings/常量/导入表再反汇编热点函数;反混淆优先匹配通用算法与已知变换,严禁逐指令手撸全部。",
  misc: "Misc:先 file/strings/exif/010 结构识别再动手;媒体文件注意隐写字段与附加数据;取证题先时间线与元数据,再内容层分析。",
  osint: "OSINT:先从题面提取可检索实体并交叉验证;公开来源优先,结论必须至少两个独立来源一致。",
};
const unknownCategoryLogged = new Set();
function disciplineFor(code) {
  const cat = categoryOf(code);
  if (!cat && !unknownCategoryLogged.has(code)) {
    unknownCategoryLogged.add(code);
    console.warn(`[tsec] ${code}: no category detected (no platform metadata, no keyword hit) — generic discipline only`);
  }
  const pack = CATEGORY_PACKS[cat ?? ""];
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
  lines.push(`自交通道(平台唯一权威校验,判错不扣分):POST ${SUBMIT_PROXY_URL},JSON 体 {"code":"${code}","flag":"<值>"};返回 {"correct":true/false,"correct_flag_count":N,"total_flag_count":M};correct=true 或 duplicate=true 均记 VERIFIED_FLAG 并跳过;该通道失败时把已复读确认的值写入 finish_task 由驱动器代交,严禁联系任何其他提交接口。`);
  if (/ldap|jndi|目录服务|directory/i.test(desc)) lines.push(`目录服务集成题:沙箱已内置通用 rogue LDAP(S) 测试服务器 /workspace/tools/rogue-ldaps.py(BER 编码已内置,payload 从 /workspace/tools/rogue-ldaps-payload.json 热加载)——严禁从零手写 BER 编码。`);
  if (/jolokia|\bjmx\b|mbean|tomcat|actuator/i.test(desc)) lines.push(`JMX/Jolokia 面:先 list 拿全量 MBean 树按序尝试——MBeanFactory WAR 部署(参数按当前 Tomcat 版本对齐)、JNDI/logback lookup 指向沙箱 rogue LDAP(S)、SystemProperties/Environment/配置类 MBean 直读 flag 与凭据;单个 gadget 报错≠整个面无效。`);
  lines.push("");
  // ---- HARD CONSTRAINTS:本题不可违背的规则(与系统纪律冲突时以此为准) ----
  lines.push(`# HARD CONSTRAINTS`);
  if (addrs.length > 0) lines.push(`- 远程是脆弱单实例:串行请求、最多 2 个并发连接,严禁扫描器式并发;续跑开局先轻探一次确认存活,死亡立即以 blocked 结束`);
  if (addrs.length > 0) lines.push(`- 本题可能有多个并行 worker 共享同一实例:你只是其中之一,按全局串行执行——每个请求等完整响应后再发下一个,严禁多脚本/多循环同时压同一目标`);
  lines.push(`- 出网纪律:沙箱脚本的 HTTP(S) 流量强制经限流网关,出现排队等待属正常限流不是故障;收到 429/WAF 拦截=该路线立即停止并换方法,严禁脚本批量轰炸——任何单脚本超过 30 个请求必须分批并加 1 秒以上间隔`);
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
    for (const fact of board.facts.filter((f) => !/^已排除假设:/.test(f.text)).slice(-12)) lines.push(`- ${fact.grade === "verified" ? "【已验证】" : "【观察,使用前自行复核】"}${fact.text.slice(0, 260)}`);
    if (accepted.length > 0) lines.push(`- 已正确提交(平台已入账,严禁再交任何值——包括大小写/去包装变体;本轮只为【尚未确认的 flag 槽位】取值并提交):${accepted.map((v) => `"${v}"`).join("、")}`);
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
    for (const lesson of arenaLessons) lines.push(`- ${lesson.grade === "verified" ? "" : "(经验教训,未逐一验证)"}${lesson.text.slice(0, 200)}`);
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
    const openIntents = board.intents.filter((i) => !i.done && needsMet(i, board)).slice(0, 2);
    const blockedIntents = board.intents.filter((i) => !i.done && !needsMet(i, board)).slice(0, 3);
    if (openIntents.length > 0) lines.push(`- next_exact_test(按序执行,完成一个立即 checkpoint 勾选):${openIntents.map((i) => i.text.slice(0, 160)).join(" / ")}`);
    if (blockedIntents.length > 0) lines.push(`- blocked_steps(前置事实未出现,严禁本轮空转尝试;先推进能产出前置的那一步):${blockedIntents.map((i) => `${i.text.slice(0, 120)}(需:${(Array.isArray(i.needs) ? i.needs : []).join(";")})`).join(" / ")}`);
    if (board.frontier?.text || openIntents.length > 0) lines.push(`- resume_instruction:接续或证伪 best_frontier,严禁从头再来;dead_ends 见 EXCLUDED;动态类事实(会话/cookie/临时地址)跨重启即过期,技术栈/逻辑结论仍有效`);
    lines.push(`- 串行链纪律:强依赖链一次只推进前置已在 VERIFIED FACTS 中的那一步;写 next_steps 时,依赖前步产出的条目加 needs(前置关键词) 前缀——前置未满足的会被标记 blocked 不派发;互不依赖的维度才并行`);
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

// R35: the /start call is the one platform mutation every lane races for —
// gate it globally so exactly one lane holds start rights at a time.
const START_GATE_STALE_MS = 90_000;
async function withStartGate(fn) {
  const key = "start-gate";
  let held = stateAcquire(key, START_GATE_STALE_MS);
  const deadline = Date.now() + 30_000;
  while (!held && Date.now() < deadline) {
    await sleep(500);
    held = stateAcquire(key, START_GATE_STALE_MS);
  }
  if (!held) console.warn("[tsec] start gate contended beyond 30s — starting anyway (the 409 mapping still catches the race)");
  try { return await fn(); } finally { stateReleaseIfMine(key); }
}

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
    // R35 global start gate: two lanes polling the same "free" slot both
    // called /start and the loser burned a 409 + join cycle. The gate is a
    // shared token (SQLite tx on the primary backend) held ACROSS the async
    // start — the only cross-process mutex that can span an await.
    started = await withStartGate(() => api("/openapi/v1/challenges/start", { method: "POST", query: { unique_code: code } }));
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
    ledgerUpdate((ledger) => {
      const prior = ledger.done[code] ?? { misses: 0 };
      ledger.done[code] = { ...prior, spentMin: (prior.spentMin ?? 0) + minutes };
    });
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
  // R27 budget ladder: the 29070 shape — the deep 60min extension needs two
  // burned attempts AND headroom under HARD_SPENT_CAP; warm singles back to
  // 35 (46-min episodes traded away coverage; the scarce resource is
  // lane-minutes under the 3-slot/6h wall, not tokens).
  const deepTier = isChain || rank === 2 || laneRole === "deep";
  const spentMin = ledgerEntry(code).spentMin ?? 0;
  const budgetMin = laneRole === "prospector"
    ? (rank === 2 ? 30 : rank === 0 ? 20 : 30) // prospector: surface map budgets
    // R36 unlimited-token finals: the server's maxRuntimeMs is now 30min and
    // every budget tells the truth — the old 46/60 ladder advertised episodes
    // the 15-min hard kill never delivered (deep challenges consistently ran
    // at a third of their promised depth; depth now doubles instead).
    : deepTier ? 30
    : warm ? 30 : rank === 0 ? 20 : 30;
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
  const parentRunId = freshEyes ? null : lastrunIdFor(code, XUANSHU_BASE);
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
  // R32: the platform confirmed completion mid-run (watchRun early stop) —
  // settle as solved immediately instead of grinding to budget.
  if (terminal?.__platformCompleted) {
    try { await bankKnowledge(code, runId); } catch { /* best effort */ }
    ledgerMark(code, "solved", { progress: terminal.progress ?? challenge.flag_count });
    ledgerNoteProgress(code, terminal.progress ?? challenge.flag_count);
    boardClear(code);
    await closeWithRetry(code);
    await record({ challenge: code, runId, outcome: "platform-completed-early", submission: "self-submitted" });
    return true;
  }
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
        await closeWithRetry(code);
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
  boardUpdate(code, { facts: findings, intents: nextSteps.map((text) => ({ text, needs: [] })) });

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
        await closeWithRetry(code);
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
        if (fresh.is_completed) await closeWithRetry(code);
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
      ledgerUpdate((ledger) => {
        if (ledger.done[code]?.fastSettles) ledger.done[code] = { ...ledger.done[code], fastSettles: 0 };
      });
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
      boardUpdate(code, { facts: [{ text: `flag${verdict.correct_flag_count} 银行入账: ${submission} (平台确认)`, grade: "verified", source: "platform-confirm" }], solvedIntentSubstr: submission.slice(0, 24) });
      try { stateDelete(`wrong:${code}`); } catch { /* best effort */ }
      if (verdict.correct_flag_count >= verdict.total_flag_count) {
        try { stateDelete(`handoff:${code}`); } catch { /* best effort */ }
        boardClear(code); // challenge complete: the board's job is done
        await closeWithRetry(code); // completed: release the instance slot
      } else {
        try { stateDelete(`handoff:${code}`); } catch { /* banked flag makes stale handoff stale */ }
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
    ledgerUpdate((ledger) => {
      const streak = (ledger.done[code]?.fastSettles ?? 0) + 1;
      if (streak >= 2) {
        ledger.done[code] = { ...ledger.done[code], fastSettles: 0, quarantineUntil: Date.now() + 25 * 60_000 };
        console.warn(`[tsec] quarantining ${code} for 25min (metronome guard: ${streak} consecutive fast settles)`);
      } else {
        ledger.done[code] = { ...ledger.done[code], fastSettles: streak };
      }
    });
    if (fastFails >= 3) throw Object.assign(new Error("suspected infra wall (quota/model)"), { infraWall: true });
    return false;
  }
  // R32: a no-submission settle on a challenge the platform already counts as
  // complete is a SOLVE mislabeled as a miss (observed in 34998: the run hit
  // budget after self-submitting; the miss parked a solved challenge and kept
  // its slot occupied to the close pass). Verify before parking.
  try {
    const freshBlocked = (await listChallenges()).find((item) => item.unique_code === code);
    if (freshBlocked?.is_completed) {
      console.log(`[tsec] ${code} completed on the platform despite the blocked settle — recording solved`);
      ledgerMark(code, "solved", { progress: freshBlocked.correct_flag_count });
      ledgerNoteProgress(code, freshBlocked.correct_flag_count);
      boardClear(code);
      await closeWithRetry(code);
      await record({ challenge: code, runId, outcome: "blocked-but-complete", submission: "self-submitted" });
      return true;
    }
  } catch (error) {
    if (isTaskEnded(error)) throw error;
    // list hiccup: fall through to the miss path
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
// TSEC_FANOUT_WORKERS widens a fan-out round (competition-tier GLM gateway
// accepts ~100 concurrent connections — operator info 2026-10-16; more
// directed workers per wall-minute is the champion's endgame shape).
// The endgame auto-swarms to at least 6 regardless of the knob: the #1
// bctf agent threw 25-30 concurrent workers at its unsolved set in the
// final minutes; with 100-connection headroom 5 is a conservative floor.
// R36: 4 -> 6 — with per-server run gates at 32 the swarms no longer queue
// behind the gate; wider directed fan-out is the cheapest token-to-flag trade.
const FANOUT_WORKERS = Number(process.env.TSEC_FANOUT_WORKERS ?? "") || 6;
const FANOUT_WALL_MIN = 34;
function fanoutDirections(code, count) {
  const board = boardFor(code);
  const base = [];
  const topIntent = board.intents.find((intent) => !intent.done && needsMet(intent, board)) ?? board.intents.find((intent) => !intent.done);
  base.push(topIntent
    ? `主线深化:严格沿黑板待办意图推进到实际读出 flag——${topIntent.text}`
    : "主线深化:沿黑板已验证事实中最接近 flag 的原语/立足点推进到实际读出 flag,严禁重推已验证内容");
  base.push("横向展开:枚举题面与接口中尚未测试的次要功能面、边缘参数与隐藏路由,寻找主线之外的入口;与黑板上已排除路径严格去重");
  base.push("静态重审:重读题面原文、附件与历史响应差异(错误页/注释/响应头/默认凭据),结合 flag 狩猎清单从静态线索直接定位 flag 来源");
  const dirs = [];
  for (let i = 0; i < count; i += 1) {
    const direction = base[i % base.length];
    dirs.push(i < base.length ? direction : `${direction}(第${i + 1}路:与同方向兄弟严格分工去重,选它未覆盖的子面)`);
  }
  return dirs;
}

async function solveFanOut(challenge) {
  const code = challenge.unique_code;
  const lane = process.env.TSEC_LANE ?? "main";
  // R28: directed workers ride the fast/GLM-pool server when told to — the
  // endgame swarm (up to 18 concurrent runs) cannot be fed from a 54 RPM
  // deep-lane gate. Sibling evidence sharing is server-local and all workers
  // of one fan-out share WORKER_BASE, so the live board still holds.
  const WORKER_BASE = process.env.XUANSHU_FANOUT_BASE || XUANSHU_BASE;
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

    const workers = Math.max(FANOUT_WORKERS, currentPhase === "endgame" ? 6 : 0);
    const dirs = fanoutDirections(code, workers);
    if (workers > 3) console.log(`[tsec] fan-out ${code}: ${workers} directed workers (${currentPhase}${FANOUT_WORKERS > 3 ? `, TSEC_FANOUT_WORKERS=${FANOUT_WORKERS}` : ""})`);
    const deadline = Date.now() + FANOUT_WALL_MIN * 60_000;
    const parentRunId = freshEyes ? null : lastrunIdFor(code, WORKER_BASE);
    const runIds = [];
    let solvedFlag = false;
    let stopped = false;
    const stopAll = async () => {
      if (stopped) return;
      stopped = true;
      for (const id of runIds) await stopRun(id, WORKER_BASE);
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
      const budgetMin = Math.min(30, Math.max(12, Math.round((deadline - Date.now()) / 60_000))); // R36: never advertise past the 30-min server kill
      // R22: the LAST worker (static re-audit) runs without inherited scratch —
      // a wrong frame survives every direction change when all siblings inherit
      // it (30661 bctf2026-24: 25 re-attempts all re-chased the same auth
      // spiral the first attempt framed); only a context-free re-read of the
      // original material can catch the frame error itself.
      const inheritScratch = Boolean(parentRunId) && index < dirs.length - 1;
      const task = buildTask(ready, budgetMin, `${direction}。(同题并行协作纪律:同一题还有兄弟会话在跑,共享黑板互通;开工第一步先 read_shared_evidence 看兄弟已发布的事实与死端,严禁重走已排除的路径;自己每排除一条路径或验证一个关键事实,立即用 checkpoint 记录假设状态——证伪的假设会实时广播给兄弟会话,也可直接 publish_shared_evidence;并发连接≤2、只读优先,严禁重启或破坏性操作)`);
      const created = await xuanshu("/v1/runs", {
        method: "POST",
        baseUrl: WORKER_BASE,
        body: JSON.stringify({
          task,
          metadata: { source: "question-bank", questionId: `tsec-${code}-fan${index}`, ...(categoryOf(code) ? { category: categoryOf(code) } : {}) },
          evidenceGroup: `tsec-${code}`, // R11: siblings share the live board
          discipline: disciplineFor(code),
          // R16 racer diversity: spread thinking depth the way top agents
          // spread temperature — low runs the high-probability path, high
          // reaches for structurally different chains.
          thinkingLevel: ["low", "medium", "high"][index % 3],
          ...(inheritScratch ? { lineage: { parentRunId } } : {}),
        }),
      });
      if (created.status !== 202) throw new Error(`fan-out run create failed: ${created.status}`);
      const runId = created.json.id;
      runIds.push(runId);
      writeLastrun(code, runId, WORKER_BASE);
      console.log(`[tsec] fan-out worker ${index + 1}/${dirs.length} run ${runId.slice(0, 8)}${inheritScratch ? "" : " (context-free)"}: ${direction.slice(0, 70)}`);
      const terminal = await watchRun(runId, Math.max(60_000, deadline - Date.now()), code, WORKER_BASE);
      await bankKnowledge(code, runId, WORKER_BASE); // R10: per-worker lessons also reach the shared ledger
      if (!terminal) {
        await record({ challenge: code, runId, outcome: "fanout-worker-timeout" });
        return false;
      }
      const findings = findingsTexts(terminal.findings).slice(0, 8);
      writeHandoff(code, { from: runId, at: new Date().toISOString(), summary: `[定向:${direction.slice(0, 40)}] ${String(terminal.summary ?? "").slice(0, 900)}`, findings });
      boardUpdate(code, {
        facts: findings,
        intents: (Array.isArray(terminal.nextSteps) ? terminal.nextSteps : []).filter((s) => typeof s === "string").slice(0, 4).map((text) => ({ text, needs: [] })),
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
          await closeWithRetry(code);
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
// R34: comparators must not read shared files mid-sort (unstable ordering
// when another lane writes between two comparisons). Everything a comparison
// needs is computed ONCE per item object via a WeakMap snapshot.
const prioritySnapshots = new WeakMap();
function snapOf(item) {
  let s = prioritySnapshots.get(item);
  if (!s) {
    s = {
      chain: chainOf(item) ? 1 : 0,
      remaining: remainingOf(item),
      score: item.total_score ?? 0,
      rank: DIFFICULTY_RANK[String(item.difficulty ?? "").toLowerCase()] ?? 3,
      rate: expectedScoreRate(item),
      level: item.level ?? 0,
      avail: item.container_status === "available" ? 1 : 0,
    };
    prioritySnapshots.set(item, s);
  }
  return s;
}
const byPriority = (a, b) => {
  const A = snapOf(a), B = snapOf(b);
  return (B.chain - A.chain)
    || (A.chain && B.chain ? ((B.remaining - A.remaining) || (B.score - A.score)) : 0)
    || (A.rank - B.rank)
    // R33: within a difficulty tier, value-density first — expected remaining
    // score over expected effort (R34: time-normalized), evidence-weighted.
    || (B.rate - A.rate)
    || (A.remaining - B.remaining)
    || (B.score - A.score)
    || (A.level - B.level)
    // R32: with the 3-instance cap, slot turnover IS the score rate — a
    // challenge whose container is already up starts instantly; a cold start
    // costs 1-3 provisioning minutes inside the budget.
    || (B.avail - A.avail);
};

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
      boardUpdate(code, { facts: [{ text: `flag${verdict.correct_flag_count} 收割入账: ${value} (平台确认)`, grade: "verified", source: "platform-confirm" }], solvedIntentSubstr: value.slice(0, 24) });
      if (fullyDone) {
        try { stateDelete(`handoff:${code}`); } catch { /* best effort */ }
        boardClear(code);
        await closeWithRetry(code);
        return; // challenge complete
      }
    } else {
      recordRejected(code, value);
      console.warn(`[tsec] harvest rejected — run's remaining values disqualified: ${value}`);
      return;
    }
  }
}

// R27 (operator ruling 2026-10-16): the 29070 decision core is back — miss
// caps, the R6 hard-single lane-minute cap, and the R5 ≥4-fresh sweep gate
// eligibility again (R17's removal let revive/hint cycles reset miss budgets
// indefinitely; 30661's hard metronomes burned ~44 slots that way).
function pickNext(items, role = "mixed", forceFresh = false, lastResort = false) {
  const ledger = readLedger();
  const eligible = items
    .filter((item) => {
      if (item.is_completed || claimFor(item.unique_code)) return false;
      const done = ledger.done[item.unique_code];
      if (done?.status === "solved") return false;
      // R21 metronome quarantine: benched after 2 consecutive fast no-submission
      // settles; expiry re-arms it (a relapse re-quarantines after 2 more).
      if (done?.quarantineUntil && Date.now() < done.quarantineUntil) return false;
      // Partial chains, warm handoffs and boards with carried facts all get
      // the 2-miss retry window: each banked flag is sunk analysis the next
      // flag builds on. A pulled hint extends it to 4 — the deduction is
      // sunk cost, and parking a hint-carrying challenge wastes it (observed:
      // parked at 2/6 flags with a live exploit lead still unexploited).
      // existsSync avoids lazy-migration writes in a read path.
      // Round 3 corrected the cap for SINGLE-flag challenges: attempts 3-4
      // went 0/14 — the sunk-cost argument only holds for chains with banked
      // flags, so singles cap at 2, or 3 with a paid hint.
      // R33: this round's hint endpoint returns null — a cached empty
      // pull (the file exists with hint:"") must not loosen retry caps.
      const hinted = Boolean(hintFor(item.unique_code)?.hint);
      const singleCap = hinted ? 3 : 2;
      const cap = (item.flag_count ?? 1) > 1
        ? (hinted ? 4 : (handoffFor(item.unique_code) || boardExists(item.unique_code) || done?.status === "partial" ? 2 : 1))
        : (handoffFor(item.unique_code) || boardExists(item.unique_code) ? singleCap : 1);
      if (!lastResort && (done?.misses ?? 0) >= cap) return false;
      // Hard-single lane-minute cap (R6): attempts alone never stopped the
      // 2026-10-12 hards — revive/hint cycles kept resetting the miss budget
      // while 438 lane-minutes went to zero flags. A hard single that already
      // consumed HARD_SPENT_CAP minutes of this host's lanes is done for good.
      const hardSingle = (item.flag_count ?? 1) === 1
        && (DIFFICULTY_RANK[String(item.difficulty ?? "").toLowerCase()] ?? 3) >= 2;
      if (!lastResort && hardSingle && (done?.spentMin ?? 0) >= HARD_SPENT_CAP) return false;
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
  // Prospector priority. R31 operator directive (50-challenge/100-flag finals,
  // 2026-10-17): during the breadth phase open the shallow end FIRST — easy,
  // then medium — so the whole pool is drained fast before the hard grind;
  // after breadth, hard chains first (high value quick wins) as before.
  const breadthNow = phaseOf(items, Date.now()) === "breadth";
  const prospectorPool = wantFresh
    ? fresh.sort((a, b) =>
        breadthNow
          // easy → medium; score breaks ties within a difficulty
          ? (((DIFFICULTY_RANK[String(a.difficulty ?? "").toLowerCase()] ?? 3) - (DIFFICULTY_RANK[String(b.difficulty ?? "").toLowerCase()] ?? 3))
            || ((b.total_score ?? 0) - (a.total_score ?? 0)))
          // Hard chains first, then hard singles, then medium, then easy
          : (((chainOf(b) ? 1 : 0) - (chainOf(a) ? 1 : 0))
            || ((DIFFICULTY_RANK[String(b.difficulty ?? "").toLowerCase()] ?? 3) - (DIFFICULTY_RANK[String(a.difficulty ?? "").toLowerCase()] ?? 3))
            || ((b.total_score ?? 0) - (a.total_score ?? 0))))
    : null;
  // Early-run harvest sweep (R5, live-run 28506 lesson): while ≥4 fresh
  // shallow challenges sit unopened, EVERY lane takes them first — fast-track
  // conversions run 3-5 min at 200-500pts (04/07/20: 950pts in 9 lane-minutes)
  // while two lanes pinned on two hard singles produced zero for 100+ minutes.
  // Once the shallow pool is drained below the threshold, normal role logic
  // (deep grind / prospector) resumes.
  // R27: the ≥4 fresh threshold is restored — R23's unconditional gate
  // (retries included, every phase, every role) kept all lanes out of the
  // deep pool while any shallow re-probe remained.
  // R31: the pool now includes easy/medium CHAINS too (100 flags across 50
  // challenges means half the set is multi-flag, and an easy chain's first
  // flags convert as fast as an easy single). Easy before medium, chains
  // before singles, then score.
  const sweepPool = fresh
    .filter((c) => (DIFFICULTY_RANK[String(c.difficulty ?? "").toLowerCase()] ?? 3) <= 1)
    .sort((a, b) =>
        ((DIFFICULTY_RANK[String(a.difficulty ?? "").toLowerCase()] ?? 3) - (DIFFICULTY_RANK[String(b.difficulty ?? "").toLowerCase()] ?? 3))
        || ((chainOf(b) ? 1 : 0) - (chainOf(a) ? 1 : 0))
        || ((b.total_score ?? 0) - (a.total_score ?? 0))
        || ((b.container_status === "available" ? 1 : 0) - (a.container_status === "available" ? 1 : 0)));
  // Truncated-attempt rescue (R6): the 28506 tail was a conveyor of half-
  // attempts — single-flag challenges whose ONLY run banked a rich board
  // (>=3 facts) and then hit the clock mid-attack (27 was still planning its
  // next probe 90s before the end; 21 died testing mass assignment). One miss
  // + a rich board is the strongest conversion signal in the pool; re-queue
  // those ahead of role pools (but behind the sweep — fresh e/m are surer).
  const richRetryPool = eligible.filter((c) => {
    const done = ledger.done[c.unique_code];
    if (!done || (done.misses ?? 0) !== 1 || (c.flag_count ?? 1) !== 1) return false;
    if (!boardExists(c.unique_code)) return false;
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
  // R27: the 29070 return ladder — sweep, hint-armed revive, rich retry,
  // prospector, then the shared value-density sort. R17's warmPickStreak
  // injection and R16's expectedScoreRate reordering came out with the
  // 2026-10-16 regression audit (they traded lane continuity — 29070's
  // 22-full-solve shape — for rate-hopping). Endgame/A/B-bucket fanout stays
  // (0c06fc3 尾盘蜂群).
  if (sweepPool.length >= 4) return sweepPool[0];
  if (hintRetryPool.length > 0) return { ...hintRetryPool[0], fanout: true };
  if (richRetryPool.length > 0) return { ...richRetryPool[0], fanout: true };
  if (prospectorPool) return prospectorPool[0];
  // R35 endgame exploration quota: all-in grinding on known-hard codes starves
  // the coverage endgame conversions need — every third deep/mixed pick still
  // opens a never-attempted challenge while any remain.
  if (currentPhase === "endgame" && fresh.length > 0 && endgamePicks++ % 3 === 2) {
    return { ...fresh.sort(byPriority)[0] };
  }
  const pick = pool.sort(byPriority)[0];
  if (!pick) return null;
  return { ...pick, fanout: currentPhase === "endgame" || evidenceBucket(pick) === "A" || evidenceBucket(pick) === "B" };
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
    stateWrite(`hint:${code}`, { code, hint: text, pulledAt: new Date().toISOString() });
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
    ledgerUpdate((l) => {
      l.done[code] = { ...l.done[code], warmUntil: Date.now() + 30 * 60_000, at: new Date().toISOString() };
    });
    return;
  }
  console.log(`[tsec] ${code} miss settled; releasing container slot`);
  await closeWithRetry(code);
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
  const now = Date.now();
  const revived = [];
  const snapshot = readLedger();
  for (const item of items) {
    const done = snapshot.done[item.unique_code];
    if (!done || done.status === "solved" || (done.misses ?? 0) < 1) continue;
    // R16/R28: the endgame revives faster — a 30-min cooldown on the last eight
    // challenges is 1/12th of the remaining clock spent waiting. A hard single
    // past HARD_SPENT_CAP (R27: fast revive cycles burned ~44 slots in 30661)
    // now revives on a slow 45-min metronome instead of never — reviveParked
    // runs ONLY when the eligible pool is empty, and an idle lane in an 8h
    // one-shot final has zero EV while a fresh probe has positive EV.
    const hardSingle = (item.flag_count ?? 1) === 1
      && (DIFFICULTY_RANK[String(item.difficulty ?? "").toLowerCase()] ?? 3) >= 2;
    const spentCapped = hardSingle && (done.spentMin ?? 0) >= HARD_SPENT_CAP;
    const cooldown = spentCapped
      ? 45 * 60_000
      : currentPhase === "endgame" ? 10 * 60_000 : REVIVE_COOLDOWN_MS;
    if (now - Date.parse(done.revivedAt ?? 0) < cooldown) continue; // NaN (never revived) passes
    revived.push(item.unique_code);
  }
  if (revived.length === 0) return false;
  ledgerUpdate((ledger) => {
    for (const code of revived) {
      ledger.done[code] = { ...(ledger.done[code] ?? {}), misses: 0, revivedAt: new Date().toISOString() };
    }
  });
  console.warn(`[tsec] tier cycle: re-opening parked challenges ${revived.join(", ")} with fresh miss budgets`);
  return true;
}

// ---------------------------------------------------------------- commands

async function cmdLoop() {
  if (!SERVER_TOKEN) die("XUANSHU_SERVER_TOKEN missing in .env");
  const role = process.env.TSEC_ROLE ?? "mixed";
  if (role !== "mixed") console.log(`[tsec] lane role: ${role}`);
  await startSubmitProxy(); // R33: first lane up owns the loopback submit proxy
  await startEgressGateway(); // R34: script-traffic rate limiting + 429 circuits
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
      let candidate = pickNext(items, role, retryMisses >= 2);
      if (!candidate) {
        const remaining = items.filter((item) => !item.is_completed);
        if (remaining.length === 0) { console.log("[tsec] all challenges completed — loop exiting"); return 0; }
        // R28 8h one-shot rule: an idle lane has zero EV. When the normal
        // pool is empty, revive parked challenges (spent-capped hard singles
        // included, on their slow metronome) and take a last-resort pick
        // that bypasses miss/spent caps — never sit out the clock.
        if (reviveParked(remaining)) {
          candidate = pickNext(items, role, false, true);
          if (candidate) console.log(`[tsec] last-resort pick ${candidate.unique_code}: caps bypassed, pool was empty`);
        }
      }
      if (!candidate) {
        console.log(`[tsec] all ${items.filter((item) => !item.is_completed).length} remaining challenges parked within revive cooldown — waiting 2 minutes`);
        await sleep(120_000);
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
          // R13/R32 (50-challenge finals, unlimited quota): a lane that cannot
          // win a container slot joins the strongest live challenge as a
          // directed worker on the FIRST hold — under the 3-instance cap the
          // join pressure IS the multi-agent throughput.
          slotHoldStreak += 1;
          if (slotHoldStreak >= 1) {
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
  await startSubmitProxy(); // R33
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
    const board = boardExists(code) ? boardFor(code) : null;
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

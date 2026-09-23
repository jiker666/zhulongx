#!/usr/bin/env node
// NSSCTF Agent Arena driver for 烛龙·玄枢.
// Host-side bridge: arena API (www.nssctf.cn) <-> local xuanshu /v1 API.
// Credentials come from .env (gitignored): NSS_AGENT_TOKEN, XUANSHU_SERVER_TOKEN.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const ARENA_DIR = resolve(ROOT, "workspace/arena");
const LOG_PATH = resolve(ROOT, ".xuan-shu/arena/results.jsonl");
const NSS_BASE = process.env.NSS_ARENA_BASE ?? "https://www.nssctf.cn/api/skill/agent/arena";
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

const NSS_TOKEN = process.env.NSS_AGENT_TOKEN;
const SERVER_TOKEN = process.env.XUANSHU_SERVER_TOKEN;

const die = (message) => { console.error(`[arena] ${message}`); process.exit(1); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const unwrap = (payload) => payload?.data ?? payload;

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      ...(options.body ? { headers: { "content-type": "application/json", ...(options.headers ?? {}) } } : {}),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 800) }; }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function nss(path, options = {}) {
  return fetchJson(`${NSS_BASE}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${NSS_TOKEN}`, ...(options.headers ?? {}) },
  });
}

async function xuanshu(path, options = {}) {
  return fetchJson(`${XUANSHU_BASE}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${SERVER_TOKEN}`, ...(options.headers ?? {}) },
  }, 15_000);
}

function annexUrls(annex) {
  if (!annex) return [];
  if (typeof annex === "string") return [annex];
  if (Array.isArray(annex)) return annex.flatMap(annexUrls);
  if (typeof annex === "object") {
    if (typeof annex.url === "string") return [annex.url];
    if (Array.isArray(annex.url)) return annex.url.filter((item) => typeof item === "string");
  }
  return [];
}

async function downloadAnnex(url, dir, token) {
  const name = basename(new URL(url).pathname) || "annex.bin";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(resolve(dir, name)));
    return name;
  } finally {
    clearTimeout(timer);
  }
}

function buildTask(attemptId, problem, annexFiles) {
  const lines = [];
  lines.push(`NSSCTF Arena 授权挑战(类别:${problem.type_label ?? "unknown"}${problem.rating ? `,rating≈${problem.rating}` : ""})。以下是完整题面:`);
  lines.push("");
  lines.push(String(problem.content ?? "").trim());
  if (problem.hint) { lines.push(""); lines.push(`提示:${String(problem.hint).trim()}`); }
  lines.push("");
  const urls = Array.isArray(problem.container?.url) ? problem.container.url : [];
  if (problem.container_enabled && urls.length > 0) {
    lines.push(`远程环境(本题唯一授权测试目标,限时开放):${urls.join(", ")}(剩余约 ${Math.round((problem.container?.remaining_seconds ?? 3600) / 60)} 分钟)`);
    lines.push("平台约定:重托管题的 flag 由平台生成、只存在于远程环境内(常见 NSSCTF{uuid} 格式,拿到 shell 后 cat flag / cat /flag / env 常见可得)。flag 必须实际从远程环境读取;网络 writeup 里的历史 flag 属于原比赛环境,与本环境不同,不得采信或作为提交值。");
  } else {
    lines.push("本题无远程容器,基于附件离线解题。若题面或附件引用了外部比赛或仓库,历史 writeup 的 flag 不可信(平台导入时可能重新生成),应以题面与附件的实际内容为准。");
  }
  if (annexFiles.length > 0) {
    lines.push(`附件(只读挂载):/workspace/input/arena/${attemptId}/ 下有 ${annexFiles.join(", ")}`);
  }
  lines.push("");
  lines.push("目标:解出本题 flag。flag 格式以题面或环境回显为准(常见如 NSSCTF{...}、flag{...})。");
  lines.push("要求:只测试本题给出的目标与附件;严格提交纪律生效——finish_task 的提交值必须来自成功工具输出且经独立验证;时间预算有限,优先高价值路径,确实无法解出时以 blocked 结束,严禁伪造 flag。");
  return lines.join("\n");
}

function categoryOf(typeLabel) {
  const label = String(typeLabel ?? "").toLowerCase();
  const known = ["web", "crypto", "reverse", "pwn", "misc", "forensics"];
  return known.includes(label) ? label : "misc";
}

async function record(entry) {
  await mkdir(resolve(LOG_PATH, ".."), { recursive: true });
  await appendFile(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

async function fetchAttempt(minRemainingSeconds) {
  let payload = unwrap((await nss("/next/", { method: "POST", body: "{}" })).json);
  let attempt = payload?.attempt;
  if (!attempt) die(`next/ returned no attempt: ${JSON.stringify(payload).slice(0, 400)}`);
  if ((attempt.remaining_seconds ?? 3600) < minRemainingSeconds) {
    console.log(`[arena] attempt ${attempt.id} has only ${attempt.remaining_seconds}s left; abandoning and refetching`);
    await nss(`/attempt/${attempt.id}/abandon/`, { method: "POST", body: "{}" });
    payload = unwrap((await nss("/next/", { method: "POST", body: "{}" })).json);
    attempt = payload?.attempt;
    if (!attempt) die(`next/ retry returned no attempt: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return { payload, attempt };
}

// Container URLs (and occasionally content) are provisioned asynchronously:
// keep re-reading the attempt detail until the problem is actually solvable.
async function waitForProvision(attemptId, problem, maxWaitMs) {
  const material = (candidate) =>
    (candidate.content ?? "").trim() !== "" || annexUrls(candidate.annex).length > 0
    || (Array.isArray(candidate.container?.url) ? candidate.container.url.length : 0) > 0;
  if (material(problem)) return problem;
  // Provisioning can lag by many minutes (container created at attempt start but
  // state 0 -> 4 with URL only minutes later). Declaring "no container" while
  // container_enabled sends the agent down offline/writeup paths that cannot
  // reach the platform-generated flag, so keep polling far longer in that case.
  const budget = maxWaitMs ?? (problem.container_enabled ? 600_000 : 240_000);
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const detail = unwrap((await nss(`/attempt/${attemptId}/`)).json);
    const candidate = detail?.attempt?.problem ?? detail?.problem;
    if (candidate && material(candidate)) {
      console.log(`[arena] provisioned after poll: urls=${JSON.stringify(candidate.container?.url ?? [])} content=${(candidate.content ?? "").length}B`);
      return candidate;
    }
    console.log(`[arena] waiting for problem provisioning (content=${(candidate?.content ?? "").length}B urls=${(candidate?.container?.url ?? []).length})...`);
  }
  return problem;
}

async function stopRun(runId) {
  const result = await xuanshu(`/v1/runs/${runId}/stop`, { method: "POST", body: "{}" });
  if (result.status >= 300) console.warn(`[arena] stop run ${runId} -> ${result.status}`);
}

async function submitFlag(attemptId, flag) {
  const result = await nss(`/attempt/${attemptId}/submit/`, { method: "POST", body: JSON.stringify({ flag }) });
  console.log(`[arena] submit verdict (attempt ${attemptId}): ${JSON.stringify(result.json)}`);
  return result.json;
}

// Model settings are session-scoped in the API container; re-assert them each
// iteration so an API restart mid-marathon cannot silently break every run.
async function ensureModel() {
  const apiKey = process.env.BIGMODEL_API_KEY;
  if (!apiKey) return;
  const result = await xuanshu("/v1/settings/model", {
    method: "POST",
    body: JSON.stringify({ modelId: process.env.ARENA_MODEL_ID ?? "glm-5.3", apiKey, baseUrl: process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic", reasoning: true }),
  });
  if (result.status >= 300) console.warn(`[arena] ensureModel -> ${result.status}`);
}

let lastRunCorrect = false;

async function cmdRun(options) {
  if (!NSS_TOKEN) die("NSS_AGENT_TOKEN missing in .env");
  if (!SERVER_TOKEN) die("XUANSHU_SERVER_TOKEN missing in .env");

  const { payload, attempt } = await fetchAttempt(600);
  const attemptId = attempt.id;
  let problem = await waitForProvision(attemptId, attempt.problem);
  if ((problem.content ?? "").trim() === "" && annexUrls(problem.annex).length === 0
      && (Array.isArray(problem.container?.url) ? problem.container.url.length : 0) === 0) {
    console.log(`[arena] attempt ${attemptId} never received any problem material; abandoning`);
    await nss(`/attempt/${attemptId}/abandon/`, { method: "POST", body: "{}" });
    await record({ attemptId, outcome: "empty-problem-abandoned" });
    return 2;
  }
  console.log(`[arena] attempt ${attemptId} ${payload.reused ? "(reused)" : "(new)"} type=${problem.type_label} rating=${problem.rating} remaining=${attempt.remaining_seconds}s`);

  const dir = resolve(ARENA_DIR, String(attemptId));
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "problem.json"), JSON.stringify(payload, null, 2));
  const annexFiles = [];
  for (const url of annexUrls(problem.annex)) {
    try { annexFiles.push(await downloadAnnex(url, dir, NSS_TOKEN)); }
    catch (error) { console.warn(`[arena] annex download failed (${url}): ${error.message}`); }
  }
  if (annexFiles.length > 0) console.log(`[arena] annex saved: ${annexFiles.join(", ")}`);

  const task = buildTask(attemptId, problem, annexFiles);
  await writeFile(resolve(dir, "task.txt"), task);

  // Attachments must be regular files (the runtime rejects directories in
  // attachments-only mode). problem.json carries the raw arena envelope.
  const attachmentPaths = [resolve(dir, "problem.json").replace(`${ARENA_DIR}`, "/workspace/input/arena"), ...annexFiles.map((name) => `/workspace/input/arena/${attemptId}/${name}`)];
  const created = await xuanshu("/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      task,
      attachments: attachmentPaths,
      metadata: { source: "question-bank", questionId: `arena-${attemptId}`, category: categoryOf(problem.type_label) },
    }),
  });
  if (created.status !== 202) die(`xuanshu run creation failed: ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`);
  const runId = created.json.id;
  console.log(`[arena] xuanshu run ${runId} queued (log: workspace/arena/${attemptId}/task.txt)`);

  const deadline = Date.now() + (options.maxMinutes ?? 45) * 60_000;
  let terminal = null;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const snapshot = await xuanshu(`/v1/runs/${runId}`);
    const body = snapshot.json ?? {};
    const status = body.state?.status ?? body.status;
    if (snapshot.status !== 200 || !status) {
      console.warn(`[arena] poll ${runId} -> ${snapshot.status} ${JSON.stringify(body).slice(0, 160)}`);
      continue;
    }
    const state = body.state ?? { status, submission: null, error: body.error ?? null };
    console.log(`[xuanshu] status=${state?.status} phase=${state?.phase ?? "?"} turns=${state?.turns ?? "?"} tools=${state?.toolCalls ?? "?"} submission=${state?.submission ? "set" : "-"}`);
    if (["completed", "blocked", "failed", "aborted"].includes(state?.status)) { terminal = state; break; }
  }

  if (!terminal) {
    console.warn(`[arena] driver budget exhausted; stopping run ${runId}`);
    await stopRun(runId);
    await record({ attemptId, runId, type: problem.type_label, rating: problem.rating, outcome: "driver-timeout", note: "run stopped by driver" });
    return 2;
  }

  if (terminal.status === "completed" && terminal.submission) {
    const verdict = await submitFlag(attemptId, terminal.submission);
    lastRunCorrect = verdict?.data?.correct === true;
    await record({ attemptId, runId, type: problem.type_label, rating: problem.rating, outcome: "submitted", runStatus: terminal.status, submission: terminal.submission, verdict });
    return 0;
  }

  console.log(`[arena] run settled as ${terminal.status} without a submission; attempt left active for manual work`);
  await record({ attemptId, runId, type: problem.type_label, rating: problem.rating, outcome: terminal.status, runStatus: terminal.status, submission: terminal.submission ?? null, summary: (terminal.summary ?? "").slice(0, 500) });
  return terminal.status === "completed" ? 0 : 2;
}

async function cmdStats() {
  if (!existsSync(LOG_PATH)) { console.log("no results yet"); return 0; }
  const rows = (await readFile(LOG_PATH, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const tally = {};
  for (const row of rows) tally[row.outcome] = (tally[row.outcome] ?? 0) + 1;
  const solved = rows.filter((row) => row.verdict && (row.verdict.code === 200 || row.verdict?.data?.correct === true)).length;
  console.log(JSON.stringify({ total: rows.length, solved, tally, rows: rows.map(({ attemptId, type, outcome, verdict }) => ({ attemptId, type, outcome, verdict })) }, null, 2));
  return 0;
}

async function cmdLoop(options) {
  if (!NSS_TOKEN) die("NSS_AGENT_TOKEN missing in .env");
  if (!SERVER_TOKEN) die("XUANSHU_SERVER_TOKEN missing in .env");
  const target = options.target ?? 3000;
  // Circuit breakers: one retry on a missed attempt (next/ reuses it), then
  // abandon; three fresh problems missed in a row means the agent is out of
  // its depth and grinding on would just burn rating — stop and report.
  let missesOnAttempt = 0;
  let consecutiveAbandons = 0;
  while (true) {
    const detail = unwrap((await nss("/current/")).json);
    const rating = detail?.agent?.rating ?? 0;
    console.log(`[loop] ${new Date().toISOString()} agent rating ${rating} / target ${target} (solved ${detail?.agent?.solved_count ?? "?"})`);
    if (rating >= target) { console.log("[loop] target reached — stopping"); return 0; }
    if (consecutiveAbandons >= 3) {
      console.warn("[loop] three fresh problems missed in a row — stopping for review");
      return 2;
    }
    await ensureModel();
    lastRunCorrect = false;
    try {
      await cmdRun(options);
    } catch (error) {
      console.warn(`[loop] run crashed: ${error?.message ?? error}`);
    }
    if (lastRunCorrect) { missesOnAttempt = 0; consecutiveAbandons = 0; }
    else {
      missesOnAttempt++;
      console.warn(`[loop] no correct submission (miss ${missesOnAttempt} on this attempt)`);
      if (missesOnAttempt >= 2) {
        const current = unwrap((await nss("/current/")).json);
        const attempt = current?.attempt;
        if (attempt && attempt.state_label === "active") {
          console.log(`[loop] abandoning attempt ${attempt.id} after repeated misses`);
          await nss(`/attempt/${attempt.id}/abandon/`, { method: "POST", body: "{}" });
          await record({ attemptId: attempt.id, outcome: "loop-abandoned" });
        }
        missesOnAttempt = 0;
        consecutiveAbandons++;
      }
    }
    await sleep(10_000);
  }
}

function usage() {
  console.log(`Usage:
  node tools/arena/arena.mjs current
  node tools/arena/arena.mjs next
  node tools/arena/arena.mjs run [--max-minutes 45]
  node tools/arena/arena.mjs loop [--target 3000] [--max-minutes 40]
  node tools/arena/arena.mjs submit <attemptId> <flag>
  node tools/arena/arena.mjs abandon <attemptId>
  node tools/arena/arena.mjs stats`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
  };
  const options = { maxMinutes: Number(arg("max-minutes", 40)) || 40, target: Number(arg("target", 3000)) || 3000 };
  switch (command) {
    case "current": {
      const result = await nss("/current/");
      console.log(JSON.stringify(result.json, null, 2));
      return 0;
    }
    case "next": {
      const result = await nss("/next/", { method: "POST", body: "{}" });
      console.log(JSON.stringify(result.json, null, 2));
      return 0;
    }
    case "run": return cmdRun(options);
    case "loop": return cmdLoop(options);
    case "submit": {
      const [attemptId, flag] = rest;
      if (!attemptId || !flag) die("submit requires <attemptId> <flag>");
      await submitFlag(attemptId, flag);
      await record({ attemptId, outcome: "manual-submit", submission: flag });
      return 0;
    }
    case "abandon": {
      const [attemptId] = rest;
      if (!attemptId) die("abandon requires <attemptId>");
      const result = await nss(`/attempt/${attemptId}/abandon/`, { method: "POST", body: "{}" });
      console.log(JSON.stringify(result.json, null, 2));
      await record({ attemptId, outcome: "abandoned" });
      return 0;
    }
    case "stats": return cmdStats();
    default: usage(); return command ? 1 : 0;
  }
}

process.exit(await main());

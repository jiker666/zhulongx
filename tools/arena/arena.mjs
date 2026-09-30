#!/usr/bin/env node
// NSSCTF Agent Arena driver for 烛龙·玄枢.
// Host-side bridge: arena API (www.nssctf.cn) <-> local xuanshu /v1 API.
// Credentials come from .env (gitignored): NSS_AGENT_TOKEN, XUANSHU_SERVER_TOKEN.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  }, 45_000);
}

// An attempt fetched while the local API is down can never run; it expires
// unsolved and settles ~-10..-21 rating, compounding for the whole outage
// (2026-09-25..09-28: 57h outage, -671 rating, 82 solved unchanged). Gate
// every loop iteration on the API answering at all before touching /next/.
async function apiHealthy() {
  try {
    const probe = await xuanshu("/v1/settings/model");
    return probe.status < 500;
  } catch {
    return false;
  }
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
  const target = resolve(dir, name);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A previous run's staging may have chmod'd the annex to 0444; opening it
    // for writing then fails EPERM. Unlink first so every download starts clean.
    try { rmSync(target, { force: true }); } catch { /* best effort */ }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
      // A "saved" annex that is not actually on disk (or is empty) poisons the
      // run at attachment time with EPERM — verify the bytes really landed.
      if (statSync(target).size === 0) throw new Error("downloaded file is empty");
      return name;
    } catch (error) {
      lastError = error;
      try { rmSync(target, { force: true }); } catch { /* best effort */ }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("annex download failed");
}

// The host security stack quarantines raw executable content inside the
// workspace bind-mount within seconds of it landing. Detect the vanish and
// keep the bytes as base64 (which survives) instead of feeding the run an
// attachment that disappears mid-staging (EPERM).
async function staysOnDisk(path, windowMs) {
  for (let waited = 0; waited <= windowMs; waited += 5_000) {
    if (waited > 0) await sleep(5_000);
    try { if (!statSync(path).isFile()) return false; } catch { return false; }
  }
  return true;
}

async function downloadAnnexBase64(url, dir, name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${NSS_TOKEN}` }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("empty download");
    const encoded = `${name}.b64`;
    await writeFile(resolve(dir, encoded), bytes.toString("base64"));
    if (!(await staysOnDisk(resolve(dir, encoded), 10_000))) throw new Error("base64 annex also vanished");
    return encoded;
  } finally {
    clearTimeout(timer);
  }
}

// A rejected submission on a still-active attempt must not be re-derived and
// re-submitted verbatim (9442/9785 class): the value is correct per the
// artifact but the platform expects a different wrapper. Retry runs see the
// rejected value and the wrapper-variant ladder instead. Persisted on disk
// so a fresh one-shot `run` process sees it too.
function wrongSubmissionPath(attemptId) {
  return resolve(ARENA_DIR, `wrong-${attemptId}.json`);
}

function rejectedSubmissionFor(attemptId) {
  try {
    const raw = JSON.parse(readFileSync(wrongSubmissionPath(attemptId), "utf8"));
    if (Array.isArray(raw.values)) return raw.values.filter((v) => typeof v === "string");
    if (raw && typeof raw.value === "string") return [raw.value];
  } catch { /* no record for this attempt */ }
  return null;
}

// Rejections ACCUMULATE (9869: retry #2 overwrote retry #1's rejected value,
// hiding that the lowercased-wrapper form was already burned). The ladder
// needs the whole history to forbid every dead variant and rank what's left.
function recordRejectedSubmission(attemptId, value) {
  const values = [...(rejectedSubmissionFor(attemptId) ?? []), value].slice(-8);
  writeFileSync(wrongSubmissionPath(attemptId), JSON.stringify({ attemptId, values, last: value, rejectedAt: new Date().toISOString() }, null, 2));
}

// A blocked or budget-expired run leaves verified analysis behind (gadget maps,
// proven chains, exhausted sweeps) that a retry run would otherwise re-derive
// from scratch — 9822 burned a whole budget re-proving what its predecessor
// had already verified. Persist the terminal state's findings/nextSteps and
// inject them into the retry task: the next run starts at the frontier.
function handoffPath(attemptId) {
  return resolve(ARENA_DIR, `handoff-${attemptId}.json`);
}

function findingText(item) {
  if (typeof item === "string") return item.slice(0, 600);
  if (item && typeof item === "object") {
    const parts = [String(item.title ?? "").slice(0, 300)];
    const detail = item.content ?? item.detail ?? item.text ?? item.note;
    if (typeof detail === "string") parts.push(detail.slice(0, 600));
    return parts.filter(Boolean).join(": ");
  }
  return null;
}

function persistHandoff(attemptId, runId, terminal) {
  const findings = (Array.isArray(terminal?.findings) ? terminal.findings : [])
    .map(findingText).filter(Boolean).slice(0, 8);
  const nextSteps = (Array.isArray(terminal?.nextSteps) ? terminal.nextSteps : [])
    .filter((step) => typeof step === "string").map((step) => step.slice(0, 400)).slice(0, 6);
  const summary = String(terminal?.summary ?? "").slice(0, 1200);
  if (findings.length === 0 && nextSteps.length === 0 && summary === "") return;
  writeHandoff(attemptId, { attemptId, from: runId, at: new Date().toISOString(), summary, findings, nextSteps });
  console.log(`[arena] handoff persisted for attempt ${attemptId} (${findings.length} findings, ${nextSteps.length} next steps)`);
}

// Handoffs ACCUMULATE across a chain: a continuation that records nothing
// would otherwise erase its predecessor's verified findings (9855: run 1
// persisted findings, run 2 none — the overwrite threw the facts away).
// Prior entries first (they are older, verified facts), new ones appended,
// deduped, capped at the per-run limits.
function writeHandoff(attemptId, payload) {
  const prior = handoffFor(attemptId);
  const dedupe = (items) => [...new Set(items)];
  const merged = {
    ...payload,
    findings: dedupe([...(prior?.findings ?? []), ...(payload.findings ?? [])]).slice(0, 8),
    nextSteps: dedupe([...(prior?.nextSteps ?? []), ...(payload.nextSteps ?? [])]).slice(0, 6),
    summary: payload.summary?.trim() ? payload.summary : (prior?.summary ?? ""),
    handoffText: payload.handoffText ?? prior?.handoffText,
  };
  writeFileSync(handoffPath(attemptId), JSON.stringify(merged, null, 2));
}

function handoffFor(attemptId) {
  try {
    const raw = JSON.parse(readFileSync(handoffPath(attemptId), "utf8"));
    if (raw && (raw.findings?.length || raw.nextSteps?.length || raw.summary || raw.handoffText)) return raw;
  } catch { /* no handoff for this attempt */ }
  return null;
}

function buildTask(attemptId, problem, annexFiles, encodedAnnexes = [], budgetMinutes = null) {
  const lines = [];
  lines.push(`NSSCTF Arena 授权挑战(类别:${problem.type_label ?? "unknown"}${problem.rating ? `,rating≈${problem.rating}` : ""})。以下是完整题面:`);
  const rejectedList = rejectedSubmissionFor(attemptId);
  if (rejectedList && rejectedList.length > 0) {
    lines.push("");
    lines.push(`重要:本尝试已被平台判错的提交(全部,严禁再次提交其中任何一个):${rejectedList.map((v) => `"${v}"`).join("、")}。`);
    const formatStated = /NSSCTF\s*\{/.test(`${problem.content ?? ""}\n${problem.hint ?? ""}`);
    const rejected = rejectedList[rejectedList.length - 1];
    if (formatStated && /^\s*NSSCTF\{.*\}\s*$/.test(rejected)) {
      lines.push(`重要:本尝试的上一轮已提交 ${rejected} 且被平台判为错误(尝试仍存活)。该提交已经符合题面指定的 NSSCTF{} 包装,因此问题几乎必然出在内部字符串本身(拼写/标点/空格/大小写)。严禁再提交相同内部内容(无论换什么包装),也不要凭语感"修复"标点。请重新恢复内部内容:(1)优先无损通道——若文本经图像/音频/隐写层承载,直接从数据层(像素 LSB、频谱、流数据)提取字节,而非 OCR 有损识别;(2)必须 OCR 时先改善输入(定位区域裁剪、放大、二值化、多引擎/多参数),只接受多次独立识别完全一致的字节序列;(3)若歧义只落在少数几个可枚举位置(若干标点/空格/大小写决策),先列出完整变体空间并按可能性排序,用工具输出逐字符确认每个候选后按序提交——本尝试剩余可错次数有限,先计算变体总数确保可枚举完。`);
    } else {
      lines.push(`重要:本尝试已提交过上述被判错的值(尝试仍存活),严禁重新推导后原样再交任何一个。若你的推导已通过 artifact 级验证(前向重放/原二进制自身校验通过),则内容大概率正确、差异在包装/大小写变换。按以下顺序逐个生成并提交未试过的候选,每个候选必须与已判错列表逐字符不同——(0)artifact 原文逐字符原样的值(完全按解出时的原始大小写与原始包装,不做任何变换;若它与已判错值不同,这是最优先候选);(1)NSSCTF{内部内容};(2)去掉包装只交内部内容;(3)题面如有其他指定包装则用之。每交一个变体前用工具输出确认候选字符串逐字符正确,并明确对照已判错列表排除重复。特别地,若已判错值来自远程容器的环境变量或单个文件(如 env 里的 FLAG=),它可能是出题人放置的诱饵:优先穷尽远程内其他 flag 位置(/flag*、家目录、数据库内容、应用配置、其他环境变量),要求新候选来自与诱饵不同的位置;包装变体只在确实无其他 flag 来源时才消耗次数。若上一轮的验证不充分,先补齐 artifact 级验证再决定。`);
    }
  }
  lines.push("");
  const priorHandoff = handoffFor(attemptId);
  if (priorHandoff) {
    lines.push(`重要:本尝试的前一轮已完成大量分析但未得出提交(预算耗尽或受阻)。以下是前一轮的结论与遗留步骤——已验证的发现视为事实,严禁从零重做;直接从「下一步」继续,把剩余预算花在增量推进上:`);
    lines.push(`重要:这是续跑(前一轮遗留分析的延续)。严禁重新反汇编/重新下载/重新推导前一轮已验证的任何内容——前几轮失败常见原因就是把续跑窗口浪费在重做 recon 上。开局直接读上述发现与遗留步骤,第一轮工具调用就该是增量实验(直接跑下一步的 payload/命令)。`);
    if (priorHandoff.summary) lines.push(`前一轮总结:${priorHandoff.summary}`);
    for (const finding of priorHandoff.findings ?? []) lines.push(`- [已验证] ${finding}`);
    for (const step of priorHandoff.nextSteps ?? []) lines.push(`- [下一步] ${step}`);
    if (priorHandoff.handoffText) lines.push(`前一轮 handoff 原文(含未决假设,按需核实):\n${priorHandoff.handoffText}`);
    lines.push("");
  }
  lines.push(String(problem.content ?? "").trim());
  if (problem.hint) { lines.push(""); lines.push(`提示:${String(problem.hint).trim()}`); }
  lines.push("");
  const urls = Array.isArray(problem.container?.url) ? problem.container.url : [];
  if (problem.container_enabled && urls.length > 0) {
    lines.push(`远程环境(本题唯一授权测试目标,限时开放):${urls.join(", ")}(剩余约 ${Math.round((problem.container?.remaining_seconds ?? 3600) / 60)} 分钟)`);
    lines.push("平台约定:重托管题的 flag 由平台生成、只存在于远程环境内(常见 NSSCTF{uuid} 格式,拿到 shell 后 cat flag / cat /flag / env 常见可得)。flag 必须实际从远程环境读取;网络 writeup 里的历史 flag 属于原比赛环境,与本环境不同,不得采信或作为提交值。");
    if (priorHandoff) {
      // A retry on a remote problem must first re-establish that the remote is
      // still alive: instances killed mid-attempt (self-inflicted scan bursts,
      // crashes) do not self-heal (9967), and grinding a dead target burns the
      // whole window while nothing can ever be read from it.
      lines.push("重要(续跑前的存活确认):开局先对远程发一个轻量请求确认存活。若连接被拒/超时,最多再确认一次(间隔数十秒);两次都失败则远程已死且不会自愈——立即以 blocked 结束并在 summary 里写明「远程容器已死亡、无法读取 flag」,严禁把剩余预算花在反复探测、换路径绕过或寻找替代目标上。若存活,直接按遗留步骤增量推进,且继续保持低并发(远程是脆弱的单实例,高并发扫描可能直接打死它)。");
    }
  } else {
    lines.push("本题无远程容器,基于附件离线解题。提交格式规则:若题面明确指定了提交格式(如「得到的flag使用NSSCTF{}格式提交」),则取解出的 flag 的内部内容(去掉其原始包装,如 pctf{...} 只取省略号部分)放入题面指定的包装中,严禁双层嵌套大括号;若题面未指定格式,则将附件中实际解出的完整 flag(含原始包装)原样提交,不改写、不重新包装。若题面或附件引用了外部比赛或仓库,历史 writeup 的 flag 不可信(平台导入时可能重新生成),应以题面与附件的实际内容为准。");
  }
  if (annexFiles.length > 0) {
    lines.push(`附件(只读挂载):/workspace/input/arena/${attemptId}/ 下有 ${annexFiles.join(", ")}`);
    if (encodedAnnexes.length > 0) {
      lines.push(`注意:${encodedAnnexes.join(", ")} 是因宿主安全策略以 base64 编码存放的原始附件(其原始文件名即去掉 .b64 后缀);使用前先 base64 -d 解码还原,再按原始文件类型分析。`);
    }
  }
  lines.push("");
  if (typeof budgetMinutes === "number" && budgetMinutes > 0) {
    lines.push(`时间预算:本次运行约 ${budgetMinutes} 分钟(超时会被强制中止,中止前未固化的推理即丢失)。按此预算规划路径深度:优先单条最高价值主线,放弃旁支枚举;临近预算时把已验证的关键值/中间结果用 record_finding 或 scratch 文件固化,便于续跑接手。`);
  }
  lines.push("目标:解出本题 flag。flag 格式以题面或环境回显为准(常见如 NSSCTF{...}、flag{...})。注意:题面对 flag 的大小写描述(如「flag为小写/大写」)是核对提示,不是改写指令——以附件/环境中实际解出的原样值逐字符提交,严禁对解出值做大小写或拼写变换。");
  lines.push("要求:只测试本题给出的目标与附件;严格提交纪律生效——finish_task 的提交值必须来自成功工具输出且经独立验证,且提交字符串必须与验证输出中的候选逐字符一致(直接复制粘贴,严禁凭记忆重写或'纠正'拼写——leet/解码文本中的异常拼写是出题人有意为之,一字之差即判错);时间预算有限,优先高价值路径,确实无法解出时以 blocked 结束,严禁伪造 flag。");
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
  if (!attempt) {
    // Abandoning early puts the agent on a cooldown; surface the wait so the
    // caller can back off instead of dying.
    const retryAfter = Number(payload?.retry_after_seconds ?? 0);
    throw Object.assign(new Error(`next/ returned no attempt: ${JSON.stringify(payload).slice(0, 300)}`), { retryAfter });
  }
  if ((attempt.remaining_seconds ?? 3600) < minRemainingSeconds) {
    console.log(`[arena] attempt ${attempt.id} has only ${attempt.remaining_seconds}s left; abandoning and refetching`);
    await nss(`/attempt/${attempt.id}/abandon/`, { method: "POST", body: "{}" });
    payload = unwrap((await nss("/next/", { method: "POST", body: "{}" })).json);
    attempt = payload?.attempt;
    if (!attempt) {
      const retryAfter = Number(payload?.retry_after_seconds ?? 0);
      throw Object.assign(new Error(`next/ retry returned no attempt: ${JSON.stringify(payload).slice(0, 300)}`), { retryAfter });
    }
  }
  return { payload, attempt };
}

// Container URLs (and occasionally content) are provisioned asynchronously:
// keep re-reading the attempt detail until the problem is actually solvable.
// A pwn problem can ship its binary as an annex while the flag itself lives
// only in the remote container — annex presence must NOT short-circuit the
// wait when a container was promised (that mislabel cost two missed runs).
async function waitForProvision(attemptId, problem, maxWaitMs) {
  const urls = (candidate) => (Array.isArray(candidate?.container?.url) ? candidate.container.url : []);
  const material = (candidate) =>
    (candidate.content ?? "").trim() !== "" || annexUrls(candidate.annex).length > 0 || urls(candidate).length > 0;
  const ready = (candidate) => material(candidate) && !(candidate.container_enabled && urls(candidate).length === 0);
  if (ready(problem)) return problem;
  // Provisioning has been observed to lag 24+ minutes behind attempt start;
  // wait it out but keep enough of the 1h TTL for the run itself.
  const deadline = Date.now() + (maxWaitMs ?? 1_800_000);
  while (Date.now() < deadline) {
    await sleep(15_000);
    const detail = unwrap((await nss(`/attempt/${attemptId}/`)).json);
    const candidate = detail?.attempt?.problem ?? detail?.problem;
    if (candidate && ready(candidate)) {
      console.log(`[arena] provisioned after poll: urls=${JSON.stringify(candidate.container?.url ?? [])} content=${(candidate.content ?? "").length}B`);
      return candidate;
    }
    const remaining = detail?.attempt?.remaining_seconds;
    if (typeof remaining === "number" && remaining < 1_200) {
      console.warn(`[arena] only ${remaining}s left on the attempt; proceeding without a container`);
      return candidate ?? problem;
    }
    console.log(`[arena] waiting for problem provisioning (content=${(candidate?.content ?? "").length}B annex=${annexUrls(candidate?.annex).length} urls=${urls(candidate).length})...`);
  }
  // Deadline expiry is otherwise silent and reads as a provisioning success
  // in the log; the caller decides what to do with the un-materialized problem.
  console.warn(`[arena] provisioning wait expired without material (content=${(problem.content ?? "").length}B annex=${annexUrls(problem.annex).length} urls=${urls(problem).length})`);
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
  try {
    const result = await xuanshu("/v1/settings/model", {
      method: "POST",
      body: JSON.stringify({ modelId: process.env.ARENA_MODEL_ID ?? "glm-5.3", apiKey, baseUrl: process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic", reasoning: true }),
    });
    if (result.status >= 300) console.warn(`[arena] ensureModel -> ${result.status}`);
  } catch (error) {
    console.warn(`[arena] ensureModel failed (${error?.message ?? error})`);
  }
}

let lastRunCorrect = false;
let lastRunAttemptId = null;
// Set by cmdRun when the attempt's container was promised but never
// provisioned — a run on such an attempt can at best exhaust the offline
// annex; a flag that lives only remote can never be produced.
let containerAbsent = false;

async function cmdRun(options) {
  if (!NSS_TOKEN) die("NSS_AGENT_TOKEN missing in .env");
  if (!SERVER_TOKEN) die("XUANSHU_SERVER_TOKEN missing in .env");
  containerAbsent = false;

  const { payload, attempt } = await fetchAttempt(options.minRemaining);
  const attemptId = attempt.id;
  lastRunAttemptId = attemptId;
  let problem = await waitForProvision(attemptId, attempt.problem);
  const materialUrls = Array.isArray(problem.container?.url) ? problem.container.url : [];
  const hasAnnex = annexUrls(problem.annex).length > 0;
  containerAbsent = problem.container_enabled === true && materialUrls.length === 0;
  // A container challenge whose app never started (container_enabled with the
  // container record dead — create_date null, no urls for the whole wait) is
  // unsolvable from the title text alone; recycling the attempt immediately
  // beats burning a 52-minute run on nothing (9498).
  const containerNeverCame = problem.container_enabled === true && materialUrls.length === 0 && !hasAnnex;
  if (((problem.content ?? "").trim() === "" && !hasAnnex && materialUrls.length === 0) || containerNeverCame) {
    console.log(`[arena] attempt ${attemptId} ${containerNeverCame ? "promised a container that never provisioned" : "never received any problem material"}; abandoning`);
    await nss(`/attempt/${attemptId}/abandon/`, { method: "POST", body: "{}" });
    await record({ attemptId, outcome: "empty-problem-abandoned" });
    return 2;
  }
  console.log(`[arena] attempt ${attemptId} ${payload.reused ? "(reused)" : "(new)"} type=${problem.type_label} rating=${problem.rating} remaining=${attempt.remaining_seconds}s`);

  const dir = resolve(ARENA_DIR, String(attemptId));
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "problem.json"), JSON.stringify(payload, null, 2));
  const annexFiles = [];
  const encodedAnnexes = [];
  for (const url of annexUrls(problem.annex)) {
    try {
      const name = await downloadAnnex(url, dir, NSS_TOKEN);
      if (await staysOnDisk(resolve(dir, name), 15_000)) { annexFiles.push(name); continue; }
      console.warn(`[arena] annex ${name} vanished from disk (host quarantine) — storing base64`);
      const encoded = await downloadAnnexBase64(url, dir, name);
      annexFiles.push(encoded);
      encodedAnnexes.push(encoded);
    }
    catch (error) { console.warn(`[arena] annex download failed (${url}): ${error.message}`); }
  }
  if (annexFiles.length > 0) console.log(`[arena] annex saved: ${annexFiles.join(", ")}`);

  // Budget from the TTL as of RUN CREATION, not attempt fetch: provisioning
  // waits consume the clock before the run even starts, and a fetch-time
  // budget overshoots into the attempt's last minutes with no submitter.
  // A FRESH run caps at 38min (not the TTL): a 52min run on a 60min attempt
  // leaves ~7min — two consecutive budget deaths (9841, 9843) each preserved
  // a rich handoff frontier with no time left to use it. 38 + handoff leaves
  // a ~20min continuation window; since the stop route + handoff + evidence
  // tail make a mid-work stop non-lossy, the cut buys retryability. A retry
  // (handoff present) gets the full remaining budget — it starts at the
  // frontier and should run to the TTL.
  let remainingNow = attempt.remaining_seconds;
  try { remainingNow = unwrap((await nss("/current/")).json)?.attempt?.remaining_seconds ?? remainingNow; } catch { /* keep fetch-time value */ }
  const freshCapMinutes = handoffFor(attemptId) ? options.maxMinutes : Math.min(options.maxMinutes, 38);
  const runBudgetMs = Math.min(freshCapMinutes * 60_000, Math.max(remainingNow * 1000 - 120_000, 300_000));

  const task = buildTask(attemptId, problem, annexFiles, encodedAnnexes, Math.round(runBudgetMs / 60_000));
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

  const deadline = Date.now() + runBudgetMs;
  let terminal = null;
  while (Date.now() < deadline) {
    await sleep(15_000);
    let snapshot;
    try {
      snapshot = await xuanshu(`/v1/runs/${runId}`);
    } catch (error) {
      // A slow poll response must not abort the whole run watch — the run
      // itself is fine server-side; just try again on the next tick.
      console.warn(`[arena] poll ${runId} failed (${error?.message ?? error}); continuing`);
      continue;
    }
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
    // An aborted run's state findings/nextSteps are empty, but the API writes
    // handoff.md on every settle — fetch it so the retry inherits the frontier
    // instead of restarting cold (9833). The file lands a beat AFTER the stop
    // returns; retry a few times before giving up (9837 race).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const handoff = unwrap((await xuanshu(`/v1/runs/${runId}/handoff`)).json)?.handoff;
        if (typeof handoff === "string" && handoff.trim() !== "") {
          writeHandoff(attemptId, { attemptId, from: runId, at: new Date().toISOString(), handoffText: handoff.slice(0, 4000) });
          console.log(`[arena] handoff text persisted for attempt ${attemptId} (${handoff.length} chars)`);
          break;
        }
      } catch { /* not written yet — retry */ }
      await sleep(3_000);
    }
    await record({ attemptId, runId, type: problem.type_label, rating: problem.rating, outcome: "driver-timeout", note: "run stopped by driver" });
    return 2;
  }

  if (terminal.status === "completed" && terminal.submission) {
    const verdict = await submitFlag(attemptId, terminal.submission);
    lastRunCorrect = verdict?.data?.correct === true;
    if (verdict?.data?.correct === false) {
      recordRejectedSubmission(attemptId, terminal.submission);
      console.warn(`[arena] submission rejected on attempt ${attemptId}: ${terminal.submission} (retry will carry the wrapper-variant ladder)`);
    } else {
      try { rmSync(wrongSubmissionPath(attemptId), { force: true }); } catch { /* nothing to clear */ }
      try { rmSync(handoffPath(attemptId), { force: true }); } catch { /* nothing to clear */ }
    }
    await record({ attemptId, runId, type: problem.type_label, rating: problem.rating, outcome: "submitted", runStatus: terminal.status, submission: terminal.submission, verdict });
    return 0;
  }

  console.log(`[arena] run settled as ${terminal.status} without a submission; attempt left active for manual work`);
  // Persist the handoff on EVERY non-submitted settle — including blocked runs
  // that put a non-flag string in the submission field (9943: finish_task with
  // status=blocked carried "Disallow: /webinfo.md" as its submission; the old
  // !terminal.submission guard dropped two findings and forced a cold retry).
  persistHandoff(attemptId, runId, terminal);
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
    let rating;
    try {
      const detail = unwrap((await nss("/current/")).json);
      rating = detail?.agent?.rating ?? 0;
      console.log(`[loop] ${new Date().toISOString()} agent rating ${rating} / target ${target} (solved ${detail?.agent?.solved_count ?? "?"})`);
    } catch (error) {
      // Transient network failures must not kill a multi-hour marathon.
      console.warn(`[loop] agent-state fetch failed (${error?.message ?? error}); retrying in 30s`);
      await sleep(30_000);
      continue;
    }
    if (rating >= target) { console.log("[loop] target reached — stopping"); return 0; }
    if (consecutiveAbandons >= 6) {
      console.warn("[loop] six fresh problems missed in a row — stopping for review");
      return 2;
    }
    if (consecutiveAbandons >= 3) {
      // Miss streaks are as often infra weather (VM bounces, API wedges) as
      // capability gaps — breathe for 10 minutes before burning more attempts.
      console.warn("[loop] three fresh problems missed in a row — pausing 10 minutes");
      await sleep(600_000);
      consecutiveAbandons = 0;
    }
    if (!(await apiHealthy())) {
      console.warn(`[loop] ${new Date().toISOString()} xuanshu API unreachable — holding off on new attempts (fetching now only burns them); retrying in 60s`);
      await sleep(60_000);
      continue;
    }
    await ensureModel();
    lastRunCorrect = false;
    const previousAttemptId = lastRunAttemptId;
    try {
      await cmdRun(options);
    } catch (error) {
      const retryAfter = Number(error?.retryAfter ?? 0);
      if (retryAfter > 0) {
        console.warn(`[loop] arena cooldown: waiting ${retryAfter + 5}s before refetching`);
        await sleep((retryAfter + 5) * 1000);
        continue;
      }
      console.warn(`[loop] run crashed: ${error?.message ?? error}; pausing 60s`);
      await sleep(60_000);
    }
    // Misses do not carry across problems: a fresh attempt gets a full retry
    // budget of its own (the carryover made 9445's first miss read as "miss 2").
    if (lastRunAttemptId !== previousAttemptId) missesOnAttempt = 0;
    if (lastRunCorrect) { missesOnAttempt = 0; consecutiveAbandons = 0; }
    else {
      missesOnAttempt++;
      if (containerAbsent) {
        // The container stayed dead through the whole provisioning window and
        // the run finished without a submission (9783: exploit solved offline,
        // flag lives only in the missing remote). No rerun can conjure the
        // remote — recycle the attempt now instead of grinding a rescue
        // window plus a retry cycle on an unrunnable problem.
        console.warn(`[loop] container never provisioned and the run made no submission — abandoning attempt ${lastRunAttemptId}`);
        try {
          const cur = unwrap((await nss("/current/")).json);
          const at = cur?.attempt;
          if (at && at.id === lastRunAttemptId && at.state_label === "active") {
            await nss(`/attempt/${lastRunAttemptId}/abandon/`, { method: "POST", body: "{}" });
            await record({ attemptId: lastRunAttemptId, outcome: "loop-abandoned-dead-container" });
          }
        } catch (error) { console.warn(`[loop] dead-container abandon failed (${error?.message ?? error})`); }
        missesOnAttempt = 0;
        consecutiveAbandons++;
        containerAbsent = false;
        await sleep(5_000);
        continue;
      }
      console.warn(`[loop] no correct submission (miss ${missesOnAttempt} on this attempt) — opening rescue window`);
      // Rescue window: the attempt stays active (TTL, up to 20 wrong) after a
      // miss, so hold off retry/abandon and give the operator room to review
      // the failed run and salvage the points manually. Exits when the attempt
      // leaves the active state (manual solve or expiry).
      let rescueId = null;
      try { rescueId = unwrap((await nss("/current/")).json)?.attempt?.id ?? null; } catch { /* keep null */ }
      // A budget-cut run that persisted a handoff does not need the full
      // operator window: the next iteration's next/ reuse injects the handoff
      // and continues at the frontier autonomously. A REJECTION miss is the
      // same: the wrapper-variant ladder is a concrete correction path — the
      // full window would just idle until attempt expiry and the retry would
      // then be too late (9955 class). Hold the full window only when there is
      // neither a handoff nor a rejected value to act on.
      const boundedRescue = Boolean(handoffFor(lastRunAttemptId)) || Boolean(rejectedSubmissionFor(lastRunAttemptId));
      const rescueDeadline = Date.now() + 4 * 60_000;
      let pollFailures = 0;
      while (pollFailures < 5) {
        await sleep(60_000);
        try {
          const cur = unwrap((await nss("/current/")).json);
          if (cur?.attempt?.state_label !== "active") break;
          console.log(`[loop] RESCUE WINDOW open for attempt ${cur.attempt.id} (${cur.attempt.remaining_seconds}s left)`);
          if (boundedRescue && Date.now() >= rescueDeadline) {
            console.warn("[loop] bounded rescue window elapsed with a handoff present — self-retrying via next/ reuse");
            break;
          }
          pollFailures = 0;
        } catch (error) {
          pollFailures++;
          console.warn(`[loop] rescue poll failed (${error?.message ?? error}) ${pollFailures}/5`);
        }
      }
      let rescued = false;
      if (rescueId) {
        try { rescued = unwrap((await nss(`/attempt/${rescueId}/`)).json)?.attempt?.state_label === "solved"; } catch { /* not rescued */ }
      }
      if (rescued) {
        console.log("[loop] attempt solved during rescue window — continuing marathon");
        missesOnAttempt = 0;
        consecutiveAbandons = 0;
        continue;
      }
      console.warn(`[loop] rescue window closed without a solve (miss ${missesOnAttempt})`);
      let attemptRemaining = null;
      try {
        const current = unwrap((await nss("/current/")).json);
        attemptRemaining = current?.attempt?.remaining_seconds ?? null;
      } catch { /* fetched again in the abandon path if needed */ }
      // Retrying needs a real shot: a fresh run that cannot finish inside the
      // attempt TTL is guaranteed waste — abandon and take a new problem. A
      // handoff-carrying retry is a continuation, not a fresh run: the 38-min
      // fresh cut leaves ~1300s and the bounded rescue window eats 4 of those
      // minutes before the decision, so the floor must sit BELOW the
      // window-closing remaining (~1060s) with real margin (9855's reuse
      // cleared a 1050s floor by seconds).
      const retryFloor = handoffFor(lastRunAttemptId) ? 900 : 1_500;
      const tooLate = typeof attemptRemaining === "number" && attemptRemaining < retryFloor;
      if (missesOnAttempt >= 2 || tooLate) {
        try {
          const current = unwrap((await nss("/current/")).json);
          const attempt = current?.attempt;
          if (attempt && attempt.state_label === "active") {
            console.log(`[loop] abandoning attempt ${attempt.id} after repeated misses`);
            await nss(`/attempt/${attempt.id}/abandon/`, { method: "POST", body: "{}" });
            await record({ attemptId: attempt.id, outcome: "loop-abandoned" });
          }
          missesOnAttempt = 0;
          consecutiveAbandons++;
        } catch (error) {
          console.warn(`[loop] abandon path failed (${error?.message ?? error}); will retry next pass`);
        }
      }
    }
    await sleep(10_000);
  }
}

function usage() {
  console.log(`Usage:
  node tools/arena/arena.mjs current
  node tools/arena/arena.mjs next
  node tools/arena/arena.mjs run [--max-minutes 52] [--min-remaining 600]
  node tools/arena/arena.mjs loop [--target 3000] [--max-minutes 52]
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
  // Default 52min lets the TTL-based budget (remaining - 2min) bind on fresh
  // attempts; a 40min cap orphaned a live run with 19min of attempt left
  // (9436) — the attempt TTL is the real budget, this is just an outer bound.
  const options = { maxMinutes: Number(arg("max-minutes", 52)) || 52, target: Number(arg("target", 3000)) || 3000, minRemaining: Number(arg("min-remaining", 600)) || 600 };
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
      const verdict = await submitFlag(attemptId, flag);
      // Persist the verdict: an unpersisted verdict once hid a wrong-flag
      // rejection and prompted a blind duplicate submit (9436).
      await record({ attemptId: Number(attemptId) || attemptId, outcome: "manual-submit", submission: flag, verdict });
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

// Adopt an in-flight xuanshu run whose driver loop was killed: poll to
// terminal, submit its agent-derived finish_task submission to TSec, and keep
// the shared ledger/wrong-file bookkeeping consistent for parallel lanes.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ROOT = "/Users/j1k3r/Desktop/zhulongx";
if (existsSync(`${ROOT}/.env`)) {
  for (const line of readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const [, , RUN, CODE, budgetArg] = process.argv;
const BUDGET_MIN = Number(budgetArg ?? 42);
const LOG = `${ROOT}/.xuan-shu/arena/tsec-results.jsonl`;
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));
const log = (line) => { console.log(line); appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), challenge: CODE, runId: RUN, adopted: true, line })}\n`); };
const ledgerRead = () => { try { return JSON.parse(readFileSync(`${ROOT}/workspace/tsec/ledger.json`, "utf8")); } catch { return { done: {}, accepted: {} }; } };
const ledgerWrite = (l) => writeFileSync(`${ROOT}/workspace/tsec/ledger.json`, JSON.stringify(l, null, 2));

const deadline = Date.now() + BUDGET_MIN * 60_000;
let lastStatus = "";
while (Date.now() < deadline) {
  await sleep(20_000);
  let json = {};
  try {
    const r = await fetch(`http://127.0.0.1:7318/v1/runs/${RUN}`, { headers: { authorization: `Bearer ${process.env.XUANSHU_SERVER_TOKEN}` } });
    json = await r.json();
  } catch (e) { log(`poll failed: ${e.message}`); continue; }
  const status = json?.status ?? json?.state?.status;
  if (status !== lastStatus) { log(`status=${status}`); lastStatus = status; }
  if (!["completed", "blocked", "failed", "aborted"].includes(status)) continue;

  const state = json.state ?? json;
  appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), challenge: CODE, runId: RUN, adopted: true, outcome: status })}\n`);
  // Bank the run's findings/intents to the challenge blackboard so the next
  // lane pick inherits them (tsec.mjs watcher-lite equivalent for adopts).
  try {
    const boardPath = `${ROOT}/workspace/tsec/board-${CODE}.json`;
    let board; try { board = JSON.parse(readFileSync(boardPath, "utf8")); } catch { board = { facts: [], intents: [], hints: [] }; }
    const ftexts = (Array.isArray(state.findings) ? state.findings : []).map((f) => (typeof f === "string" ? f : `${f.title ?? ""}: ${f.description ?? ""}`.trim()).slice(0, 600)).filter(Boolean);
    const seen = new Set(board.facts.map((f) => f.text));
    for (const t of ftexts) if (!seen.has(t)) { board.facts.push({ at: new Date().toISOString(), text: t }); seen.add(t); }
    const itexts = (Array.isArray(state.nextSteps) ? state.nextSteps : []).filter((s) => typeof s === "string").map((s) => s.slice(0, 400));
    const iseen = new Set(board.intents.map((i) => i.text));
    for (const t of itexts) if (!iseen.has(t)) { board.intents.push({ at: new Date().toISOString(), text: t, needs: "" }); iseen.add(t); }
    board.facts = board.facts.slice(-24);
    board.intents = board.intents.filter((i) => !i.done).slice(-8);
    writeFileSync(boardPath, JSON.stringify(board, null, 2));
    log(`board updated: facts=${board.facts.length} intents=${board.intents.length}`);
  } catch (e) { log(`board bank failed: ${e.message}`); }

  if (status === "completed" && state.submission) {
    const r = await fetch(`${process.env.TSEC_BASE_URL}/openapi/v1/challenges/submit`, {
      method: "POST",
      headers: { BENCHMARK_TOKEN: process.env.TSEC_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ unique_code: CODE, flag: state.submission }),
    });
    const verdict = await r.json().catch(() => ({}));
    log(`submit: ${r.status} ${JSON.stringify(verdict)}`);
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), challenge: CODE, runId: RUN, outcome: "submitted", submission: state.submission, verdict })}\n`);
    if (verdict.correct === true) {
      const ledger = ledgerRead();
      ledger.accepted ??= {};
      ledger.accepted[CODE] = [...new Set([...(ledger.accepted[CODE] ?? []), state.submission])].slice(-6);
      const prior = ledger.done[CODE] ?? { misses: 0 };
      // multi-flag: keep "partial" until every flag is banked, else pickNext
      // strands the chain (same fix as tsec.mjs 2026-10-09)
      const fullyDone = (verdict.correct_flag_count ?? 1) >= (verdict.total_flag_count ?? 1);
      ledger.done[CODE] = { ...prior, status: fullyDone ? "solved" : "partial", progress: verdict.correct_flag_count ?? 1, misses: 0, at: new Date().toISOString() };
      ledgerWrite(ledger);
      if ((verdict.correct_flag_count ?? 1) >= (verdict.total_flag_count ?? 1)) {
        await fetch(`${process.env.TSEC_BASE_URL}/openapi/v1/challenges/close?unique_code=${CODE}`, { method: "POST", headers: { BENCHMARK_TOKEN: process.env.TSEC_TOKEN } }).catch(() => {});
        log("container closed (challenge completed)");
      }
    } else if (verdict.code !== "duplicate") {
      const wp = `${ROOT}/workspace/tsec/wrong-${CODE}.json`;
      let values = [];
      try { values = JSON.parse(readFileSync(wp, "utf8")).values ?? []; } catch { /* fresh */ }
      values = [...values, state.submission].slice(-8);
      writeFileSync(wp, JSON.stringify({ code: CODE, values, last: state.submission, rejectedAt: new Date().toISOString() }, null, 2));
      const ledger = ledgerRead();
      const prior = ledger.done[CODE] ?? { misses: 0 };
      ledger.done[CODE] = { ...prior, status: "miss", misses: (prior.misses ?? 0) + 1, at: new Date().toISOString() };
      ledgerWrite(ledger);
      log("REJECTED: wrong-value recorded; operator intervention required");
    }
  } else {
    log(`terminal without submission: ${JSON.stringify(state).slice(0, 300)}`);
  }
  // Release the dead lane's claim so pool retries are not locked out for the
  // full 55-minute staleness window.
  try { rmSync(`${ROOT}/workspace/tsec/claim-${CODE}.json`, { force: true }); } catch { /* best effort */ }
  process.exit(0);
}
log("adopt deadline hit");

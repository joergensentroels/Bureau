// Run one ARM of the attention A/B: N hunting rounds, identical spec, then report what they did.
//
// ROADMAP "Next" item 3 records two interventions as "built, tested, and UNPROVEN" and the previous attempt
// at settling it as showing "no measurable effect and two signals pointing opposite ways". The measurement
// (tools/attention.mjs) and the arm recording (runArm) now exist; this is the part that produces runs.
//
//   OPERATOR_TOKEN=... node eval/attention-ab.mjs --runs 10 --label control
//
// ---------------------------------------------------------------------------------------------------
// THE SPEC IS COPIED FROM THE LIVE SCHEDULE, not invented. The arms must differ by ONE thing — whether a
// harness note was in the register — so everything else is taken verbatim from the nightly that produced
// the baseline: same agent, same objective, same maxTurns, same autoApprove, same workspace. If any of
// those drifted, the comparison would be against runs that are not comparable, which is the quiet way an
// A/B produces a number that means nothing.
//
// `scheduleId` is deliberately NOT sent. These are not the schedule firing, and claiming otherwise would
// make them indistinguishable from the nightlies in the audit trail.
//
// ---------------------------------------------------------------------------------------------------
// THE TOKEN COMES FROM THE ENVIRONMENT AND IS NEVER READ FROM DISK. Latch's data/auth.json is the
// credential boundary's own storage; this script asks for the value instead of going and taking it, and
// never prints it. It refuses to run without one rather than falling back to reading the file, which is
// the same rule server.mjs's own credential loader follows.
//
// ---------------------------------------------------------------------------------------------------
// COSTS, so the decision to run is made with numbers rather than a shrug. Measured over the eight nightly
// hunts since 2026-08-14: $0.007-$0.036 a run, median $0.028, 3.2-4.3 minutes each. Ten runs is therefore
// roughly 40 minutes and under 30p. The runs are REAL: they read the real repository, write real audit
// rows, and consume agent memory slots. persistRun de-duplicates by objective signature before truncating
// and every run here shares one objective, so the whole arm should cost ~1 slot rather than N — but that
// is a mitigation, not an absence, and the corpus does move.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stateDir } from "../tools/state-dir.mjs";
// The PURE module, not tools/attention.mjs: that one prints a report and can process.exit at import
// time, which it duly did on the first attempt at this line.
import { classifyReads } from "../tools/read-distribution.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB = path.join(stateDir(ROOT), "data-bureau.db");

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const RUNS = Math.max(1, Number(flag("runs", 10)) || 10);
const LABEL = String(flag("label", "unlabelled"));
const PORT = Number(flag("port", process.env.BUREAU_PORT || 4173));
const WS = String(flag("ws", "4water-review-82b8"));
const TOKEN = String(process.env.OPERATOR_TOKEN || "").trim();

// Verbatim from schedule sched_urvj6_1 on 2026-08-22. Changing any of it invalidates the comparison
// against every run already in the table.
const SPEC = {
  mode: "hunt",
  agentId: "agent_92gyu_0",
  objective: "Hunt for defects in the volunteer scheduling application's core logic under src/. "
           + "Real project, real stakes: findings will be triaged by the maintainer, so only claims your check actually proves.",
  maxTurns: 12,
  autoApprove: true,
  hush: false,
};

if (!TOKEN) {
  console.error("OPERATOR_TOKEN is not set.\n");
  console.error("This script will not read Latch's data/auth.json — that file is the credential boundary's");
  console.error("own storage, and a script that helps itself to it is the thing the boundary exists to stop.");
  console.error("Supply it for one command instead:\n");
  console.error('  $env:OPERATOR_TOKEN = (Get-Content "<latch>\\data\\auth.json" -Raw | ConvertFrom-Json).operatorToken');
  console.error("  node eval/attention-ab.mjs --runs 10 --label control\n");
  process.exit(2);
}

const api = async (route, method = "GET", body = null) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: { "Authorization": `Bearer ${TOKEN}`, "x-workspace": WS, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
};

// Completion is read from the AUDIT TABLE rather than from the API, because the audit row is the durable
// record and is the same thing tools/attention.mjs will measure. A run is finished when its kind='run' row
// exists; that is written once, at the end, by the same code path that stamps the arm.
function finished(runId) {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const row = db.prepare("SELECT json FROM audit WHERE run_id = ? AND kind = 'run'").get(runId);
    if (!row) return null;
    let j = {}; try { j = JSON.parse(row.json); } catch {}
    const acts = db.prepare("SELECT json FROM audit WHERE run_id = ? AND action_type = 'read_repo' AND ok = 1").all(runId);
    const urls = acts.map((a) => { try { return JSON.parse(a.json).url || ""; } catch { return ""; } }).filter(Boolean);
    return { verdict: j.verdict || "?", cost: Number(j.costUsd) || 0, found: Number(j.met) || 0,
             arm: j.arm || null, ...classifyReads(urls) };
  } finally { db.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (v) => (v === null ? "  -" : Math.round(v * 100) + "%");

console.log(`\narm "${LABEL}": ${RUNS} run(s) against ${WS} on :${PORT}`);
console.log(`spec: ${SPEC.mode}, agent ${SPEC.agentId}, maxTurns ${SPEC.maxTurns} — copied from the live schedule\n`);

const done = [];
for (let i = 1; i <= RUNS; i++) {
  let runId;
  try { ({ runId } = await api("/api/run", "POST", SPEC)); }
  catch (e) { console.error(`  run ${i}: could not start — ${e.message}`); break; }
  process.stdout.write(`  run ${String(i).padStart(2)}/${RUNS}  ${runId}  …`);

  // A hunt takes 3-4 minutes. The ceiling is generous rather than tight: a run that overruns is a finding
  // about the run, and killing the wait early would report it as a failure of this script instead.
  const deadline = Date.now() + 20 * 60 * 1000;
  let res = null;
  while (!res && Date.now() < deadline) { await sleep(5000); res = finished(runId); }
  if (!res) { console.log(" TIMED OUT after 20 min — stopping the arm rather than mixing in a partial run"); break; }

  done.push({ runId, ...res });
  console.log(` ${res.verdict.padEnd(7)} conc ${pct(res.concentration).padStart(4)}`
            + `  searches ${String(res.searches).padStart(2)}  found ${res.found}  $${res.cost.toFixed(4)}`
            + `  arm ${res.arm ? `notes=${res.arm.harnessNotes}` : "NONE"}`);
}

if (!done.length) { console.error("\nno run completed — nothing to report."); process.exit(1); }

const conc = done.filter((r) => r.concentration !== null).map((r) => r.concentration);
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
console.log(`\narm "${LABEL}": n=${done.length}`);
console.log(`  concentration  median ${pct(median(conc))}  (${conc.map((c) => pct(c)).join(", ")})`);
console.log(`  findings       ${done.reduce((a, r) => a + r.found, 0)} confirmed across the arm`);
console.log(`  cost           $${done.reduce((a, r) => a + r.cost, 0).toFixed(4)} total`);

// Refuse to compare here. This script runs ONE arm; putting a comparison in it would invite reading a
// difference off two separate invocations without the n, which is how the previous attempt ended up with
// two signals pointing opposite ways. tools/attention.mjs groups by the recorded arm and says when n is
// too small — that is the readout.
const armed = done.filter((r) => r.arm).length;
if (armed < done.length) {
  console.log(`\n  ⚠ ${done.length - armed} run(s) recorded NO arm. That means the server is running code from`);
  console.log("    before arm recording landed, and these runs cannot be grouped. Restart Bureau and redo the arm.");
}
console.log(`\nRead it out with:  node tools/attention.mjs --ws ${WS}`);

// Where did a hunting round actually LOOK? Read-only, over the audit table.
//
// This is the measurement half of ROADMAP "Next" item 3. That entry records the review subsystem's open
// problem as attention rather than judgement — judgement was eliminated for 21 cents, the model naming the
// defect 5 times in 8 when handed the function whole — and it records two candidate interventions as
// "built, tested, and UNPROVEN". The reason they stayed unproven is that nothing computed the outcome.
//
//   node tools/attention.mjs                  # every run with repo reads, oldest first
//   node tools/attention.mjs --ws 4water      # one workspace
//   node tools/attention.mjs --limit 12
//
// Read-only: opens the database with readOnly:true, so it is safe against the live server.
//
// ---------------------------------------------------------------------------------------------------
// THE PRIMARY OUTCOME, and why it is this rather than "did it find the defect".
//
// Judgement is already ruled out as the cause, so measuring findings re-introduces exactly the variance
// that was eliminated: a round can look in the right place and still not form a claim the gate accepts.
// The thing the interventions are supposed to change is WHERE IT LOOKS, so that is what is counted.
//
// Concentration is reported over SEARCHES, not reads, because that is the failure the roadmap names: "five
// rounds spent 41 of 50 searches in one file and never opened the one holding the planted defect". A read
// visits a file once; a search is where a round chooses to keep digging.
//
// TWO MEASUREMENT TRAPS, both of which caught me by hand before this file existed:
//
//   1. A SEARCH IS A read_repo. There is no separate action type. A search is a read_repo whose `url` is
//      `<file>:<term>|<term>`, and a plain read is a bare `<file>`. Counting action types alone therefore
//      reports zero searches, and the roadmap's metric cannot be computed at all.
//
//   2. THE URL MUST BE NORMALISED TO THE FILE FIRST. Tallying raw urls treats `src/server.mjs` and
//      `src/server.mjs:signin|session` as two different files. That inflates the distinct-file count and
//      deflates concentration — measured wrongly this way, concentration looked like 4-17% and the
//      pathology looked solved. Normalised, the same runs show 24-64%, and the early runs 100%. The
//      difference between "solved" and "still a third of every round" was one `split(":")`.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stateDir } from "./state-dir.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = path.join(stateDir(ROOT), "data-bureau.db");

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : dflt; };
const wsFilter = flag("ws", "");
const limit = Math.max(1, Number(flag("limit", 40)) || 40);

let db;
try { db = new DatabaseSync(DB, { readOnly: true }); }
catch (e) { console.log(`cannot open ${DB}: ${e.message}`); process.exit(2); }

// A search is a read_repo with terms after the path. Both halves are needed: the file, for concentration,
// and the kind, because the two behave differently and averaging them hides the effect.
export function classifyReads(urls) {
  const file = (u) => String(u).split(":")[0];
  const searches = urls.filter((u) => String(u).includes(":"));
  const reads = urls.filter((u) => !String(u).includes(":"));
  const searchByFile = {};
  for (const u of searches) searchByFile[file(u)] = (searchByFile[file(u)] || 0) + 1;
  const topSearch = searches.length ? Math.max(...Object.values(searchByFile)) : 0;
  return {
    searches: searches.length,
    reads: reads.length,
    files: new Set(urls.map(file)).size,
    topSearchFile: Object.entries(searchByFile).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
    topSearchCount: topSearch,
    // The number item 3 is about. null rather than 0 when there were no searches: a round that never
    // searched has no concentration, and reporting 0% would read as perfectly spread attention.
    concentration: searches.length ? topSearch / searches.length : null,
  };
}

const where = wsFilter ? "AND ws LIKE ?" : "";
const runs = db.prepare(`SELECT run_id, ws, at, json FROM audit WHERE kind='run' ${where} ORDER BY at ASC`)
  .all(...(wsFilter ? [`%${wsFilter}%`] : []));

const rows = [];
for (const r of runs) {
  const acts = db.prepare("SELECT json FROM audit WHERE run_id = ? AND action_type = 'read_repo' AND ok = 1").all(r.run_id);
  const urls = acts.map((a) => { try { return JSON.parse(a.json).url || ""; } catch { return ""; } }).filter(Boolean);
  if (urls.length < 5) continue;   // a round that barely read anything says nothing about where it looked
  let j = {}; try { j = JSON.parse(r.json); } catch {}
  rows.push({ at: r.at, ws: r.ws, runId: r.run_id, verdict: j.verdict || "?", cost: Number(j.costUsd) || 0,
              found: Number(j.met) || 0, arm: j.arm || null, ...classifyReads(urls) });
}

if (!rows.length) {
  console.log(wsFilter ? `No runs with repo reads for a workspace matching "${wsFilter}".` : "No runs with repo reads recorded.");
  console.log("(This reads the audit table. A round that read fewer than 5 files is skipped as uninformative.)");
  process.exit(0);
}

const pct = (v) => (v === null ? "   -" : String(Math.round(v * 100)).padStart(3) + "%");
console.log(`\n${rows.length} run(s) with repo reads${wsFilter ? ` in *${wsFilter}*` : ""}, oldest first:\n`);
console.log("date        searches  reads  files  concentration  found   cost      most-searched file");
for (const r of rows.slice(-limit)) {
  console.log(new Date(r.at).toISOString().slice(0, 10)
    + String(r.searches).padStart(10) + String(r.reads).padStart(7) + String(r.files).padStart(7)
    + pct(r.concentration).padStart(15) + String(r.found).padStart(7)
    + ("  $" + r.cost.toFixed(4)).padStart(11) + "   " + r.topSearchFile);
}

// The summary is the A/B readout. Grouped by whether the workspace's harness register was non-empty at the
// time is NOT possible from the audit table — the notes live in the org blob, which carries no history — so
// the honest grouping is by date, and an experiment must record its own arms.
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// REPORTED IN TWO WINDOWS, because pooling them is not a number anybody can plan with. Per-run cost fell
// about thirtyfold on 2026-08-14 — from $0.16-$1.44 to $0.007-$0.036 — when these rounds stopped being
// paid-heavy. A median across that boundary describes neither regime, and it is the reason ROADMAP item 3
// still quoted "~$1.15 each" as the price of settling this: true of the old era, thirty times wrong now.
// The same boundary matters for concentration, since the expensive runs were also the worst-concentrated.
const summarise = (label, set) => {
  const conc = set.filter((r) => r.concentration !== null).map((r) => r.concentration);
  if (!set.length) return;
  console.log(`${label}  n=${String(set.length).padStart(2)}   concentration median ${pct(median(conc))}`
            + ` (min ${pct(Math.min(...conc))}, max ${pct(Math.max(...conc))})`
            + `   cost median $${median(set.map((r) => r.cost)).toFixed(4)}`);
};
console.log("");
summarise("ALL RUNS         ", rows);
summarise("LAST 8 (current) ", rows.slice(-8));
console.log("");
console.log("A most-searched file of `*` is a repository-wide search with no file target — the round searched");
console.log("everything rather than choosing somewhere, which concentration cannot describe either way.");
console.log("");
// ---- THE A/B READOUT, grouped by the arm the run recorded for itself ------------------------------
//
// Runs from before 2026-08-21 carry no arm, because nothing stamped one. They are reported separately and
// NOT pooled with the rest: an unlabelled run cannot be assigned to a group, and quietly dropping it into
// one is precisely how a comparison produces "two signals pointing opposite ways".
const armKey = (a) => a
  ? `scope=${a.scopeFiles} coverage=${a.coverageMap ? "on" : "off"} notes=${a.harnessNotes}`
    + ` rounds=${a.roundsCap} paid=${a.ranPaid ? "y" : "n"}`
  : null;

const labelled = rows.filter((r) => armKey(r.arm));
const unlabelled = rows.length - labelled.length;

console.log("");
if (!labelled.length) {
  console.log(`No run carries an arm yet. ${unlabelled} run(s) predate arm recording (added 2026-08-21), so they`);
  console.log("cannot be grouped — the config they ran under is not recoverable from this table. The next hunt");
  console.log("will stamp one. Until then this listing is a baseline, not a comparison.");
} else {
  const groups = new Map();
  for (const r of labelled) {
    const k = armKey(r.arm);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  console.log("BY ARM  (only runs that recorded one)");
  for (const [k, set] of [...groups.entries()].sort()) {
    const conc = set.filter((r) => r.concentration !== null).map((r) => r.concentration);
    console.log(`  ${k}`);
    console.log(`     n=${set.length}   concentration median ${conc.length ? pct(median(conc)) : "   -"}`
              + `   found ${set.reduce((a, r) => a + r.found, 0)}`
              + `   cost median $${median(set.map((r) => r.cost)).toFixed(4)}`);
  }
  // Said out loud rather than left to arithmetic on the reader: two arms of three runs each is not a
  // comparison, and the honest thing is to name the n before anyone reads a difference into it.
  const smallest = Math.min(...[...groups.values()].map((g) => g.length));
  if (groups.size < 2) { console.log(""); console.log("  ONE ARM ONLY so far — nothing to compare against yet."); }
  else if (smallest < 8) { console.log(""); console.log(`  SMALLEST ARM HAS n=${smallest}. Too few to read a difference from; at a median $${median(rows.map((r) => r.cost)).toFixed(3)} a run, more is cheap.`); }
  if (unlabelled) { console.log(""); console.log(`  ${unlabelled} older run(s) carry no arm and are excluded rather than assumed.`); }
}

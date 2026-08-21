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
              found: Number(j.met) || 0, ...classifyReads(urls) });
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
console.log("A run's arm is not recoverable from this table: the harness register lives in the org blob, which");
console.log("keeps no history, so a run cannot be told afterwards whether notes were present. An experiment has");
console.log("to record its own arms as it goes — which is the gap that left the previous A/B with \"two signals");
console.log("pointing opposite ways\" and nothing to settle them.");

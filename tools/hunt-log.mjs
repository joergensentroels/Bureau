// What did the scheduled hunts actually do?
//
// A hunt leaves NO trace in bureau.log. That file carries boots, warnings and ticks — searching it for a run
// finds nothing, and finding nothing there reads exactly like the run never happening. Runs are recorded in the
// SQLite audit table, and this reads them.
//
// That confusion is not hypothetical: the nightly hunt was believed not to be running at all, on the strength of
// a grep over the wrong file. It had been running perfectly, twice, and throwing away every finding it made.
//
//   node tools/hunt-log.mjs                     # recent hunt runs, every workspace
//   node tools/hunt-log.mjs 4water-review-82b8  # one workspace
//   node tools/hunt-log.mjs --limit 20
//
// Read-only. It opens the database with readOnly:true and never writes, so it is safe to run against the live
// server while that server is using it.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
// The same predicate the runner uses, imported rather than restated — a second copy here would drift from the
// gate's wording and quietly stop recognising the failure it exists to name. Importing server.mjs boots nothing.
import { gateNeverRan } from "../server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = path.join(ROOT, "data-bureau.db");

const args = process.argv.slice(2);
const li = args.indexOf("--limit");
const limit = li >= 0 ? Math.max(1, Number(args[li + 1]) || 10) : 10;
const ws = args.find((a) => !a.startsWith("--") && a !== String(limit)) || "";

// What each verdict means, spelled out. "ungated" is the one worth explaining every time it appears: it says the
// gate could not be built, so the run is evidence about this machine and about nothing in the code.
const MEANING = {
  found:   "findings confirmed through the gate",
  clean:   "the gate ran and nothing survived it",
  ungated: "THE GATE COULD NOT RUN — this says nothing about the code",
};

let db;
try { db = new DatabaseSync(DB, { readOnly: true }); }
catch (e) { console.log(`cannot open ${DB}: ${e.message}`); process.exit(2); }

const where = ws ? "AND ws = ?" : "";
const rows = db.prepare(
  `SELECT ws, at, run_id, json FROM audit WHERE kind = 'run' ${where} ORDER BY at DESC LIMIT ?`
).all(...(ws ? [ws, limit] : [limit]));

// When was this database last touched at all? "No new run" and "the server is not writing" are different
// facts, and the second one is the more urgent of the two.
const newest = db.prepare("SELECT MAX(at) t FROM audit").get().t || 0;

if (!rows.length) {
  console.log(ws ? `No completed runs recorded for workspace "${ws}".` : "No runs recorded at all.");
  console.log("(This reads the audit table. bureau.log never contains runs, so an empty log proves nothing.)");
  if (newest) console.log(`Newest audit row anywhere: ${new Date(newest).toISOString().slice(0, 16).replace("T", " ")}`);
  process.exit(0);
}

const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
// Minutes are the right unit for "did the run I just started write anything" and useless past a day or so —
// "36010 min ago" is a number nobody reads as five weeks.
const age = (min) => min < 90 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;

// IN-FLIGHT RUNS FIRST. The kind='run' row is written when a run ENDS, so a hunt that is still working has
// action rows and no summary — and the listing below, which selects on kind='run', cannot see it. That made
// "nothing has started" and "it is running right now" print identically, and cost three rounds of re-running
// this tool at a hunt that had never been triggered. A tool built to answer "what did the hunts do" has to be
// able to say "one is happening".
const live = db.prepare(
  `SELECT a.run_id, MAX(a.at) last, COUNT(*) n FROM audit a
    WHERE a.run_id IS NOT NULL AND a.run_id <> '' ${ws ? "AND a.ws = ?" : ""}
      AND NOT EXISTS (SELECT 1 FROM audit b WHERE b.run_id = a.run_id AND b.kind = 'run')
    GROUP BY a.run_id ORDER BY last DESC LIMIT 5`
).all(...(ws ? [ws] : []));
if (live.length) {
  console.log("IN FLIGHT — activity recorded with no completion row yet:\n");
  for (const r of live) {
    const idleMin = Math.round((Date.now() - r.last) / 60000);
    console.log(`  ${when(r.last)}  ${r.run_id}  ${r.n} action(s), last activity ${age(idleMin)} ago`);
    // A run that died leaves exactly the same trace as one still working, so this reports the age and lets the
    // reader judge rather than asserting "running" about a process it never looked at.
    if (idleMin > 30) console.log("      (quiet for a while — this may have died rather than still be working)");
  }
  console.log("");
}

console.log(`${rows.length} most recent COMPLETED run(s)${ws ? ` in ${ws}` : ""}:\n`);

let ungated = 0;
for (const r of rows) {
  let j = {}; try { j = JSON.parse(r.json); } catch {}
  const v = j.verdict || "?";
  if (v === "ungated") ungated++;
  const cost = j.costUsd ? ` · $${Number(j.costUsd).toFixed(4)}` : "";
  const tok = j.tokens ? ` · ${Number(j.tokens).toLocaleString("en-US")} tok` : "";
  console.log(`  ${when(r.at)}  ${String(v).padEnd(8)} found=${j.met ?? "?"} refused=${j.unmet ?? "?"}${tok}${cost}`);
  console.log(`      ${r.ws} · ${r.run_id || "(no run id)"}${MEANING[v] ? ` · ${MEANING[v]}` : ""}`);

  // The refusals, deduplicated. When a run is ungated these are all the same sentence, and that sentence names
  // the cause — which is the whole reason the stored error is no longer capped below its own diagnosis.
  const errs = db.prepare(
    `SELECT json FROM audit WHERE run_id = ? AND action_type = 'register_finding' AND ok = 0`
  ).all(r.run_id || "");
  const seen = new Map();
  let broken = 0;
  for (const e of errs) {
    let ej = {}; try { ej = JSON.parse(e.json); } catch {}
    const msg = String(ej.error || "").trim();
    if (!msg) continue;
    seen.set(msg, (seen.get(msg) || 0) + 1);
    if (gateNeverRan(msg) || /^could not make a worktree/.test(msg)) broken++;
  }
  for (const [msg, n] of seen) console.log(`      ↩ refused x${n}: ${msg}`);

  // The refusal count is DERIVED from the action rows, not read from the run summary. Runs recorded before the
  // ungated fix stored a hardcoded unmet:0, so trusting the summary would report "refused=0" directly above the
  // four refusals it just printed. The older prefix is matched alongside gateNeverRan for the same reason —
  // history was written under the old wording and does not get rewritten.
  if (errs.length && Number(j.unmet || 0) !== errs.length) {
    console.log(`      (summary says refused=${j.unmet ?? "?"}; ${errs.length} refusal(s) are actually recorded — `
              + `this run predates the fix that stopped hardcoding that field)`);
  }
  if (broken && v !== "ungated") {
    console.log(`      ⚠ recorded as "${v}" although ${broken} refusal(s) were the GATE FAILING, not a judgement.`);
    console.log(`        Runs from before the ungated fix say "clean" in exactly this situation.`);
  }
  console.log("");
}

if (ungated) {
  console.log(`${ungated} of these run(s) were UNGATED — the finding gate could not be built, so no finding could`);
  console.log("be confirmed regardless of what was in the code. Check that the account running Bureau can build a");
  console.log("git worktree of the target repo:  node tools/probe-doctor.mjs <repo>");
  console.log("");
}

// Said last because it is what a reader waiting on a run actually needs, and because an unchanged listing is
// the same picture whether nothing was triggered or the server stopped recording.
const ageMin = newest ? Math.round((Date.now() - newest) / 60000) : null;
if (ageMin !== null) {
  console.log(`Newest audit row anywhere: ${when(newest)} (${age(ageMin)} ago). Nothing has been recorded since,`);
  console.log("so if you are waiting on a run you just started, it has not written anything yet.");
}

// Remove workspaces left behind by test runs.
//
// The server suites — and hunt-dispatch, which brings its own Bureau — create throwaway workspaces in the LIVE
// datastore, because the tests and the running server share one data-bureau.db. One of them called its workspace
// a throwaway for weeks without ever deleting it, and 128 accumulated against 6 real ones. The leak itself is
// fixed (hunt-dispatch now deletes in its teardown, and run-all.mjs fails when a run leaves any workspace
// behind); this is for the debris that fixing it does not remove.
//
//   node tools/prune-workspaces.mjs <prefix>           # DRY RUN — lists what would go, deletes nothing
//   node tools/prune-workspaces.mjs <prefix> --apply   # actually delete
//   node tools/prune-workspaces.mjs hunt-enforcement --apply
//
// Deletes through the server's own API rather than with SQL, so the deletes cascade the way the application
// means them to — a workspace owns audit rows and embeddings, and removing the row alone would orphan both.
// It also means this cannot corrupt a database the live server has open.
//
// DELIBERATELY REFUSES, and says which and why rather than silently skipping:
//   - "default", always, whatever prefix is given
//   - any workspace holding a schedule, a trigger, a deliverable or a plan item — those are things a person set
//     up, and no test fixture creates them. The nightly hunt lives on a schedule in 4water-review-82b8, and
//     deleting that would stop the review subsystem with nothing to say why.
//
// A prefix is REQUIRED. There is no "prune everything that looks like a test", because deciding what looks like
// a test is exactly the judgement that produced the leak: the skip list in searchable-source.test.mjs matched
// directory names exactly, missed `drafts-hunt-enforcement-<hex>`, and read 400 files it had declared out of
// bounds. An operator naming the prefix is a person deciding, which is the right kind of check here.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const prefix = args.find((a) => !a.startsWith("--")) || "";
const PORT = process.env.BUREAU_PORT || 4173;
const BASE = `http://127.0.0.1:${PORT}`;

if (!prefix) {
  console.log("usage: node tools/prune-workspaces.mjs <id-prefix> [--apply]");
  console.log("       a prefix is required — this tool does not guess which workspaces are disposable.");
  process.exit(2);
}

// Resolved the way the server and the test clients resolve it: environment first, then Latch's auth.json.
// Never printed, never logged — it is the operator token, and holding it is equivalent to shell access.
function operatorToken() {
  if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  try {
    const dir = process.env.LATCH_DATA
      || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data");
    return String(JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || "");
  } catch { return ""; }
}
const TOKEN = operatorToken();
if (!TOKEN) {
  console.log("no operator token found (set OPERATOR_TOKEN, or LATCH_DATA pointing at Latch's data directory)");
  process.exit(2);
}

const api = async (method, p, ws) => {
  const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  if (ws) headers["x-workspace"] = ws;
  const r = await fetch(BASE + p, { method, headers });
  const t = await r.text();
  let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};

const list = await api("GET", "/api/workspaces");
if (list.status !== 200) {
  console.log(`GET /api/workspaces -> HTTP ${list.status}. Is Bureau running on :${PORT}?`);
  process.exit(2);
}
const all = Array.isArray(list.j) ? list.j : (list.j.workspaces || []);
console.log(`${all.length} workspace(s) on :${PORT}; prefix "${prefix}"\n`);

const doomed = [], kept = [];
for (const w of all) {
  const id = w.id || w;
  if (!String(id).startsWith(prefix)) continue;
  if (id === "default") { kept.push([id, "never deleted, whatever the prefix"]); continue; }

  const org = (await api("GET", "/api/org", id)).j || {};
  // Things a person sets up. No fixture in this repo creates any of them, so their presence is the signal that
  // a workspace is somebody's rather than a leftover.
  const held = [
    ["schedule", (org.schedules || []).length],
    ["trigger", (org.triggers || []).length],
    ["deliverable", (org.deliverables || []).length],
    ["plan item", (org.plan || []).length],
  ].filter(([, n]) => n > 0);
  if (held.length) { kept.push([id, "holds " + held.map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ")]); continue; }
  doomed.push(id);
}

for (const [id, why] of kept) console.log(`  KEEP    ${id}  — ${why}`);
if (kept.length) console.log("");
console.log(`  ${doomed.length} workspace(s) match "${prefix}" and hold nothing a person set up.`);

if (!doomed.length) process.exit(0);
if (!apply) {
  console.log("\n  DRY RUN — nothing deleted. Re-run with --apply to remove them.");
  console.log("  Take a snapshot first if you have not:  node tools/backup.mjs");
  process.exit(0);
}

let gone = 0, failed = 0;
for (const id of doomed) {
  const r = await api("DELETE", "/api/workspaces/" + id);
  if (r.status >= 200 && r.status < 300) gone++;
  else { failed++; console.log(`  ✗ ${id} -> HTTP ${r.status}`); }
}
console.log(`\n  deleted ${gone}${failed ? `, ${failed} failed` : ""}`);

// Read back rather than trusting the loop's own tally — the count that matters is what the server reports now.
const after = await api("GET", "/api/workspaces");
const left = (Array.isArray(after.j) ? after.j : (after.j.workspaces || [])).length;
console.log(`  ${left} workspace(s) remain`);
process.exit(failed ? 1 : 0);

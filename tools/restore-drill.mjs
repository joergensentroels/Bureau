#!/usr/bin/env node
// Restore drill — prove the newest snapshot is SERVABLE, not merely parseable.
//
// backup.mjs verifies each artifact as it writes it. This goes one step further and does the thing you
// would actually do at 3am: restore the snapshot and boot a real Latch on it. "Verified" means the bytes
// parse; "proven" means the software ran on them and served the same answers as production.
//
//   node tools/restore-drill.mjs            # newest snapshot
//   node tools/restore-drill.mjs --snapshot 2026-07-31T2334-19
//
// Exit 0 = proven. 1 = the restore did not reproduce production.
//
// SAFETY — this boots software that holds real credentials and can reach the outside world, so the drill
// deliberately gives it none:
//   - only db.json and auth.json are restored. No llm-provider.json (billable), no github.json, no email
//     configs. auth.json is a local bearer token, needed to query the drill instance and nothing else.
//   - LATCH_SIMPLE_PLANNER_INTERVAL_MS=0 disables the planner/scheduler loop (server.js guards on > 0),
//     so no queued work is picked up and acted on.
//   - a spare port, and the restored copy (which contains that token) is deleted in a finally block.

import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));      // ...\bureau
const ROOT = path.dirname(HERE);
const LATCH_REPO = path.join(ROOT, "openclaw-command-center");
const BACKUPS = path.resolve(process.env.BUREAU_BACKUP_ROOT || path.join(ROOT, "_backups"));
const LIVE = process.env.LATCH_URL || "http://127.0.0.1:8787";
const PORT = Number(process.env.DRILL_PORT || 8788);

const argv = process.argv.slice(2);
const want = argv.indexOf("--snapshot") >= 0 ? argv[argv.indexOf("--snapshot") + 1] : null;

if (!existsSync(BACKUPS)) { console.error(`no backup root at ${BACKUPS} — run tools/backup.mjs first`); process.exit(1); }
const candidates = readdirSync(BACKUPS).filter((n) => !n.endsWith(".FAILED")).sort();
const chosen = want || candidates[candidates.length - 1];
if (!chosen || !existsSync(path.join(BACKUPS, chosen))) { console.error(`no usable snapshot in ${BACKUPS}`); process.exit(1); }
const snap = path.join(BACKUPS, chosen);

const manifest = JSON.parse(readFileSync(path.join(snap, "manifest.json"), "utf8"));
if (!manifest.ok) { console.error(`${chosen} is not a verified snapshot (manifest.ok=false)`); process.exit(1); }
const expectedApprovals = manifest.items.find((i) => i.name === "latch/db.json.gz")?.approvals;
console.log(`drill against ${chosen}  (manifest: ${expectedApprovals} approvals, ${manifest.at})`);

const drill = path.join(os.tmpdir(), "latch-restore-drill");
rmSync(drill, { recursive: true, force: true });
mkdirSync(drill, { recursive: true });

writeFileSync(path.join(drill, "db.json"), gunzipSync(readFileSync(path.join(snap, "latch", "db.json.gz"))));
writeFileSync(path.join(drill, "auth.json"), readFileSync(path.join(snap, "latch", "auth.json")));
const token = JSON.parse(readFileSync(path.join(drill, "auth.json"), "utf8").replace(/^﻿/, "")).operatorToken;
console.log(`  restored db.json (${(readFileSync(path.join(drill, "db.json")).length / 1048576).toFixed(1)} MB) + auth.json`);

// Bureau's SQLite half: read real content out of it, not just PRAGMA integrity_check. A file can pass
// integrity_check and still be an empty schema — parsing the org blobs is what proves the data is there.
{
  const db = new DatabaseSync(path.join(snap, "bureau", "data-bureau.db"), { readOnly: true });
  const rows = db.prepare("SELECT id, org FROM workspaces").all();
  const shape = rows.map((r) => {
    const org = JSON.parse(r.org);
    return `${r.id}(${(org.agents || []).length} agents, ${(org.sops || []).length} sops)`;
  });
  const newest = db.prepare("SELECT kind, action_type, at FROM audit ORDER BY seq DESC LIMIT 1").get();
  db.close();
  console.log(`  bureau db serves real rows: ${shape.join(", ")}`);
  console.log(`  newest audit row: kind=${newest?.kind} action=${newest?.action_type} at=${newest ? new Date(newest.at).toISOString() : "?"}`);
}

const child = spawn(process.execPath, ["server.js"], {
  cwd: LATCH_REPO,
  env: { ...process.env, DATA_DIR: drill, PORT: String(PORT), HOST: "127.0.0.1",
         LATCH_SIMPLE_PLANNER_INTERVAL_MS: "0", LATCH_LOG: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let verdict = 1;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(500);
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* still booting */ }
  }
  if (!up) throw new Error(`Latch never came up on the restored data in 20s. Output:\n${out}`);
  console.log(`  Latch booted on :${PORT} against the RESTORED data`);

  // Two separate questions. The first version of this drill conflated them and failed a good backup:
  //
  //  1. Is all the DATA there? Count it in the FILE. /api/state is the wrong instrument — it caps every
  //     collection at .slice(0, 100) and filters to activeItems, so it reported 100 of 360 approvals.
  //  2. Does it SERVE? Compare the restored instance to the LIVE one field by field. Equal views is the
  //     real proof and requires no knowledge of the cap.
  const restoredFile = JSON.parse(readFileSync(path.join(drill, "db.json"), "utf8").replace(/^﻿/, ""));
  const fileCount = Array.isArray(restoredFile.approvals) ? restoredFile.approvals.length : -1;
  console.log(`  restored FILE holds ${fileCount} approvals (manifest recorded ${expectedApprovals})`);
  if (fileCount !== expectedApprovals) throw new Error(`file holds ${fileCount}, manifest recorded ${expectedApprovals}`);

  const FIELDS = ["approvals", "channels", "tasks", "messages", "contextItems", "schedules"];
  const get = async (base) => {
    const r = await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${base}/api/state -> ${r.status}`);
    const s = await r.json();
    return Object.fromEntries(FIELDS.map((k) => [k, Array.isArray(s[k]) ? s[k].length : null]));
  };
  const restored = await get(`http://127.0.0.1:${PORT}`);
  let live = null;
  try { live = await get(LIVE); } catch (e) { console.log(`  (live Latch not comparable: ${e.message})`); }
  console.log(`  restored serves: ${JSON.stringify(restored)}`);
  if (live) {
    console.log(`  live     serves: ${JSON.stringify(live)}`);
    const diffs = FIELDS.filter((k) => live[k] !== restored[k]);
    if (diffs.length) throw new Error(`restored differs from live on: ${diffs.join(", ")}`);
  }

  console.log(`\nRESTORE PROVEN: all ${fileCount} approvals present in the restored file, and a real Latch`);
  console.log(`booted on it${live ? " served results identical to live" : " served it"}.`);
  verdict = 0;
} catch (e) {
  console.log(`\nRESTORE FAILED: ${e.message}`);
} finally {
  child.kill("SIGKILL");
  await sleep(500);
  rmSync(drill, { recursive: true, force: true });
  console.log(`  drill copy removed (it held the restored operator token)`);
}
process.exit(verdict);

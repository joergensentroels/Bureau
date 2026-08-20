#!/usr/bin/env node
// Snapshot everything that cannot be rebuilt from git, and PROVE the snapshot is readable.
//
// What this protects against, honestly stated: a corrupt write, a bad migration, an accidental delete,
// a wrong answer to "are you sure". It does NOT protect against losing this disk — the snapshots live
// on it. Getting off-machine copies means deciding where the operator token and the Moonshot key are
// allowed to live, and that is the operator's call, not a default this script should quietly make.
//
// Why a separate tool rather than Latch's POST /api/backups: that endpoint copies db.json alone, into
// data/backups/ — INSIDE the directory it is backing up (31 MB of old snapshots were nesting in there),
// with no pruning, no coverage of the credentials, no Bureau database, and no verification. It is a
// "duplicate the big file" button. This is a snapshot.
//
// The central idea is the last one: a backup nobody has ever read is a hope, not a backup. Every
// artifact here is opened and parsed after being written, the results are recorded in manifest.json,
// and a snapshot that fails any check is RENAMED to *.FAILED so it can never be mistaken for a good one.
//
//   node tools/backup.mjs                 # take a snapshot, prune to --keep
//   node tools/backup.mjs --list          # what exists, and which snapshots verified
//   node tools/backup.mjs --keep 30
//   node tools/backup.mjs --root D:\somewhere
//
// Exit 0 = verified snapshot written. 1 = snapshot failed verification. 2 = refused to run (see below).

import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync,
  renameSync, rmSync, copyFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { stateDir } from "./state-dir.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // the bureau repo root
// Backups must read the state Bureau actually WRITES. Resolved through the shared helper rather than
// assumed to be the repo root: with BUREAU_STATE_DIR set, a backup rooted at HERE would find no
// database, report "not present", and pass -- a green backup of nothing, which is worse than a failure.
const STATE = stateDir(HERE);
const REPO_PARENT = path.dirname(HERE);
const LATCH_DATA = process.env.LATCH_DATA || path.join(REPO_PARENT, "openclaw-command-center", "data");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const BACKUP_ROOT = path.resolve(flag("root", process.env.BUREAU_BACKUP_ROOT || path.join(REPO_PARENT, "_backups")));
const KEEP = Math.max(1, Number(flag("keep", process.env.BUREAU_BACKUP_KEEP || 14)) || 14);
const LIST_ONLY = argv.includes("--list");

// ---------- refusals -----------------------------------------------------------
// These snapshots contain auth.json (the operator token — which is shell access on this host) and
// llm-provider.json (a real, billable API key). Two places they must therefore never be written:
// a git work tree, where one `git add -A` publishes them, and a cloud-synced folder, which copies
// them to a tenant nobody audited. Refuse rather than warn: a warning printed by a scheduled task at
// 3am is read by nobody, and by then the secrets have already left.
function gitWorkTreeAbove(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
function cloudSyncedRoot(dir) {
  const target = path.resolve(dir).toLowerCase();
  const roots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer,
                 process.env.Dropbox, path.join(os.homedir(), "Dropbox"), path.join(os.homedir(), "iCloudDrive")];
  for (const r of roots.filter(Boolean)) {
    const norm = path.resolve(r).toLowerCase();
    if (target === norm || target.startsWith(norm + path.sep)) return r;
  }
  // A renamed/extra OneDrive root ("OneDrive - Contoso") won't be in the env of a SYSTEM task, so also
  // reject the path SEGMENT. Substring matching would false-positive on "my-onedrive-notes"; segments don't.
  const seg = path.resolve(dir).split(path.sep).find((s) => /^onedrive\b/i.test(s) || /^dropbox$/i.test(s));
  return seg || null;
}

function refuse(why, detail) {
  console.error(`REFUSED: ${why}`);
  console.error(`  ${detail}`);
  console.error(`  Snapshots hold the operator token and a billable API key. Pass --root <somewhere else>.`);
  process.exit(2);
}

// ---------- helpers ------------------------------------------------------------
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

// A UTF-8 BOM is legal in the file and fatal to JSON.parse, and PowerShell's Set-Content/Out-File adds
// one by default — so config files here genuinely have them. This verifier must judge "can the server
// read it back", not "is it byte-pristine", and the servers strip the BOM (Latch has stripJsonBom).
// Being stricter than the reader would fail perfectly restorable snapshots forever.
//
// But the finding is not discarded either: the first run of this tool is what revealed that Latch's
// notificationConfig loader was the ONE config read missing that strip, silently disabling notifications.
// So a BOM is recorded in the manifest and warned about — noted, not fatal.
const bomFiles = [];
function parseJsonLoose(buf, label) {
  const text = buf.toString("utf8");
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom && label) bomFiles.push(label);
  return JSON.parse(hadBom ? text.slice(1) : text);
}
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
// Sortable, filename-safe, second resolution: 2026-07-31T2145-03. Two snapshots in the same second
// would collide, so the suffix loop below makes the directory name unique rather than overwriting.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Latch rewrites db.json in full on every mutation (54 MB, tmp-then-rename). Rename is atomic, so a
// reader sees one complete generation or the other — but "complete" is the thing to verify, not assume:
// there was a 46 MB half-written .tmp sitting in that directory from a process that died mid-write.
function readJsonStable(file, tries = 5) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const raw = readFileSync(file);
      parseJsonLoose(raw, path.basename(file));   // parsed for validation; the BUFFER is what we store
      return { raw, attempts: i + 1 };
    } catch (e) {
      last = e;
      const until = Date.now() + 300;         // deliberately blocking: this is a one-shot CLI, not a server
      while (Date.now() < until) { /* spin briefly, then re-read */ }
    }
  }
  throw new Error(`${path.basename(file)} never read as valid JSON in ${tries} tries: ${last?.message}`);
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  let files = 0;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) files += copyTree(s, d);
    else { copyFileSync(s, d); files++; }
  }
  return files;
}

// ---------- --list -------------------------------------------------------------
function readManifest(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return null; }
}
function snapshots() {
  if (!existsSync(BACKUP_ROOT)) return [];
  return readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(BACKUP_ROOT, e.name);
      const m = readManifest(dir);
      return { name: e.name, dir, ok: m?.ok === true, at: m?.at || null, bytes: dirSize(dir) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

if (LIST_ONLY) {
  const all = snapshots();
  console.log(`backup root: ${BACKUP_ROOT}`);
  if (!all.length) { console.log("  (no snapshots yet)"); process.exit(0); }
  for (const s of all) console.log(`  ${s.ok ? "VERIFIED" : "FAILED  "}  ${s.name}  ${kb(s.bytes)}`);
  const good = all.filter((s) => s.ok);
  console.log(`\n  ${good.length} verified, ${all.length - good.length} failed, ${kb(all.reduce((t, s) => t + s.bytes, 0))} total`);
  console.log(`  newest verified: ${good.length ? good[good.length - 1].name : "NONE — you have no proven backup"}`);
  process.exit(good.length ? 0 : 1);
}

// ---------- take the snapshot --------------------------------------------------
const inGit = gitWorkTreeAbove(BACKUP_ROOT);
if (inGit) refuse("backup root is inside a git work tree", `${BACKUP_ROOT} is under the repo at ${inGit}`);
const cloud = cloudSyncedRoot(BACKUP_ROOT);
if (cloud) refuse("backup root is inside a cloud-synced folder", `${BACKUP_ROOT} matches ${cloud}`);

mkdirSync(BACKUP_ROOT, { recursive: true });
let snapDir = path.join(BACKUP_ROOT, stamp());
for (let n = 2; existsSync(snapDir); n++) snapDir = path.join(BACKUP_ROOT, `${stamp()}-${n}`);
mkdirSync(path.join(snapDir, "latch"), { recursive: true });
mkdirSync(path.join(snapDir, "bureau"), { recursive: true });

const items = [];
const problems = [];
const add = (o) => { items.push(o); if (!o.verified) problems.push(`${o.name}: ${o.error || "verification failed"}`); };

console.log(`snapshot -> ${snapDir}`);

// --- Bureau's SQLite. VACUUM INTO, not a file copy: the live database is in WAL mode, so copying
// data-bureau.db alone loses the 4 MB sitting in -wal, and copying db+wal+shm separately means three
// reads at three different moments. VACUUM INTO takes one consistent read and writes a single compact,
// already-checkpointed file. busy_timeout waits out a concurrent writer instead of failing.
{
  const src = path.join(STATE, "data-bureau.db");
  const dest = path.join(snapDir, "bureau", "data-bureau.db");
  const item = { name: "bureau/data-bureau.db", verified: false };
  try {
    if (!existsSync(src)) throw new Error("not found");
    const live = new DatabaseSync(src);
    live.exec("PRAGMA busy_timeout = 15000");
    const liveWs = live.prepare("SELECT COUNT(*) n FROM workspaces").get().n;
    const liveAudit = live.prepare("SELECT COUNT(*) n FROM audit").get().n;
    live.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    live.close();

    // Verify by USING it: integrity_check, then confirm the row counts match what the live db reported.
    // Opening it is what proves it is a database rather than 25 MB of plausible-looking bytes.
    const copy = new DatabaseSync(dest, { readOnly: true });
    const integrity = copy.prepare("PRAGMA integrity_check").get();
    const ws = copy.prepare("SELECT COUNT(*) n FROM workspaces").get().n;
    const audit = copy.prepare("SELECT COUNT(*) n FROM audit").get().n;
    copy.close();
    const okIntegrity = String(Object.values(integrity)[0]).toLowerCase() === "ok";
    if (!okIntegrity) throw new Error(`integrity_check said ${JSON.stringify(integrity)}`);
    if (ws !== liveWs) throw new Error(`workspaces ${ws} != live ${liveWs}`);
    Object.assign(item, {
      verified: true, bytes: statSync(dest).size, workspaces: ws, auditRows: audit,
      // Audit rows can legitimately grow between the two reads — a run finishing mid-VACUUM. Recorded,
      // not asserted: treating a normal race as corruption would fail good backups.
      auditRowsLive: liveAudit,
    });
  } catch (e) { item.error = e.message; }
  add(item);
  console.log(`  ${item.verified ? "ok  " : "FAIL"} bureau/data-bureau.db  ${item.bytes ? kb(item.bytes) : ""} ${item.error || `(${item.workspaces} workspaces, ${item.auditRows} audit rows)`}`);
}

// --- Bureau's non-DB state: the workspace registry, plus deliverables and profiles as trees.
for (const [rel, kind] of [["data-bureau-workspaces.json", "file"], ["drafts", "tree"], ["agent-profiles", "tree"]]) {
  const src = path.join(STATE, rel);
  const item = { name: `bureau/${rel}`, verified: false };
  try {
    if (!existsSync(src)) { item.verified = true; item.skipped = "not present"; add(item); continue; }
    if (kind === "tree") {
      const n = copyTree(src, path.join(snapDir, "bureau", rel));
      Object.assign(item, { verified: true, files: n, bytes: dirSize(path.join(snapDir, "bureau", rel)) });
    } else {
      const dest = path.join(snapDir, "bureau", rel);
      copyFileSync(src, dest);
      parseJsonLoose(readFileSync(dest), rel);           // parse the COPY, not the source
      Object.assign(item, { verified: true, bytes: statSync(dest).size });
    }
  } catch (e) { item.error = e.message; }
  add(item);
  console.log(`  ${item.verified ? "ok  " : "FAIL"} bureau/${rel}  ${item.skipped ? "(absent)" : `${kb(item.bytes || 0)}${item.files ? ` ${item.files} files` : ""}`}${item.error ? ` ${item.error}` : ""}`);
}

// --- Latch's db.json: the 54 MB one. Gzipped, because 14 uncompressed generations is 750 MB of mostly
// identical JSON. Verified by gunzipping and parsing what actually landed on disk — compressing without
// reading it back would leave the one artifact everything else depends on entirely unchecked.
{
  const src = path.join(LATCH_DATA, "db.json");
  const dest = path.join(snapDir, "latch", "db.json.gz");
  const item = { name: "latch/db.json.gz", verified: false };
  try {
    const { raw, attempts } = readJsonStable(src);
    writeFileSync(dest, gzipSync(raw, { level: 6 }));
    const back = parseJsonLoose(gunzipSync(readFileSync(dest)));
    const keys = Object.keys(back);
    if (!keys.length) throw new Error("round-tripped to an empty object");
    Object.assign(item, {
      verified: true, bytes: statSync(dest).size, sourceBytes: raw.length, attempts,
      topLevelKeys: keys.length, approvals: Array.isArray(back.approvals) ? back.approvals.length : null,
      sha256: sha256(raw),
    });
  } catch (e) { item.error = e.message; }
  add(item);
  console.log(`  ${item.verified ? "ok  " : "FAIL"} latch/db.json.gz  ${item.bytes ? `${kb(item.bytes)} from ${kb(item.sourceBytes)}` : ""} ${item.error || `(${item.approvals} approvals${item.attempts > 1 ? `, ${item.attempts} read attempts` : ""})`}`);
}

// --- Latch's config files: tiny, and the ones that actually hold the credentials. Stored UNCOMPRESSED
// on purpose — the moment you need them is the moment you want to read them with Notepad.
//
// Selected by rule rather than by an allowlist, because an allowlist silently stops covering the config
// file added next month: every top-level *.json under 256 KB, minus db.json and its ad-hoc historical
// copies (db-*/db.backup-*), which are large and already superseded by this snapshot.
{
  let copied = 0, failed = 0;
  for (const e of readdirSync(LATCH_DATA, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    if (e.name === "db.json" || /^db[-.]/i.test(e.name)) continue;
    const src = path.join(LATCH_DATA, e.name);
    if (statSync(src).size > 256 * 1024) continue;
    const dest = path.join(snapDir, "latch", e.name);
    try {
      copyFileSync(src, dest);
      parseJsonLoose(readFileSync(dest), e.name);
      copied++;
    } catch (err) {
      failed++;
      problems.push(`latch/${e.name}: ${err.message}`);
    }
  }
  const item = { name: "latch/config", verified: failed === 0, files: copied, failed };
  items.push(item);
  console.log(`  ${failed === 0 ? "ok  " : "FAIL"} latch/config  ${copied} json files${failed ? `, ${failed} FAILED` : ""}`);
}

// ---------- manifest, written last -------------------------------------------
// `ok` is the conjunction of everything above, so the file cannot claim success while a line above it
// says otherwise — the exact failure mode -Verify had when it printed ALL GOOD over three warnings.
const ok = problems.length === 0;
const manifest = {
  ok, at: new Date().toISOString(), host: os.hostname(), node: process.version,
  sources: { bureau: STATE, latch: LATCH_DATA },   // where the data was READ FROM, not where the code lives
  bytes: dirSize(snapDir), items, problems,
  // Recorded because a BOM'd config is readable but has bitten this system once already: any loader
  // that forgets to strip it fails open to defaults, silently. Not a snapshot failure.
  bomFiles: [...new Set(bomFiles)],
  restore: "Latch: gunzip latch/db.json.gz -> data/db.json (stop Latch first). Bureau: copy bureau/data-bureau.db over data-bureau.db and DELETE the stale -wal and -shm beside it.",
};
writeFileSync(path.join(snapDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// A snapshot that failed a check must never look like one that passed — a directory named for today,
// full of plausible files, is worse than no backup because you would rely on it.
let finalDir = snapDir;
if (!ok) {
  finalDir = `${snapDir}.FAILED`;
  renameSync(snapDir, finalDir);
}

// ---------- prune -------------------------------------------------------------
// Keep the newest KEEP, and never delete the newest VERIFIED one even if it has aged out — the point of
// retention is to always have something known-good, not to hold exactly N directories.
{
  const all = snapshots();
  const keepNames = new Set(all.slice(-KEEP).map((s) => s.name));
  const good = all.filter((s) => s.ok);
  if (good.length) keepNames.add(good[good.length - 1].name);
  let pruned = 0, freed = 0;
  for (const s of all) {
    if (keepNames.has(s.name)) continue;
    freed += s.bytes;
    rmSync(s.dir, { recursive: true, force: true });
    pruned++;
  }
  if (pruned) console.log(`  pruned ${pruned} old snapshot${pruned === 1 ? "" : "s"} (${kb(freed)} freed, keep=${KEEP})`);
}

if (manifest.bomFiles.length) {
  console.log(`  note: UTF-8 BOM in ${manifest.bomFiles.join(", ")} — restorable, but every loader of those must stripJsonBom or it fails open to defaults`);
}
console.log(ok
  ? `VERIFIED ${path.basename(finalDir)} — ${kb(manifest.bytes)}`
  : `FAILED — kept as ${path.basename(finalDir)} for inspection:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
process.exit(ok ? 0 : 1);

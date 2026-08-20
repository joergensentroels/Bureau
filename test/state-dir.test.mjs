// Where Bureau's mutable state lives, and above all that the DEFAULT did not move.
//
// This change re-pointed ten paths -- the database, the workspace registry, per-workspace org blobs, the
// drafts and agent-profile trees, the log -- from the repo root to a STATE_DIR. The entire safety
// argument is that with BUREAU_STATE_DIR unset, STATE_DIR *is* the repo root, so every existing install
// resolves everything exactly where it did before and has nothing to migrate. If that is wrong, a live
// Bureau with seven real workspaces comes up pointing at an empty database and reports itself healthy.
// So the default is asserted first and hardest.
//
// The second thing asserted is the SPLIT, from the source itself: anything Bureau writes must hang off
// STATE_DIR, and anything it reads out of the repo (public/) must stay on HERE. That is the invariant a
// future edit breaks by accident -- adding a new writable path with the `path.join(HERE, ...)` spelling
// that every line around it uses -- and reviewing for it is exactly what a derived check is better at.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { stateDir, stateDirIsOverridden } from "../tools/state-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.error(`  FAIL  ${what}`); } };

// ---- 1. the default, which is the whole safety property --------------------------------------------
ok(stateDir(ROOT, {}) === ROOT, "UNSET: stateDir() returns the repo root unchanged — no existing install moves");
ok(stateDir(ROOT, { BUREAU_STATE_DIR: "" }) === ROOT, "EMPTY: an empty variable is the same as unset");
ok(stateDir(ROOT, { BUREAU_STATE_DIR: "   " }) === ROOT, "WHITESPACE: a blank variable is the same as unset");
ok(stateDirIsOverridden({}) === false && stateDirIsOverridden({ BUREAU_STATE_DIR: "" }) === false,
   "the boot report calls unset/empty 'not overridden'");

// ---- 2. the override ------------------------------------------------------------------------------
const abs = process.platform === "win32" ? "C:\\srv\\bureau-state" : "/srv/bureau-state";
ok(stateDir(ROOT, { BUREAU_STATE_DIR: abs }) === path.resolve(abs), "an absolute path is honoured as given");
ok(stateDir(ROOT, { BUREAU_STATE_DIR: "rel/state" }) === path.resolve("rel/state"),
   "a relative path resolves against cwd, not silently against the repo");
ok(stateDir(ROOT, { BUREAU_STATE_DIR: abs }) !== ROOT, "an override actually leaves the repo root");
ok(stateDirIsOverridden({ BUREAU_STATE_DIR: abs }) === true, "the boot report calls a set variable overridden");

// ---- 3. the split, derived from server.mjs ---------------------------------------------------------
// Reads the source rather than the running server, so it covers paths no test happens to exercise.
const src = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
const joins = (base) => [...src.matchAll(new RegExp(`path\\.join\\(${base},\\s*[\`"']([^\`"')]+)`, "g"))].map((m) => m[1]);
const onHere = new Set(joins("HERE"));
const onState = new Set(joins("STATE_DIR"));

ok(onHere.size > 0 && onState.size > 0, "the derived check found joins on BOTH bases (so the regex works)");
// public/ is code. Everything else on HERE is a bug waiting to lose data on a container recreate.
const strayOnHere = [...onHere].filter((p) => p !== "public");
ok(strayOnHere.length === 0,
   `only public/ may hang off HERE — anything Bureau WRITES belongs on STATE_DIR (stray: ${strayOnHere.join(", ")})`);
for (const name of ["data-bureau.json", "data-foreman.json", "agent-profiles", "drafts", "data-bureau-workspaces.json", "data-bureau.db"])
  ok(onState.has(name), `${name} resolves against STATE_DIR`);
// The template-literal, per-workspace variants.
ok(/path\.join\(STATE_DIR, `agent-profiles-\$\{ws\}`\)/.test(src), "per-workspace agent-profiles-<ws> follows STATE_DIR");
ok(/path\.join\(STATE_DIR, `drafts-\$\{ws\}`\)/.test(src), "per-workspace drafts-<ws> follows STATE_DIR");
ok(/path\.join\(STATE_DIR, `data-bureau-ws-\$\{w\.id\}\.json`\)/.test(src), "per-workspace org blob follows STATE_DIR");
ok(/BUREAU_LOG \|\| path\.join\(STATE_DIR, "bureau\.log"\)/.test(src), "the log falls back to STATE_DIR, not the repo root");

// The tools must resolve it the SAME way. A tool that resolves differently does not fail — it reads a
// different database and reports confidently about it.
for (const tool of ["backup.mjs", "hunt-log.mjs"]) {
  const t = readFileSync(path.join(ROOT, "tools", tool), "utf8");
  ok(/from "\.\/state-dir\.mjs"/.test(t), `tools/${tool} imports the shared resolver rather than restating it`);
  ok(!/path\.join\((?:HERE|ROOT), "data-bureau\.db"\)/.test(t), `tools/${tool} no longer hardcodes the repo root for the DB`);
}

// ---- 4. the real thing: boot Bureau and see where the database lands -------------------------------
// Ordered deliberately AFTER the unit assertions. If resolution were broken, section 1 has already
// failed and this never runs — which matters, because a broken STATE_DIR would mean this boot writing
// into the OPERATOR'S live database. The before/after check on the real file is a second guard on that.
const realDb = path.join(ROOT, "data-bureau.db");
const realBefore = existsSync(realDb) ? statSync(realDb).mtimeMs : null;
// Every state-shaped entry in the repo root, before the run. Anything appearing here afterwards is a
// path that did not follow STATE_DIR.
const rootStateEntries = () => readdirSync(ROOT).filter((e) => /^(data-bureau|data-foreman|drafts|agent-profiles)/.test(e));
const rootStateBefore = new Set(rootStateEntries());

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const tmp = mkdtempSync(path.join(os.tmpdir(), "bureau-statedir-"));
try {
  const stateHome = path.join(tmp, "state");
  const fakeLatch = path.join(tmp, "latch-data");
  mkdirSync(fakeLatch, { recursive: true });
  writeFileSync(path.join(fakeLatch, "auth.json"), JSON.stringify({ operatorToken: "op_statedir_test_token", agentToken: "" }));

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env,
           BUREAU_STATE_DIR: stateHome,     // does not exist yet: boot must create it
           BUREAU_PORT: String(port),
           BUREAU_LOG: "off",               // never write into the operator's real log
           LATCH_DATA: fakeLatch,
           OPERATOR_TOKEN: "op_statedir_test_token" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  // Wait for it to serve, then stop it.
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); up = r.ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  await new Promise((r) => child.once("close", r));

  ok(up, `Bureau booted with BUREAU_STATE_DIR pointing at a directory that did not exist${up ? "" : `\n---- output ----\n${out}`}`);
  ok(existsSync(stateHome), "boot CREATED the state directory rather than failing on a missing one");
  ok(existsSync(path.join(stateHome, "data-bureau.db")), "the database was created INSIDE the state directory");
  // NOT an assertion about data-bureau-workspaces.json. A first draft checked for it here and failed:
  // server.mjs only ever READS that file (one line, in the JSON->SQLite migration) and never writes it,
  // because workspaces live in the `workspaces` table now. The file is a legacy input, so a fresh boot
  // correctly never creates it. The expectation was wrong, not the code.
  //
  // What replaces it is stronger anyway: NOTHING state-shaped may appear in the repo root during a run
  // with the override set. That catches any path that failed to move, not just the one this test happened
  // to name.
  ok(rootStateEntries().every((e) => rootStateBefore.has(e)),
     `no new state files appeared in the repo root (new: ${rootStateEntries().filter((e) => !rootStateBefore.has(e)).join(", ")})`);
  ok(/state directory:/.test(out), "boot SAID where its state is, so a mis-set variable is visible");

  // The guard: the operator's live database must be untouched by any of this.
  const realAfter = existsSync(realDb) ? statSync(realDb).mtimeMs : null;
  ok(realBefore === realAfter, "the repo's real data-bureau.db was NOT touched by a run with the override set");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) { console.error(`state-dir: ${passed} passed, ${failed} failed`); process.exit(1); }
console.log(`state-dir: the default did not move, and the override actually relocates state - ${passed} passed, 0 failed`);

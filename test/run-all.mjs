// One-command test runner.
//   node test/run-all.mjs            # pure suites; + server suites IF a server is already up on :4174
//   node test/run-all.mjs --serve    # boots a throwaway server on a port of ITS OWN, runs pure + server suites, tears it down
//   node test/run-all.mjs --e2e      # also the live autonomy e2e (needs Latch + local model)
// Exits non-zero if any suite fails — safe to use as a pre-push / CI gate. --serve is what makes the
// server suites run with zero manual setup (they were silently skipped before, which hid a regression).
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { checkDocFigures, FIGURE_DOCS } from "./doc-figures.mjs";
import { gitSafeEnv } from "../tools/git-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
// The historic fixed port. Still the REUSE target when we are not self-hosting, and no longer what
// --serve binds — see choosePort.
export const SHARED_PORT = 4174;
let PORT = SHARED_PORT;          // real value chosen in main()
let portExplicit = false;        // did the caller name the port, or did we pick it?
const wantE2E = process.argv.includes("--e2e");
const wantServe = process.argv.includes("--serve") || process.argv.includes("--ui");
const wantUI = process.argv.includes("--ui");

// hunt-dispatch belongs here rather than in SERVER, and that is not an oversight: it brings its OWN Bureau and its own
// stub Latch on their own ports, because the shared server below talks to the real Latch and cannot be scripted. Like
// heartbeat, it spawns rather than imports — "pure" here means "needs nothing already running", not "no subprocesses".
const PURE = ["decision.test.mjs", "units.test.mjs", "scope.test.mjs", "reasoning-cap.test.mjs", "probe-doctor.test.mjs", "finding-gate.test.mjs", "net.test.mjs", "heartbeat.test.mjs", "readme-demo.test.mjs", "docs.test.mjs", "searchable-source.test.mjs", "ui.test.mjs", "action-surface.test.mjs", "hunt-scope.test.mjs", "hunt-dispatch.test.mjs", "gate-harness.test.mjs"];
const SERVER = ["api.test.mjs", "workspaces.test.mjs", "endpoints.test.mjs", "robustness.test.mjs", "mcp-floor.test.mjs", "mcp-protocol.test.mjs"];
const LIVE = ["e2e-autonomy.mjs"];

// The runner boundary. .githooks/pre-push already unsets these before it invokes anything, and every git
// spawn in the repo routes through gitSafeEnv — this is a third layer over both, covering the entry point
// neither one owns: `node test/run-all.mjs` run BY HAND from a shell that happens to carry GIT_DIR, which
// is not the hook and so gets no unset. It also holds for a child that shells out to git without going
// through a repo .mjs file, which is the one shape units.test.mjs' source-derived check cannot see.
//
// Computed per spawn, never hoisted: bootServer() writes OPERATOR_TOKEN and BUREAU_PORT into process.env
// AFTER the pure suites have run, and a snapshot taken at import time would hand the server suites an env
// with no token — every one of them would 401 and read as a real failure.
const childEnv = () => gitSafeEnv(process.env);

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      // Match the summary LINE SHAPE the suites actually print, not any line that happens to contain
      // "PASS"/"FAIL" — an assertion message reading "a FAILED run now pushes …" hijacked this and got
      // reported as the suite result. Fall back to the loose match so a suite with a different shape
      // still shows something rather than a blank.
      const lines = out.split("\n").map((l) => l.trim()).reverse();
      const summary = lines.find((l) => /^(ALL PASS|FAILURES)/.test(l))
        || lines.find((l) => /\d+ passed/.test(l))
        || lines.find((l) => /passed|PASS|FAIL/.test(l)) || "";
      // The assertion count, for the doc-figure check below. `null` — never 0 — when the summary cannot be
      // read: a readout that invents a zero is worse than one that errors, because a zero looks like an
      // answer. This document records three separate defects of exactly that shape.
      const m = summary.match(/(\d+) passed/);
      resolve({ file, code, summary, out, passed: m ? Number(m[1]) : null });
    });
  });
}

// ---- Port selection: a concurrent run must not be able to collide with this one -------------------
// Several agent sessions work in sibling git worktrees off ONE clone, and every pre-push hook runs this
// file with --serve. On a fixed port the second run found the first run's server already listening and
// reused it — see reuseDiagnosis for what that cost. Self-hosting now takes a port the OS says is free,
// so two concurrent --serve runs never meet at all. BUREAU_PORT remains an explicit override.
//
// Deliberately NOT applied when we are not self-hosting: `node test/run-all.mjs` documents "server suites
// run if a server is already up on :4174", and picking an ephemeral port there would find nothing every
// time and skip them silently — the exact regression-hiding failure --serve was added to end.
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
export async function choosePort({ env = process.env, serve = false, pick = freePort } = {}) {
  const explicit = String(env.BUREAU_PORT || "").trim();
  if (explicit) return { port: Number(explicit), explicit: true };
  if (serve) return { port: await pick(), explicit: false };
  return { port: SHARED_PORT, explicit: false };
}

async function serverUp() {
  // Probe the static shell ("/"), which is intentionally NOT token-gated — /api/* would 401 and read
  // as "down" now that the API requires the operator token. It answers "is something listening" and it
  // CANNOT answer "is it mine"; assertReusable is the half that asks the second question.
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`); return r.ok; } catch { return false; }
}

// ---- Reusing a server we did not start needs a credential that WORKS on it ------------------------
// Resolve the operator token exactly the way the server suites do — env first, then Latch's auth.json —
// because the question a probe has to answer is "will THEY get in", not "can I".
export function clientToken(env = process.env) {
  if (env.OPERATOR_TOKEN) return env.OPERATOR_TOKEN.trim();
  try {
    const dir = env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data");
    return String(JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || "");
  } catch { return ""; }
}

// One authenticated GET. /api/whoami is the cheapest token-gated route (a role echo, no side effects) and
// it reports the ROLE, which the status alone cannot — see reuseDiagnosis. Costs the foreign server one
// failed-auth count when the token is wrong, well under its AUTH_FAIL_MAX of 10.
export async function probeRole(port, token) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    let role = null;
    if (r.ok) { try { role = (await r.json()).role || null; } catch { role = null; } }
    return { status: r.status, role };
  } catch (e) { return { status: 0, role: null, error: String(e?.message || e) }; }
}

// The defect this exists for, in one sentence: bootServer() returned early on "something is listening"
// and generated its disposable OPERATOR_TOKEN only AFTER that return, so a run reusing a sibling run's
// server never learned that server's token. Measured 2026-08-15 with two runs on :4174 — api, workspaces,
// endpoints, robustness and mcp-floor all red with "status 401" and "could not create test workspace",
// plus `TypeError: Cannot read properties of undefined (reading 'length')` at workspaces.test.mjs:29.
// A port collision wearing the costume of a source regression, and it cost a real investigation.
//
// Returns null when reuse is safe, otherwise the reason it is not. Pure, so the decision can be exercised
// against every status a real server answers with rather than only the one that happened to occur.
export function reuseDiagnosis(probe, port) {
  const { status, role } = probe || {};
  if (status === 200 && role === "operator") return null;
  const head = `a server is already up on :${port} and I have no operator token for it`;
  // 200 is NOT sufficient, measured against a real server: Latch's narrower agentToken authenticates and
  // /api/whoami answers 200 with role="readonly". A status-only probe would therefore green-light a server
  // on which every mutation 403s, and the suites would fail with "could not create test workspace" —
  // the same misleading red, reached a different way.
  if (status === 200 && role === "readonly")
    return `${head} — the token I resolved is READ-ONLY on it (/api/whoami says role="readonly"), so every`
      + ` mutation would 403 and the suites would report "could not create test workspace"`;
  if (status === 200) return `${head} — /api/whoami answered 200 but named no operator role (role=${JSON.stringify(role)})`;
  if (status === 401) return `${head} — it rejected the token this run resolved (/api/whoami → 401)`;
  // The damper counts rejected credentials per address and starts refusing past 10 in 10 minutes, so a 429
  // here means the wrong token has already been sent repeatedly — a reuse decision, not a rate problem.
  if (status === 429) return `${head} — it is refusing this address outright (/api/whoami → 429, its failed-auth damper)`;
  if (status === 0) return `something answered on :${port} a moment ago but the authenticated probe could not reach it (it may be shutting down)`;
  return `${head} — /api/whoami answered ${status}`;
}

// Ends the run with a reason and exit code 2 ("could not run at all"). Throws rather than calling
// process.exit(): every call site below is downstream of a fetch, and on Windows exiting while undici's
// handles are still closing trips a libuv assertion — the trap tools/heartbeat.mjs carries a note about.
// Measured here, not inherited: the first version of assertReusable printed a perfect diagnosis and then
// died with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94` and exit 127.
// The pre-push hook blocks on any non-zero code, so the gate still held — but 127 says "command not
// found", which is the wrong story to tell someone whose push was just refused.
class Bail extends Error {}
function bail(lines) { for (const l of lines) console.error(l); throw new Bail(); }

// Called wherever we are about to USE a server we did not start. Refuses loudly instead of handing the
// suites an environment they cannot authenticate to.
async function assertReusable() {
  const why = reuseDiagnosis(await probeRole(PORT, clientToken()), PORT);
  if (!why) return;
  bail([
    `\n✗ ${why}.`,
    `  Refusing to run the server suites against it: they would 401 on every request and report`,
    `  a screenful of failing assertions, which reads exactly like a source regression.`,
    `  Fix, in order of preference:`,
    `    • node test/run-all.mjs --serve                 (self-hosts on a free port of its own — no sharing)`,
    `    • export OPERATOR_TOKEN=<the token that server was started with>`,
    `    • BUREAU_PORT=<a free port> node test/run-all.mjs --serve`,
  ]);
}

// Boot a throwaway server on PORT and wait until it answers. Returns the child (kill it when done) or
// null if a server is already up AND we can authenticate to it. Sets OPERATOR_TOKEN so both the server
// and the test clients share a token even with no Latch auth.json present (works headless / in CI).
async function bootServer() {
  if (await serverUp()) { await assertReusable(); return null; }   // vetted reuse — don't double-bind the port
  if (!process.env.OPERATOR_TOKEN) process.env.OPERATOR_TOKEN = "test_" + randomBytes(18).toString("base64url");
  for (let attempt = 1; ; attempt++) {
    process.env.BUREAU_PORT = String(PORT);
    // BUREAU_LOG=off: a throwaway server must not write into the OPERATOR'S log — server.mjs appends to
    // bureau.log next to itself and shares that directory with the live one. Set on the SERVER spawn only,
    // never in childEnv(): units.test.mjs exercises startLogTee itself and needs the variable absent.
    const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...childEnv(), BUREAU_LOG: "off" } });
    let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 400));
      if (await serverUp()) return child;
    }
    if (child.exitCode === null) { try { child.kill(); } catch {}
      bail(["test server did not come up within 20s:\n" + log]); }
    // A port the OS called free can still be taken in the moment between us releasing the probe socket and
    // the child binding it. Move to another one rather than failing a gate on a race — but only when we
    // picked the port ourselves; silently moving off a port the CALLER named would defeat the override.
    if (!portExplicit && attempt === 1 && /EADDRINUSE/.test(log)) {
      const taken = PORT; PORT = await freePort();
      console.log(`  (:${taken} was taken between picking it and binding it — retrying on :${PORT})`);
      continue;
    }
    bail(["test server exited early:\n" + log]);
  }
}

async function main() {
  const chosen = await choosePort({ serve: wantServe });
  PORT = chosen.port; portExplicit = chosen.explicit;
  // Vet a foreign server BEFORE spending two minutes on the pure suites — the same "cheapest gate first"
  // ordering the pre-push hook uses. Under --serve on a port of our own nothing is listening, so this
  // costs one refused connection. BUREAU_PORT is deliberately NOT exported into the environment yet: the
  // pure suites resolve their own ports and must keep seeing the environment they saw before.
  if (await serverUp()) await assertReusable();

  const results = [];
  console.log("── pure unit suites ──");
  for (const f of PURE) { const r = await run(f); console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${f}  ${r.summary}`); results.push(r); }

  // Where the operator's log ends before this run touches anything. Only the bytes appended AFTER this point
  // are examined below — the live server on :4173 writes to the same file the whole time, so "did the log
  // grow" cannot answer the question and "did anything from THIS run appear in it" can.
  const OPLOG = path.join(ROOT, "bureau.log");
  let logMark = null;
  try { logMark = statSync(OPLOG).size; } catch { logMark = null; }

  let child = null;
  if (wantServe) { console.log("\n(--serve) booting a throwaway server on :" + PORT + " …"); child = await bootServer(); }
  const up = await serverUp();
  // Vetted again, because the check before the pure suites is now two minutes stale and a server can have
  // appeared on this port in between. `!child` is the whole condition that matters: a server we started
  // holds the token we generated, and anything else has to prove it.
  if (up && !child) await assertReusable();
  if (up) process.env.BUREAU_PORT = String(PORT);   // the server suites read this
  console.log(`\n── server suites (${up ? `server up on :${PORT}` : "no server — skipped"}) ──`);
  if (up) { for (const f of SERVER) { const r = await run(f); console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${f}  ${r.summary}`); results.push(r); } }
  else console.log(`  skipped: ${SERVER.join(", ")}  (re-run with --serve, or start: BUREAU_PORT=${PORT} node server.mjs)`);

  console.log(`\n── live e2e ${wantE2E ? "" : "(skipped — pass --e2e to run; needs Latch + model)"} ──`);
  if (wantE2E) {
    if (up) { for (const f of LIVE) { const r = await run(f); console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${f}  ${r.summary}`); results.push(r); } }
    else console.log("  can't run --e2e: no server");
  }

  // --ui: hold the throwaway server open so the UI can be LOOKED at, on a token that exists only for this run.
  // Deliberately not a no-auth mode: an auth-bypass flag is the kind of switch that escapes into production, and a
  // disposable credential keeps the boundary enforced while making the secret worthless.
  if (wantUI && child) {
    console.log("");
    console.log("=== --ui: the throwaway server is STILL RUNNING for a browser check ===");
    console.log("  open:  http://127.0.0.1:" + PORT + "/");
    console.log("  token: " + (process.env.OPERATOR_TOKEN || "(unset)"));
    console.log("  (disposable, generated for this run, and it dies with this process)");
    console.log("  look for: Lenses renders its 8 entries; Open questions and Not checked show their empty states; no console errors after unlock.");
    console.log("  Ctrl-C when done.");
    await new Promise(() => {});   // hold until interrupted
  }
  if (child) { try { child.kill(); } catch {} }

  const failed = results.filter((r) => r.code !== 0);

  // ---- the figures claimed in the docs, against what this run just produced ------------------------
  // Here rather than in a suite because the number only exists once the suites have run, and a suite that
  // spawns this runner would spawn itself. Only what THIS invocation settled is compared: a run without
  // the server suites knows the pure totals and says so, instead of failing the full-total claim on a
  // partial count. Skipped is reported, never silently treated as checked.
  const docProblems = [];
  const pure = results.filter((r) => PURE.includes(r.file));
  const srv = results.filter((r) => SERVER.includes(r.file));
  const unreadable = results.filter((r) => r.passed === null);
  const sum = (rs) => rs.reduce((a, r) => a + r.passed, 0);
  if (unreadable.length) {
    docProblems.push(`could not read an assertion count from: ${unreadable.map((r) => r.file).join(", ")} — the doc-figure check needs every suite to report "N passed"`);
  } else if (failed.length) {
    console.log(`\n── doc figures: not checked (a suite failed, so the counts describe a broken run) ──`);
  } else {
    const observed = { "pure-assertions": sum(pure), "pure-suites": pure.length, "suites": pure.length + srv.length };
    if (up) { observed["server-assertions"] = sum(srv); observed["server-suites"] = srv.length; observed.assertions = sum(pure) + sum(srv); }
    const sources = FIGURE_DOCS.map((f) => {
      try { return { file: f, text: readFileSync(path.join(ROOT, f), "utf8") }; } catch { return { file: f, text: "" }; }
    });
    docProblems.push(...checkDocFigures(observed, sources));
    const scope = up ? "" : "  (server suites skipped — full-run figures NOT checked)";
    console.log(`\n── doc figures vs this run${scope} ──`);
    if (!docProblems.length) console.log(`  OK  ${Object.entries(observed).map(([k, v]) => `${k}=${v.toLocaleString("en-US")}`).join("  ")}`);
  }
  if (docProblems.length) {
    console.log(`\n----- DOC FIGURES ARE STALE: ${docProblems.length} problem(s) -----`);
    for (const p of docProblems) console.log("  ✗ " + p);
    console.log("  (a figure marked <!--fig:KEY--> in the docs must match what a run produces; see test/doc-figures.mjs)");
  }
  // ---- did this run write into the OPERATOR'S log? ------------------------------------------------
  // A throwaway server shares a directory with the live one, so without BUREAU_LOG=off it appends to the
  // same bureau.log. That went unnoticed for weeks and cost the auth alarm its meaning: 267 of 272 recorded
  // boots and 1,949 "rejected credential" warnings were tests. Checked behaviourally — the marker is this
  // run's own port in a boot line, which cannot appear unless a server of ours logged there.
  const logProblems = [];
  if (wantServe) {
    const marker = `127.0.0.1:${PORT}`;
    // CONTROL, asserted first and unconditionally: the detector must find the marker in text that HAS it.
    // Without this, "no contamination" is what a broken search says too, and this check would be the
    // eighth entry in this repo's own catalogue of probes that never looked.
    if (!`Bureau on http://${marker} (3 workspaces, SQLite)`.includes(marker)) {
      logProblems.push("the contamination detector cannot find its own marker — this check proves nothing");
    }
    if (logMark === null) {
      console.log("\n── operator log: no bureau.log to check (fresh checkout or CI) ──");
    } else {
      let appended = "";
      try {
        const now = statSync(OPLOG).size;
        // Rotation (LOG_MAX/LOG_KEEP) can shrink the file mid-run and invalidate the offset. Say so rather
        // than read a negative slice and report a confident nothing.
        //
        // Sliced as BYTES, not characters. statSync().size is a byte count while a utf8 string slices by
        // character, and this log is dense with ⚠ ✓ ═ — — so the byte offset lands far past the intended
        // point and the slice comes back EMPTY, i.e. "clean", for any input. That is exactly how the first
        // version of this check behaved, and its negative control is the only reason anyone found out.
        if (now < logMark) appended = null;
        else appended = readFileSync(OPLOG).subarray(logMark).toString("utf8");
      } catch { appended = null; }
      if (appended === null) {
        console.log("\n── operator log: rotated or unreadable mid-run — contamination NOT checked ──");
      } else if (appended.includes(marker)) {
        const hits = appended.split("\n").filter((l) => l.includes(marker)).length;
        logProblems.push(`this run appended ${hits} line(s) mentioning :${PORT} to the operator's bureau.log — a throwaway server is logging over the live one. Whichever process boots it must pass BUREAU_LOG=off, as bootServer() here and hunt-dispatch.test.mjs both do.`);
      } else {
        console.log(`\n── operator log: clean — this run added nothing mentioning :${PORT} ──`);
      }
    }
  }
  if (logProblems.length) {
    console.log(`\n----- OPERATOR LOG CONTAMINATED: ${logProblems.length} problem(s) -----`);
    for (const p of logProblems) console.log("  ✗ " + p);
  }

  // Print the FAILING lines, not the last 25. The suites print one line per assertion — units alone prints over
  // eight hundred — so the tail of a failing run is whatever executed last, which is almost never what went wrong.
  // This cost ten days of red CI: the workflow forwarded these 25 lines into a GitHub annotation and the annotation
  // showed twenty consecutive ticks under the heading "SUITE(S) FAILED". Anyone running it locally saw the same.
  // Falls back to the tail when no line carries a marker, because a crash or a syntax error has no ✗ to find.
  const MARK = /^\s*(?:✗|✖|not ok\b|FAIL\b|FAILURES\b|AssertionError|Error:)/;
  for (const r of failed) {
    const lines = r.out.split("\n");
    const bad = lines.filter((l) => MARK.test(l));
    const head = bad.length ? `${bad.length} failing line(s)` : "no failure marker found — last 25 lines";
    console.log(`\n----- ${r.file}: ${head} -----\n${(bad.length ? bad.slice(0, 40) : lines.slice(-25)).join("\n")}`);
  }
  const verdict = failed.length ? failed.length + " SUITE(S) FAILED ✗"
    : docProblems.length ? "ALL SUITES PASS, DOC FIGURES STALE ✗"
    : logProblems.length ? "ALL SUITES PASS, OPERATOR LOG CONTAMINATED ✗"
    : "ALL SUITES PASS ✓";
  console.log(`\n═══ ${verdict} — ran ${results.length} ═══`);
  process.exit(failed.length || docProblems.length || logProblems.length ? 1 : 0);
}

// Guarded so gate-harness.test.mjs can import the decision helpers above without running the whole gate
// inside itself. Same pattern as server.mjs's isMain block.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => {
  // A Bail has already said its piece; anything else is a genuine harness fault and keeps its stack.
  // Both set the code and RETURN — see the note on bail() for why this must not be process.exit().
  if (!(e instanceof Bail)) console.error("RUNNER ERROR:", e);
  process.exitCode = 2;
});

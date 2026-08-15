// One-command test runner.
//   node test/run-all.mjs            # pure suites; + server suites IF a server is already up on :PORT
//   node test/run-all.mjs --serve    # boots a throwaway server itself, runs pure + server suites, tears it down
//   node test/run-all.mjs --e2e      # also the live autonomy e2e (needs Latch + local model)
// Exits non-zero if any suite fails — safe to use as a pre-push / CI gate. --serve is what makes the
// server suites run with zero manual setup (they were silently skipped before, which hid a regression).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkDocFigures, FIGURE_DOCS } from "./doc-figures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PORT = process.env.BUREAU_PORT || 4174;
const wantE2E = process.argv.includes("--e2e");
const wantServe = process.argv.includes("--serve") || process.argv.includes("--ui");
const wantUI = process.argv.includes("--ui");

// hunt-dispatch belongs here rather than in SERVER, and that is not an oversight: it brings its OWN Bureau and its own
// stub Latch on their own ports, because the shared server below talks to the real Latch and cannot be scripted. Like
// heartbeat, it spawns rather than imports — "pure" here means "needs nothing already running", not "no subprocesses".
const PURE = ["decision.test.mjs", "units.test.mjs", "scope.test.mjs", "reasoning-cap.test.mjs", "probe-doctor.test.mjs", "finding-gate.test.mjs", "net.test.mjs", "heartbeat.test.mjs", "readme-demo.test.mjs", "docs.test.mjs", "ui.test.mjs", "action-surface.test.mjs", "hunt-scope.test.mjs", "hunt-dispatch.test.mjs"];
const SERVER = ["api.test.mjs", "workspaces.test.mjs", "endpoints.test.mjs", "robustness.test.mjs", "mcp-floor.test.mjs", "mcp-protocol.test.mjs"];
const LIVE = ["e2e-autonomy.mjs"];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
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

async function serverUp() {
  // Probe the static shell ("/"), which is intentionally NOT token-gated — /api/* would 401 and read
  // as "down" now that the API requires the operator token.
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`); return r.ok; } catch { return false; }
}

// Boot a throwaway server on PORT and wait until it answers. Returns the child (kill it when done) or
// null if a server is already up. Sets OPERATOR_TOKEN so both the server and the test clients share a
// token even with no Latch auth.json present (works headless / in CI).
async function bootServer() {
  if (await serverUp()) return null;   // already running — reuse it, don't double-bind the port
  if (!process.env.OPERATOR_TOKEN) process.env.OPERATOR_TOKEN = "test_" + randomBytes(18).toString("base64url");
  process.env.BUREAU_PORT = String(PORT);
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await serverUp()) return child;
    if (child.exitCode !== null) { console.error("test server exited early:\n" + log); process.exit(2); }
  }
  try { child.kill(); } catch {}
  console.error("test server did not come up within 20s:\n" + log);
  process.exit(2);
}

(async () => {
  const results = [];
  console.log("── pure unit suites ──");
  for (const f of PURE) { const r = await run(f); console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${f}  ${r.summary}`); results.push(r); }

  let child = null;
  if (wantServe) { console.log("\n(--serve) booting a throwaway server on :" + PORT + " …"); child = await bootServer(); }
  const up = await serverUp();
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
    : "ALL SUITES PASS ✓";
  console.log(`\n═══ ${verdict} — ran ${results.length} ═══`);
  process.exit(failed.length || docProblems.length ? 1 : 0);
})();

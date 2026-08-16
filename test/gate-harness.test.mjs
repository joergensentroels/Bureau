// The GATE'S OWN harness, under test — run-all.mjs's port choice and its decision to reuse a server it
// did not start.  run:  node test/gate-harness.test.mjs
//
// Why this suite exists. Several agent sessions work in sibling git worktrees off one clone, and every
// pre-push hook runs `node test/run-all.mjs --serve` — so two gate runs overlap routinely. On the fixed
// port they shared, run B found run A's throwaway server already listening and reused it, while A's
// disposable OPERATOR_TOKEN was generated one line AFTER the early return that decided to reuse. B never
// learned it. Measured 2026-08-15: api, workspaces, endpoints, robustness and mcp-floor all red with
// "status 401" and "could not create test workspace", plus a HARNESS ERROR TypeError at
// workspaces.test.mjs:29. Every symptom pointed at the source; the cause was the port.
//
// Pure by this repo's definition — "needs nothing already running", not "no subprocesses". It boots one
// Bureau of its own on a free port, exactly as hunt-dispatch does, and points it at a closed Latch.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { reuseDiagnosis, choosePort, probeRole, freePort, SHARED_PORT } from "./run-all.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---- 1. reuseDiagnosis: null means "reuse is safe", a string means "and here is why not" -----------
// Exercised against every status a real server answers with, rather than only the 401 that happened to
// occur, because the next collision will not necessarily arrive the same way.
{
  ok(reuseDiagnosis({ status: 200, role: "operator" }, 4174) === null, "an operator role on the running server is the ONE case that permits reuse");

  const d401 = reuseDiagnosis({ status: 401, role: null }, 4174);
  ok(typeof d401 === "string" && d401.length > 0, "a rejected token refuses reuse instead of proceeding (THE defect: the early return never learned the other run's token)");
  ok(/:4174/.test(d401 || ""), "…and the refusal names the port, so the collision is legible without reading this file");
  ok(/no operator token/i.test(d401 || ""), "…and says what is missing, rather than surfacing as 401s inside six unrelated suites");

  // 200 is NOT sufficient, and this is measured rather than assumed: probed against a real server, Latch's
  // narrower agentToken authenticates and /api/whoami answers 200 with role="readonly". A status-only probe
  // would green-light a server on which every mutation 403s — the same misleading red by a different route.
  const dRO = reuseDiagnosis({ status: 200, role: "readonly" }, 4174);
  ok(typeof dRO === "string", "a READ-ONLY token is refused although the probe returned 200");
  ok(/403|read-only/i.test(dRO || ""), "…and the refusal says why 200 was not good enough");

  // Past 10 rejected credentials in 10 minutes the server refuses the address outright. Reaching that means
  // the wrong token has been sent repeatedly — a reuse problem, not a rate problem.
  ok(/damper|429/i.test(reuseDiagnosis({ status: 429, role: null }, 4174) || ""), "a damped address refuses reuse and names the damper");
  ok(typeof reuseDiagnosis({ status: 0, role: null }, 4174) === "string", "an unreachable authenticated probe refuses reuse (something answered '/' a moment ago)");
  ok(typeof reuseDiagnosis({ status: 500, role: null }, 4174) === "string", "an unexpected status refuses reuse — the permit is an allowlist of one, not a denylist");
  ok(typeof reuseDiagnosis(undefined, 4174) === "string", "a missing probe result refuses reuse rather than throwing");
}

// ---- 2. choosePort: --serve never shares, the bare command still finds a running server -------------
{
  const pick = async () => 55555;   // injected, so the assertion is about the POLICY and not about the OS
  const serve = await choosePort({ env: {}, serve: true, pick });
  ok(serve.port === 55555 && serve.explicit === false, "--serve with no BUREAU_PORT takes a port of its own");
  ok(serve.port !== SHARED_PORT, "…which is NOT the shared default, so two concurrent --serve runs cannot meet");

  const named = await choosePort({ env: { BUREAU_PORT: "4321" }, serve: true, pick });
  ok(named.port === 4321 && named.explicit === true, "an explicit BUREAU_PORT still wins under --serve (it stays an override)");

  // The bare command documents "server suites run IF a server is already up on :4174". An ephemeral port
  // here would find nothing every time and skip them in silence — the regression-hiding failure --serve
  // was added to end — so the default is deliberately unchanged on this path.
  const bare = await choosePort({ env: {}, serve: false, pick });
  ok(bare.port === SHARED_PORT && bare.explicit === false, "without --serve the reuse target is still the shared default port");
  ok((await choosePort({ env: { BUREAU_PORT: "" }, serve: false, pick })).port === SHARED_PORT, "an empty BUREAU_PORT counts as unset, not as port 0");

  const p = await freePort();
  ok(Number.isInteger(p) && p > 0 && p < 65536, `freePort returns a real port (${p})`);
  ok(await bindable(p), "…and the port it returns is actually free to bind");
}

function bindable(port) {
  return new Promise((r) => {
    const s = createServer();
    s.once("error", () => r(false));
    s.listen(port, "127.0.0.1", () => s.close(() => r(true)));
  });
}

// ---- 3. against a REAL server: the probe, and the suite-level diagnosis it backstops ----------------
const TOKEN = "gate_harness_operator_token";
const READ_TOKEN = "gate_harness_readonly_token";
// Deliberately NOT freePort(): a suite must not boot its fixture through the helper it is testing. With
// them shared, any mutation that breaks freePort also kills the server boot, and the freePort assertions
// above go silent instead of red — a control that cannot fire on the thing it names.
const PORT = await new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  cwd: ROOT,
  // Latch pointed at a closed port: nothing here needs it, and the pre-push/CI set must be hermetic.
  // A read-only token is configured because the 200-is-not-enough case is only real if it is reachable.
  env: { ...process.env, BUREAU_PORT: String(PORT), OPERATOR_TOKEN: TOKEN, BUREAU_READ_TOKEN: READ_TOKEN, LATCH_URL: "http://127.0.0.1:1", BUREAU_LOG: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

// Throws rather than exiting on a boot failure: process.exit() would skip the finally that kills the
// server — leaving an orphaned Bureau on an ephemeral port — and, immediately after a fetch on Windows, it
// trips the libuv assertion that tools/heartbeat.mjs documents and returns 127 instead of the code meant.
let harnessError = null;
try {
  const deadline = Date.now() + 25000;
  let up = false;
  while (Date.now() < deadline && server.exitCode === null && !up) {
    await new Promise((r) => setTimeout(r, 300));
    try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { /* not yet */ }
  }
  if (!up) throw new Error(`could not boot a test server on :${PORT}:\n${serverLog}`);

  // The probe end to end: right route, right header shape, right reading of the reply. The unit half above
  // cannot catch a probe that asks the wrong question — /api/whoami is token-gated, whereas "/" is not and
  // is why serverUp() alone could never tell "mine" from "someone else's".
  const mine = await probeRole(PORT, TOKEN);
  ok(mine.status === 200 && mine.role === "operator", `the operator token probes as operator (got ${mine.status}/${mine.role})`);
  ok(reuseDiagnosis(mine, PORT) === null, "…so this server would be reused");

  const foreign = await probeRole(PORT, "not-this-servers-token");
  ok(foreign.status === 401, `a foreign token probes as 401 (got ${foreign.status})`);
  // Deliberately not `typeof … === "string"`. That weaker form passed even when the probe was pointed back
  // at the ungated "/" — the reply is HTML, role comes out null, and the "no operator role" branch returns
  // a string for the wrong reason. An assertion a broken probe can satisfy is the failure mode this repo
  // keeps re-learning, so it pins the reason the server actually gave.
  ok(/rejected the token/i.test(reuseDiagnosis(foreign, PORT) || ""), "…so this server would NOT be reused, and for the reason the server actually gave — which is the whole fix");

  // And the backstop, driven the way the collision actually drove it: workspaces.test.mjs pointed at a
  // server whose token it does not hold. It used to die with `TypeError: Cannot read properties of
  // undefined (reading 'length')` at line 29 — a stack trace naming the line that tripped and nothing
  // about the cause. It must now name the cause. (The positive half of this control runs on every gate
  // invocation: run-all's SERVER phase runs this same suite against a server it CAN authenticate to, so a
  // preflight that fired unconditionally would turn the gate red rather than pass unnoticed.)
  const wsOut = await runSuite("workspaces.test.mjs", { BUREAU_PORT: String(PORT), OPERATOR_TOKEN: "not-this-servers-token" });
  // Exit code and text are asserted TOGETHER on purpose. The code alone does not discriminate: removing the
  // preflight puts the TypeError back, and that lands in the same catch and also exits 2. An assertion whose
  // control leaves it green is not measuring the thing it is named after.
  ok(wsOut.code === 2 && /cannot run against/.test(wsOut.out), `workspaces.test.mjs refuses to run against a server it cannot authenticate to, and says so (exit ${wsOut.code})`);
  ok(!/TypeError/.test(wsOut.out), "…and no longer dies with a TypeError that reads as a source regression");
  ok(/answered 401/.test(wsOut.out), "…names the status the server actually gave");
  ok(/OPERATOR_TOKEN/.test(wsOut.out), "…names which credential it tried");
  ok(/--serve/.test(wsOut.out), "…and says what to do about it");

  // The read-only case, driven for real rather than argued about. A narrower token PASSES the preflight —
  // GET /api/org is a read and answers 200 with a company — and then fails at the first write. Without a
  // guard there, `a.id` is undefined, which sends NO x-workspace header, which silently points every
  // remaining assertion at the DEFAULT company: a dozen unrelated-looking failures against real data.
  const roOut = await runSuite("workspaces.test.mjs", { BUREAU_PORT: String(PORT), OPERATOR_TOKEN: READ_TOKEN });
  ok(/default baseline:/.test(roOut.out), "a read-only token gets PAST the preflight — proving the preflight keys on the read succeeding, not on the token being wrong");
  ok(roOut.code === 2 && /returned no id/.test(roOut.out), `…and is then stopped at the first write, by id rather than by 403 count (exit ${roOut.code})`);
  ok(!/two workspaces created/.test(roOut.out), "…before any assertion could be reported against the default company");
} catch (e) {
  harnessError = e;
} finally {
  try { server.kill(); } catch { /* already gone */ }
}

function runSuite(file, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
}

// Exit code 2 = "could not run at all", distinct from 1 = "ran and something failed". Never a bare
// summary on that path: a harness that died after eight green assertions must not print a line that looks
// like a verdict.
if (harnessError) console.error("HARNESS ERROR:", harnessError);
else {
  console.log(`\n${fail.length ? "FAILURES ✗" : "ALL PASS ✓"} — ${pass.length} passed, ${fail.length} failed`);
  pass.forEach((m) => console.log("  ✓ " + m));
  fail.forEach((m) => console.log("  ✗ " + m));
}
// process.exit() HERE, and process.exitCode on the bail paths in run-all.mjs and workspaces.test.mjs.
// Both directions were measured, and the rule is about WHEN, not which is generally safer:
//   • exiting within a tick or two of a fetch trips libuv's `!(handle->flags & UV_HANDLE_CLOSING)` on
//     Windows and returns 127 or 3221226505 rather than the code meant — so those paths set and return;
//   • setting exitCode at the END of a suite leaves termination at the mercy of the event loop, and a
//     leaked handle then hangs forever. Measured here: a control that mutated freePort to skip
//     `s.close()` left a listening socket, this file never exited, run-all's run() waits on child close
//     with no timeout, and a 10-minute cap was the only thing that ended it. A suite that hangs the gate
//     is worse than one with a wrong code, and by this point the last fetch is two subprocess lifetimes
//     ago, which is why the trap above does not reach here.
process.exit(harnessError ? 2 : (fail.length ? 1 : 0));

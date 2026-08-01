// tools/heartbeat.mjs -- the dead-man's switch. Verified against a LOCAL SINK, never a real watcher:
// pointing a test at the production ping URL would mark the machine healthy on evidence the test
// invented, which is the one lie this whole mechanism exists to prevent.
//
// The healthy path needs a live Bureau + Ollama, so it reports SKIP (not FAIL) when they are absent --
// a suite that reddens because a server is not running trains people to ignore it. The four failure
// paths need nothing live and always run, which is why this file is worth having in the pre-push set:
// the exit-code contract is what the scheduled task reads, and it broke once already.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const received = [];

const sink = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ path: req.url, method: req.method, body });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("OK");
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const PORT = sink.address().port;
const SINK = `http://127.0.0.1:${PORT}/ping-test`;

const run = (env) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ["tools/heartbeat.mjs"], {
      cwd: ROOT,
      env: { ...process.env, HEALTHCHECK_URL: SINK, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out: out.trim() }));
  });

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};

// The healthy path is OPT-IN (`HEARTBEAT_LIVE=1`) rather than auto-detected, and the reason is specific:
// under `run-all --serve` the throwaway server on :4174 generates its OWN operator token, while the
// heartbeat resolves one from Latch's auth.json. Auto-detecting "a server is up" would therefore assert
// the healthy path against a server whose token it cannot hold, and fail for a purely environmental
// reason -- the shape of red that teaches people to stop reading the suite.
//
// The operator-facing proof of the healthy path is `.\Install-Heartbeat.ps1 -Verify`, which runs it
// against the real Bureau, the real Ollama and the real watcher. That is the check that matters, and it
// cannot be faked from here. What this file locks down is the EXIT-CODE CONTRACT the scheduled task
// reads -- which is what actually broke.
if (process.env.HEARTBEAT_LIVE === "1") {
  received.length = 0;
  const r = await run({});
  if (r.code === 2) {
    // Reached the sink but something upstream is misconfigured (no token, no model) -- report it rather
    // than asserting a green we did not earn.
    skip++; console.log(`  skip  healthy path -- heartbeat could not report: ${r.out}`);
  } else {
    ok("healthy: exit 0", r.code === 0, `got ${r.code} :: ${r.out}`);
    ok("healthy: exactly one report", received.length === 1, `got ${received.length}`);
    ok("healthy: pinged success url, not /fail", received[0] && !received[0].path.endsWith("/fail"), received[0]?.path);
    ok("healthy: body names the model", /model=\S+/.test(received[0]?.body || ""), received[0]?.body);
  }
} else {
  skip++; console.log(`  skip  healthy path -- set HEARTBEAT_LIVE=1 (or use Install-Heartbeat.ps1 -Verify)`);
}

// --- Bureau down ------------------------------------------------------------
received.length = 0;
let r = await run({ BUREAU_URL: "http://127.0.0.1:9" });
ok("bureau down: exit 1", r.code === 1, `got ${r.code} :: ${r.out}`);
ok("bureau down: posted to /fail", !!received[0]?.path.endsWith("/fail"), received[0]?.path);
ok("bureau down: carries the reason, not just a status", /unreachable|timeout|ECONN/i.test(received[0]?.body || ""), received[0]?.body);

// --- model dead behind an open port (the trap this tool exists for) ---------
//
// BUREAU_URL is stubbed, not left at its default. Overriding only OLLAMA_URL made this scenario talk to
// whatever real Bureau happened to be on :4173 — which passes on the author's machine and fails
// everywhere else: a fresh clone has no resolvable operator token, so /api/health answers 401 and the
// reported reason becomes "bureau auth rejected" instead of naming the model. Caught by cloning the repo
// into a temp directory and running the suite as a stranger would.
//
// The irony is the point: the comment above explains that the HEALTHY path is opt-in precisely so the
// suite never reddens for environmental reasons, and then the scenario below depended on the environment
// anyway. Care applied to one path, not to its neighbour.
//
// Stubbing Bureau also sharpens the test: the only dead thing is now the model, which is what the
// scenario claims to be about.
const bureauStub = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, model: "stub-model:test" }));
});
await new Promise((r2) => bureauStub.listen(0, "127.0.0.1", r2));
const BUREAU_STUB = `http://127.0.0.1:${bureauStub.address().port}`;

received.length = 0;
// The sink answers 200 with "OK" to everything, so /api/generate returns a body with no token —
// exactly the "port is open, model is dead" shape this tool exists to catch.
r = await run({ BUREAU_URL: BUREAU_STUB, OLLAMA_URL: `http://127.0.0.1:${PORT}` });
ok("model dead: exit 1 even though the port answered 200", r.code === 1, `got ${r.code} :: ${r.out}`);
const failed = received.find((x) => x.path.endsWith("/fail"));
ok("model dead: posted to /fail", !!failed, JSON.stringify(received.map((x) => x.path)));
ok("model dead: reason mentions generate", /generate|no token/i.test(failed?.body || ""), failed?.body);
bureauStub.close();

// --- watcher unreachable ---------------------------------------------------
r = await run({ HEALTHCHECK_URL: "http://127.0.0.1:9/ping" });
ok("watcher down: exit 2, never a false 0", r.code === 2, `got ${r.code} :: ${r.out}`);

// --- no URL ----------------------------------------------------------------
r = await run({ HEALTHCHECK_URL: "" });
ok("no url: exit 2 and says which config is missing", r.code === 2 && /FATAL no healthcheck URL/.test(r.out), `${r.code} :: ${r.out}`);

sink.close();
// The summary line SHAPE is what run-all parses (^ALL PASS|^FAILURES), so a checkmark must never appear
// on the failing branch -- and no assertion text above may start with those words.
console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES"} — ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""}`);
process.exitCode = fail === 0 ? 0 : 1;

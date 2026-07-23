// One-command test runner. Runs the pure suites always; runs the server-dependent suites only if a
// Bureau server is reachable (otherwise skips them with a note); runs the live model e2e only with --e2e.
//   node test/run-all.mjs            # pure + (server suites if a server is up)
//   node test/run-all.mjs --e2e      # also the live autonomy e2e (needs Latch + local model)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.BUREAU_PORT || 4174;
const wantE2E = process.argv.includes("--e2e");

const PURE = ["decision.test.mjs", "units.test.mjs", "net.test.mjs"];
const SERVER = ["api.test.mjs", "workspaces.test.mjs", "robustness.test.mjs"];
const LIVE = ["e2e-autonomy.mjs"];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const summary = (out.split("\n").reverse().find((l) => /passed|PASS|FAIL/.test(l)) || "").trim();
      resolve({ file, code, summary });
    });
  });
}

async function serverUp() {
  // Probe the static shell ("/"), which is intentionally NOT token-gated — /api/* would 401 and read
  // as "down" now that the API requires the operator token.
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`); return r.ok; } catch { return false; }
}

(async () => {
  const results = [];
  console.log("── pure unit suites ──");
  for (const f of PURE) { const r = await run(f); console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${f}  ${r.summary}`); results.push(r); }

  const up = await serverUp();
  console.log(`\n── server suites (${up ? `server up on :${PORT}` : "no server — skipped"}) ──`);
  if (up) { for (const f of SERVER) { const r = await run(f); console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${f}  ${r.summary}`); results.push(r); } }
  else console.log(`  skipped: ${SERVER.join(", ")}  (start with: BUREAU_PORT=${PORT} node server.mjs)`);

  console.log(`\n── live e2e ${wantE2E ? "" : "(skipped — pass --e2e to run; needs Latch + model)"} ──`);
  if (wantE2E) {
    if (up) { for (const f of LIVE) { const r = await run(f); console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${f}  ${r.summary}`); results.push(r); } }
    else console.log("  can't run --e2e: no server");
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n═══ ${failed.length ? failed.length + " SUITE(S) FAILED ✗" : "ALL SUITES PASS ✓"} — ran ${results.length} ═══`);
  process.exit(failed.length ? 1 : 0);
})();
